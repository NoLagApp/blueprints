import type {
  LobbyPresenceEvent,
  LobbyPresenceState,
  LobbyContext,
  ActorPresence,
  NoLagSocket,
} from '@nolag/js-sdk';
import { EventEmitter } from './EventEmitter';
import { DeviceGroup } from './DeviceGroup';
import { generateId, createLogger, registerWrapper, releaseWrapper } from './utils';
import {
  DEFAULT_APP_NAME,
  DEFAULT_MAX_TELEMETRY_POINTS,
  DEFAULT_COMMAND_TIMEOUT,
  LOBBY_ID,
  LOBBY_REFRESH_DELAY_MS,
} from './constants';
import type {
  NoLagIoTOptions,
  ResolvedIoTOptions,
  IoTClientEvents,
  Device,
  IoTPresenceData,
} from './types';

/**
 * NoLagIoT — high-level IoT telemetry and command dispatch SDK built on @nolag/js-sdk.
 *
 * Provides device presence, real-time telemetry streaming, and command dispatch
 * with ack tracking — all framework-agnostic via events.
 *
 * The wrapper NEVER manages the connection. The app owns one core NoLag
 * client (shared by any number of wrappers on distinct apps) and the
 * wrapper attaches to it at construction and releases it via `detach()`.
 *
 * @example
 * ```typescript
 * import { NoLag } from '@nolag/js-sdk';
 * import { NoLagIoT } from '@nolag/iot';
 *
 * const client = NoLag(async () => (await (await fetch('/api/nolag-token')).json()).token);
 * const iot = new NoLagIoT({ client, deviceId: 'sensor-01', role: 'device' });
 *
 * iot.on('connected', () => console.log('Connected!'));
 *
 * await client.connect();   // the app owns the connection
 * await iot.ready();        // wrapper setup done (identity, lobby, groups)
 *
 * const group = iot.joinGroup('factory-floor');
 * group.on('command', (cmd) => {
 *   group.ackCommand(cmd.id, 'completed', { ok: true });
 * });
 * group.sendTelemetry('temperature', 22.5, { unit: '°C' });
 *
 * iot.detach();             // wrapper releases its handlers and topics
 * client.disconnect();      // the app closes the socket
 * ```
 */
export class NoLagIoT extends EventEmitter<IoTClientEvents> {
  private _client: NoLagSocket;
  private _options: ResolvedIoTOptions;
  private _localDevice: Device | null = null;
  private _groups = new Map<string, DeviceGroup>();
  private _lobby: LobbyContext | null = null;
  private _onlineDevices = new Map<string, Device>();
  private _actorToDeviceId = new Map<string, string>();
  private _deviceId: string;
  private _log: (...args: unknown[]) => void;

  // Lifecycle: one setup run per connection epoch; detach is terminal.
  private _epoch = 0;
  private _detached = false;
  private _isReady = false;
  private _readyResolve!: () => void;
  private _readyReject!: (err: Error) => void;
  private _readyPromise: Promise<void>;
  private _lobbyRefreshTimer: ReturnType<typeof setTimeout> | null = null;

  // Stored client handler refs. INVARIANT: every client.on() below has a
  // matching client.off() in detach() — never bare off(event), never inline
  // closures on the client.
  private _onConnectRef = () => this._onConnect();
  private _onDisconnectRef = (reason: string) => {
    this._log('Disconnected:', reason);
    this.emit('disconnected', reason);
  };
  private _onReconnectRef = () => {
    this._log('Reconnecting...');
    this.emit('reconnecting');
  };
  private _onErrorRef = (error: Error) => {
    this._log('Error:', error);
    this.emit('error', error);
  };
  private _onPresenceJoinRef = (data: ActorPresence) => this._handleRoomPresenceJoin(data);
  private _onPresenceLeaveRef = (data: ActorPresence) => this._handleRoomPresenceLeave(data);
  private _onPresenceUpdateRef = (data: ActorPresence) => this._handleRoomPresenceUpdate(data);
  private _onLobbyJoinRef = (data: unknown) => this._handleLobbyJoin(data as LobbyPresenceEvent);
  private _onLobbyLeaveRef = (data: unknown) => this._handleLobbyLeave(data as LobbyPresenceEvent);
  private _onLobbyUpdateRef = (data: unknown) => this._handleLobbyUpdate(data as LobbyPresenceEvent);

  constructor(options: NoLagIoTOptions) {
    super();

    if (!options?.client) {
      throw new TypeError(
        'NoLagIoT requires an injected NoLag client: new NoLagIoT({ client, deviceId, ... })',
      );
    }

    this._client = options.client;
    this._deviceId = options.deviceId ?? generateId();

    this._options = {
      deviceId: this._deviceId,
      deviceName: options.deviceName,
      role: options.role ?? 'device',
      metadata: options.metadata,
      appName: options.appName ?? DEFAULT_APP_NAME,
      maxTelemetryPoints: options.maxTelemetryPoints ?? DEFAULT_MAX_TELEMETRY_POINTS,
      commandTimeout: options.commandTimeout ?? DEFAULT_COMMAND_TIMEOUT,
      debug: options.debug ?? false,
      groups: options.groups ?? [],
    };

    this._log = createLogger('NoLagIoT', this._options.debug);

    this._readyPromise = new Promise<void>((resolve, reject) => {
      this._readyResolve = resolve;
      this._readyReject = reject;
    });
    // ready() rejection is only meaningful to callers that await it
    this._readyPromise.catch(() => {});

    registerWrapper(this._client, this._options.appName, 'NoLagIoT');

    // Construction = attach: wire everything now, with stored refs.
    this._client.on('connect', this._onConnectRef);
    this._client.on('disconnect', this._onDisconnectRef);
    this._client.on('reconnect', this._onReconnectRef);
    this._client.on('error', this._onErrorRef);
    this._client.on('presence:join', this._onPresenceJoinRef);
    this._client.on('presence:leave', this._onPresenceLeaveRef);
    this._client.on('presence:update', this._onPresenceUpdateRef);
    this._client.on('lobbyPresence:join', this._onLobbyJoinRef);
    this._client.on('lobbyPresence:leave', this._onLobbyLeaveRef);
    this._client.on('lobbyPresence:update', this._onLobbyUpdateRef);

    // Attach-to-connected: if the client is already authenticated, run setup.
    // The microtask lets the caller wire wrapper event handlers synchronously
    // first; a racing real 'connect' event wins via the epoch guard.
    queueMicrotask(() => {
      if (this._epoch === 0 && !this._detached && this._client.connected) {
        this._onConnect();
      }
    });
  }

  // ============ Public Properties ============

  /** Whether the underlying connection is established (connected ≠ ready) */
  get connected(): boolean {
    return !this._detached && this._client.connected;
  }

  /** The injected core client (owned by the app, not the wrapper) */
  get client(): NoLagSocket {
    return this._client;
  }

  /** The local device info (available after ready) */
  get localDevice(): Device | null {
    return this._localDevice;
  }

  /** All currently joined groups */
  get groups(): Map<string, DeviceGroup> {
    return this._groups;
  }

  // ============ Lifecycle ============

  /**
   * Resolves once the wrapper's first setup completed (identity, lobby and
   * configured groups ready — equivalently, once 'connected' has fired).
   * Rejects only if detach() is called before that. Client auth failures
   * surface via the app's own `await client.connect()`, not here.
   */
  ready(): Promise<void> {
    return this._readyPromise;
  }

  /**
   * Detach from the client: remove every handler this wrapper added,
   * unsubscribe its topics and lobby (when connected), clear state. Also
   * clears any pending command-timeout timers on every group. Terminal and
   * idempotent; never touches the socket. To use IoT again, construct a new
   * instance.
   */
  detach(): void {
    if (this._detached) return;
    this._log('Detaching...');
    this._detached = true;
    this._epoch++; // aborts any in-flight setup at its next checkpoint

    if (this._lobbyRefreshTimer) {
      clearTimeout(this._lobbyRefreshTimer);
      this._lobbyRefreshTimer = null;
    }

    // Remove all client handlers by stored ref
    this._client.off('connect', this._onConnectRef);
    this._client.off('disconnect', this._onDisconnectRef);
    this._client.off('reconnect', this._onReconnectRef);
    this._client.off('error', this._onErrorRef);
    this._client.off('presence:join', this._onPresenceJoinRef);
    this._client.off('presence:leave', this._onPresenceLeaveRef);
    this._client.off('presence:update', this._onPresenceUpdateRef);
    this._client.off('lobbyPresence:join', this._onLobbyJoinRef);
    this._client.off('lobbyPresence:leave', this._onLobbyLeaveRef);
    this._client.off('lobbyPresence:update', this._onLobbyUpdateRef);

    // Groups: handler-specific off + connected-gated server unsubscribe.
    // _cleanup() also disposes each group's command-timeout timers.
    for (const name of [...this._groups.keys()]) {
      this._groups.get(name)!._cleanup();
      this._groups.delete(name);
    }

    // Lobby: server unsubscribe is best-effort and needs a live socket
    if (this._lobby && this._client.connected) {
      try {
        this._lobby.unsubscribe();
      } catch {
        /* best-effort */
      }
    }
    this._lobby = null;

    this._onlineDevices.clear();
    this._actorToDeviceId.clear();
    this._localDevice = null;

    releaseWrapper(this._client, this._options.appName);

    if (!this._isReady) {
      this._readyReject(new Error('NoLagIoT detached before ready'));
    }
  }

  // ============ Private: Epoch Setup ============

  private _onConnect(): void {
    this._epoch++;
    void this._runSetup(this._epoch);
  }

  /**
   * One setup pass per connection epoch. Serves both initial setup (epoch 1)
   * and reconnect restore (epoch > 1). Aborts silently whenever a newer
   * epoch started or the wrapper detached — checked after every await.
   */
  private async _runSetup(epoch: number): Promise<void> {
    const stale = () => epoch !== this._epoch || this._detached;
    this._log(this._isReady ? 'Restoring after reconnect...' : 'Setting up...');

    // Identity (client.actorId is guaranteed post-auth)
    if (!this._localDevice) {
      this._localDevice = {
        deviceId: this._deviceId,
        actorTokenId: this._client.actorId!,
        deviceName: this._options.deviceName,
        role: this._options.role,
        metadata: this._options.metadata,
        joinedAt: Date.now(),
        isLocal: true,
      };
      this._log('Local device:', this._localDevice.deviceId, '→', this._localDevice.actorTokenId);
    } else {
      this._localDevice.actorTokenId = this._client.actorId!;
    }

    // Lobby: subscribe every epoch (idempotent server-side) and diff-hydrate
    // from the returned snapshot — one path for setup and restore.
    if (!this._lobby) {
      this._lobby = this._client.setApp(this._options.appName).setLobby(LOBBY_ID);
    }
    try {
      const state = await this._lobby.subscribe();
      if (stale()) return;
      this._diffHydrateOnlineDevices(state);
      this._log('Lobby subscribed, online devices:', this._onlineDevices.size);
    } catch (err) {
      if (stale()) return;
      this._log('Lobby subscription failed:', err);
    }

    if (!this._isReady) {
      // First successful setup: pre-join configured groups.
      for (const groupName of this._options.groups) {
        const group = this._subscribeGroup(groupName);
        group._activate();
      }
    } else {
      // Server auto-restored topic subscriptions; only room-scoped presence
      // needs re-applying (the core does not restore it) — persistent-presence
      // semantics across reconnects.
      for (const group of this._groups.values()) {
        group._updateLocalPresence();
      }
    }

    if (stale()) return;

    // Ready keys on the first setup that COMPLETES, not on epoch 1: an
    // epoch aborted by a racing reconnect must not strand ready().
    if (!this._isReady) {
      this._isReady = true;
      this._readyResolve();
      this.emit('connected');
    } else {
      this.emit('reconnected');
    }

    // Deferred lobby refetch: catches devices who joined during the setup
    // window (e.g. simultaneous multi-tab connects).
    this._scheduleLobbyRefresh(epoch);
  }

  private _scheduleLobbyRefresh(epoch: number): void {
    if (this._lobbyRefreshTimer) clearTimeout(this._lobbyRefreshTimer);
    this._lobbyRefreshTimer = setTimeout(() => {
      this._lobbyRefreshTimer = null;
      if (epoch !== this._epoch || this._detached || !this._client.connected || !this._lobby) {
        return;
      }
      this._lobby
        .fetchPresence()
        .then((state) => {
          if (epoch !== this._epoch || this._detached) return;
          this._diffHydrateOnlineDevices(state);
        })
        .catch(() => {
          /* best-effort */
        });
    }, LOBBY_REFRESH_DELAY_MS);
  }

  // ============ Group Management ============

  /**
   * Join a device group. Creates, subscribes, and activates it.
   * Returns an existing group if already joined.
   */
  joinGroup(name: string): DeviceGroup {
    this._assertUsable();

    let group = this._groups.get(name);
    if (!group) {
      group = this._subscribeGroup(name);
      group._activate();
    }

    return group;
  }

  /**
   * Leave a device group. Fully unsubscribes and removes it.
   */
  leaveGroup(name: string): void {
    const group = this._groups.get(name);
    if (!group) return;

    this._log('Leaving group:', name);
    group._cleanup();
    this._groups.delete(name);
  }

  /**
   * Get all joined groups.
   */
  getGroups(): DeviceGroup[] {
    return Array.from(this._groups.values());
  }

  // ============ Global Presence ============

  /**
   * Get all devices currently online across all groups.
   */
  getOnlineDevices(): Device[] {
    return Array.from(this._onlineDevices.values());
  }

  // ============ Private: Guards ============

  private _assertUsable(): void {
    if (this._detached) {
      throw new Error('NoLagIoT has been detached — construct a new instance');
    }
    if (!this._isReady || !this._localDevice) {
      throw new Error('NoLagIoT not ready — await ready() or the "connected" event');
    }
  }

  // ============ Private: Group Setup ============

  private _subscribeGroup(name: string): DeviceGroup {
    this._log('Subscribing group:', name);

    const roomContext = this._client.setApp(this._options.appName).setRoom(name);
    const group = new DeviceGroup(
      name,
      roomContext,
      this._localDevice!,
      this._options,
      createLogger(`DeviceGroup:${name}`, this._options.debug),
      () => this._client.connected,
    );

    this._groups.set(name, group);
    group._subscribe();

    return group;
  }

  // ============ Private: Scope Filtering ============

  /**
   * On a shared client, presence events from other apps' wrappers arrive on
   * the same connection-level events. Wrappers stamp their presence with a
   * `__scope` (their appName); a mismatched tag means another app's data.
   * Untagged presence is accepted (older peers in this same app).
   */
  private _foreignScope(data: IoTPresenceData | undefined): boolean {
    const scope = (data as Record<string, unknown> | undefined)?.__scope;
    return typeof scope === 'string' && scope !== this._options.appName;
  }

  // ============ Private: Room Presence ============

  private _handleRoomPresenceJoin(data: ActorPresence): void {
    if (data.actorTokenId === this._localDevice?.actorTokenId) return;
    const presenceData = data.presence as unknown as IoTPresenceData;
    if (!presenceData?.deviceId || this._foreignScope(presenceData)) return;

    const device = this._presenceToDevice(data.actorTokenId, presenceData);
    this._actorToDeviceId.set(data.actorTokenId, device.deviceId);
    if (!this._onlineDevices.has(device.deviceId)) {
      this._onlineDevices.set(device.deviceId, device);
      this.emit('deviceOnline', device);
    }

    // Route to all groups
    for (const group of this._groups.values()) {
      group._handlePresenceJoin(data.actorTokenId, presenceData);
    }
  }

  private _handleRoomPresenceLeave(data: ActorPresence): void {
    if (data.actorTokenId === this._localDevice?.actorTokenId) return;

    // Route to all groups
    for (const group of this._groups.values()) {
      group._handlePresenceLeave(data.actorTokenId);
    }
  }

  private _handleRoomPresenceUpdate(data: ActorPresence): void {
    if (data.actorTokenId === this._localDevice?.actorTokenId) return;
    const presenceData = data.presence as unknown as IoTPresenceData;
    if (!presenceData?.deviceId || this._foreignScope(presenceData)) return;

    if (this._onlineDevices.has(presenceData.deviceId)) {
      const device = this._presenceToDevice(data.actorTokenId, presenceData);
      this._onlineDevices.set(device.deviceId, device);
    }

    // Route to all groups
    for (const group of this._groups.values()) {
      group._handlePresenceUpdate(data.actorTokenId, presenceData);
    }
  }

  // ============ Private: Lobby ============

  private _handleLobbyJoin(event: LobbyPresenceEvent): void {
    const { actorId, data } = event;
    if (actorId === this._localDevice?.actorTokenId) return;

    const presenceData = data as unknown as IoTPresenceData;
    if (!presenceData?.deviceId || this._foreignScope(presenceData)) return;

    const device = this._presenceToDevice(actorId, presenceData);
    this._actorToDeviceId.set(actorId, device.deviceId);
    if (!this._onlineDevices.has(device.deviceId)) {
      this._onlineDevices.set(device.deviceId, device);
      this.emit('deviceOnline', device);
    }
  }

  private _handleLobbyLeave(event: LobbyPresenceEvent): void {
    const { actorId, data } = event;
    if (actorId === this._localDevice?.actorTokenId) return;

    const presenceData = data as unknown as IoTPresenceData;
    if (this._foreignScope(presenceData)) return;
    const deviceId = presenceData?.deviceId
      || this._actorToDeviceId.get(actorId)
      || this._findDeviceIdByActorId(actorId);

    if (deviceId) {
      const device = this._onlineDevices.get(deviceId);
      if (device) {
        this._onlineDevices.delete(deviceId);
        this._actorToDeviceId.delete(actorId);
        this.emit('deviceOffline', device);
      }
    }
  }

  private _handleLobbyUpdate(event: LobbyPresenceEvent): void {
    const { actorId, data } = event;
    if (actorId === this._localDevice?.actorTokenId) return;

    const presenceData = data as unknown as IoTPresenceData;
    if (!presenceData?.deviceId || this._foreignScope(presenceData)) return;

    const device = this._presenceToDevice(actorId, presenceData);
    this._onlineDevices.set(device.deviceId, device);
  }

  /**
   * Reconcile the online-device map against a fresh lobby snapshot, emitting
   * only the deltas (deviceOffline for vanished, deviceOnline for new). One
   * path for initial hydration, reconnect restore, and the deferred refetch.
   */
  private _diffHydrateOnlineDevices(state: LobbyPresenceState): void {
    // Build the fresh device set from the snapshot
    const fresh = new Map<string, Device>();
    const freshActors = new Map<string, string>();

    for (const roomId of Object.keys(state)) {
      const roomPresence = state[roomId];
      for (const actorId of Object.keys(roomPresence)) {
        if (actorId === this._localDevice?.actorTokenId) continue;

        const raw = roomPresence[actorId] as Record<string, unknown>;
        // Server returns full actor records with presence nested under .presence
        const presenceData = (raw?.presence ?? raw) as unknown as IoTPresenceData;
        if (presenceData?.deviceId && !this._foreignScope(presenceData)) {
          if (!fresh.has(presenceData.deviceId)) {
            fresh.set(presenceData.deviceId, this._presenceToDevice(actorId, presenceData));
          }
          freshActors.set(actorId, presenceData.deviceId);
        }
      }
    }

    // Vanished devices
    for (const [deviceId, device] of [...this._onlineDevices]) {
      if (!fresh.has(deviceId)) {
        this._onlineDevices.delete(deviceId);
        for (const [actorId, mappedDeviceId] of [...this._actorToDeviceId]) {
          if (mappedDeviceId === deviceId) this._actorToDeviceId.delete(actorId);
        }
        this.emit('deviceOffline', device);
      }
    }

    // New devices
    for (const [deviceId, device] of fresh) {
      if (!this._onlineDevices.has(deviceId)) {
        this._onlineDevices.set(deviceId, device);
        this.emit('deviceOnline', device);
      }
    }
    for (const [actorId, deviceId] of freshActors) {
      this._actorToDeviceId.set(actorId, deviceId);
    }
  }

  // ============ Private: Helpers ============

  private _presenceToDevice(actorTokenId: string, data: IoTPresenceData): Device {
    return {
      deviceId: data.deviceId,
      actorTokenId,
      deviceName: data.deviceName,
      role: data.role,
      metadata: data.metadata,
      joinedAt: Date.now(),
      isLocal: false,
    };
  }

  private _findDeviceIdByActorId(actorTokenId: string): string | undefined {
    for (const device of this._onlineDevices.values()) {
      if (device.actorTokenId === actorTokenId) return device.deviceId;
    }
    return undefined;
  }
}
