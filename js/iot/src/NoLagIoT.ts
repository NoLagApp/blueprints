import type {
  NoLagOptions,
  LobbyPresenceEvent,
  LobbyPresenceState,
  LobbyContext,
  ActorPresence,
} from '@nolag/js-sdk';
import { NoLag } from '@nolag/js-sdk';
import { EventEmitter } from './EventEmitter';
import { DeviceGroup } from './DeviceGroup';
import { generateId, createLogger } from './utils';
import {
  DEFAULT_APP_NAME,
  DEFAULT_MAX_TELEMETRY_POINTS,
  DEFAULT_COMMAND_TIMEOUT,
  LOBBY_ID,
} from './constants';
import type {
  NoLagIoTOptions,
  ResolvedIoTOptions,
  IoTClientEvents,
  Device,
  IoTPresenceData,
} from './types';

// The NoLag factory returns a client instance. We type it loosely
// because the actual class isn't exported (only the factory is).
type NoLagClient = ReturnType<typeof NoLag>;

/**
 * NoLagIoT — high-level IoT telemetry and command dispatch SDK built on @nolag/js-sdk.
 *
 * Provides device presence, real-time telemetry streaming, and command dispatch
 * with ack tracking — all framework-agnostic via events.
 *
 * @example
 * ```typescript
 * import { NoLagIoT } from '@nolag/iot';
 *
 * const iot = new NoLagIoT(token, { deviceId: 'sensor-01', role: 'device', debug: true });
 *
 * iot.on('connected', () => console.log('Connected!'));
 * await iot.connect();
 *
 * const group = iot.joinGroup('factory-floor');
 * group.on('command', (cmd) => {
 *   console.log('Received command:', cmd.command);
 *   group.ackCommand(cmd.id, 'completed', { ok: true });
 * });
 *
 * // Send telemetry every second
 * setInterval(() => {
 *   group.sendTelemetry('temperature', 22.5, { unit: '°C' });
 * }, 1000);
 * ```
 */
export class NoLagIoT extends EventEmitter<IoTClientEvents> {
  private _token: string;
  private _options: ResolvedIoTOptions;
  private _client: NoLagClient | null = null;
  private _localDevice: Device | null = null;
  private _groups = new Map<string, DeviceGroup>();
  private _lobby: LobbyContext | null = null;
  private _onlineDevices = new Map<string, Device>();
  private _actorToDeviceId = new Map<string, string>();
  private _deviceId: string;
  private _log: (...args: unknown[]) => void;

  constructor(token: string, options: NoLagIoTOptions = {}) {
    super();
    this._token = token;
    this._deviceId = options.deviceId ?? generateId();

    this._options = {
      deviceId: this._deviceId,
      deviceName: options.deviceName,
      role: options.role ?? 'device',
      metadata: options.metadata,
      appName: options.appName ?? DEFAULT_APP_NAME,
      url: options.url,
      maxTelemetryPoints: options.maxTelemetryPoints ?? DEFAULT_MAX_TELEMETRY_POINTS,
      commandTimeout: options.commandTimeout ?? DEFAULT_COMMAND_TIMEOUT,
      debug: options.debug ?? false,
      reconnect: options.reconnect ?? true,
      groups: options.groups ?? [],
    };

    this._log = createLogger('NoLagIoT', this._options.debug);
  }

  // ============ Public Properties ============

  /** Whether the underlying connection is established */
  get connected(): boolean {
    return this._client?.connected ?? false;
  }

  /** The local device info (available after connect) */
  get localDevice(): Device | null {
    return this._localDevice;
  }

  /** All currently joined groups */
  get groups(): Map<string, DeviceGroup> {
    return this._groups;
  }

  // ============ Lifecycle ============

  /**
   * Connect to NoLag and set up global presence.
   */
  async connect(): Promise<void> {
    this._log('Connecting...');

    const clientOptions: NoLagOptions = {
      debug: this._options.debug,
      reconnect: this._options.reconnect,
    };
    if (this._options.url) {
      clientOptions.url = this._options.url;
    }

    this._client = NoLag(this._token, clientOptions);

    // Wire client lifecycle events
    this._client.on('connect', () => {
      this._log('Connected');
      if (this._groups.size > 0) {
        this._log('Reconnected — restoring groups...');
        this._restoreGroups();
        this.emit('reconnected');
      }
    });

    this._client.on('disconnect', (reason: string) => {
      this._log('Disconnected:', reason);
      this.emit('disconnected', reason);
    });

    this._client.on('reconnect', () => {
      this._log('Reconnecting...');
    });

    this._client.on('error', (error: Error) => {
      this._log('Error:', error);
      this.emit('error', error);
    });

    // Connect
    await this._client.connect();

    // Wire room-level presence events
    this._client.on('presence:join', (data: ActorPresence) => {
      this._handleRoomPresenceJoin(data);
    });
    this._client.on('presence:leave', (data: ActorPresence) => {
      this._handleRoomPresenceLeave(data);
    });
    this._client.on('presence:update', (data: ActorPresence) => {
      this._handleRoomPresenceUpdate(data);
    });

    // Create local device record
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

    // Set up lobby for global presence
    await this._setupLobby();

    // Emit connected now that _localDevice and lobby are ready
    this.emit('connected');

    // Auto-join configured groups
    for (const groupName of this._options.groups) {
      this.joinGroup(groupName);
    }

    // Deferred lobby refetch to catch devices that joined during setup window
    setTimeout(() => {
      if (this._lobby && this._client?.connected) {
        this._lobby.fetchPresence().then((state) => {
          this._hydrateOnlineDevices(state);
        }).catch(() => { /* ignore — best-effort */ });
      }
    }, 2000);
  }

  /**
   * Disconnect from NoLag and clean up all groups.
   */
  disconnect(): void {
    this._log('Disconnecting...');

    // Clean up groups
    for (const name of [...this._groups.keys()]) {
      this.leaveGroup(name);
    }

    // Unsubscribe from lobby
    this._lobby?.unsubscribe();
    this._lobby = null;

    // Disconnect client
    this._client?.disconnect();
    this._client = null;

    // Clear state
    this._onlineDevices.clear();
    this._actorToDeviceId.clear();
    this._localDevice = null;
  }

  // ============ Group Management ============

  /**
   * Join a device group. Creates, subscribes, and activates it.
   * Returns an existing group if already joined.
   */
  joinGroup(name: string): DeviceGroup {
    if (!this._client || !this._localDevice) {
      throw new Error('Not connected — call connect() first');
    }

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

  // ============ Private: Group Setup ============

  private _subscribeGroup(name: string): DeviceGroup {
    if (!this._client || !this._localDevice) {
      throw new Error('Not connected — call connect() first');
    }

    this._log('Subscribing group:', name);

    const roomContext = this._client.setApp(this._options.appName).setRoom(name);
    const group = new DeviceGroup(
      name,
      roomContext,
      this._localDevice,
      this._options,
      createLogger(`DeviceGroup:${name}`, this._options.debug),
    );

    this._groups.set(name, group);
    group._subscribe();

    return group;
  }

  // ============ Private: Room Presence ============

  private _handleRoomPresenceJoin(data: ActorPresence): void {
    if (data.actorTokenId === this._localDevice?.actorTokenId) return;
    const presenceData = data.presence as unknown as IoTPresenceData;
    if (!presenceData?.deviceId) return;

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
    if (!presenceData?.deviceId) return;

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

  private async _setupLobby(): Promise<void> {
    if (!this._client) return;

    this._lobby = this._client.setApp(this._options.appName).setLobby(LOBBY_ID);

    const lobbyHandler = (type: 'join' | 'leave' | 'update') =>
      (data: unknown) => {
        const event = data as LobbyPresenceEvent;
        if (type === 'join') this._handleLobbyJoin(event);
        else if (type === 'leave') this._handleLobbyLeave(event);
        else this._handleLobbyUpdate(event);
      };

    this._client.on('lobbyPresence:join', lobbyHandler('join'));
    this._client.on('lobbyPresence:leave', lobbyHandler('leave'));
    this._client.on('lobbyPresence:update', lobbyHandler('update'));

    try {
      const initialState = await this._lobby.subscribe();
      this._hydrateOnlineDevices(initialState);
      this._log('Lobby subscribed, online devices:', this._onlineDevices.size);
    } catch (err) {
      this._log('Lobby subscription failed:', err);
    }
  }

  private _handleLobbyJoin(event: LobbyPresenceEvent): void {
    const { actorId, data } = event;
    if (actorId === this._localDevice?.actorTokenId) return;

    const presenceData = data as unknown as IoTPresenceData;
    if (!presenceData.deviceId) return;

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
    if (!presenceData.deviceId) return;

    const device = this._presenceToDevice(actorId, presenceData);
    this._onlineDevices.set(device.deviceId, device);
  }

  private _hydrateOnlineDevices(state: LobbyPresenceState): void {
    for (const roomId of Object.keys(state)) {
      const roomPresence = state[roomId];
      for (const actorId of Object.keys(roomPresence)) {
        if (actorId === this._localDevice?.actorTokenId) continue;

        const raw = roomPresence[actorId] as Record<string, unknown>;
        const presenceData = (raw?.presence ?? raw) as unknown as IoTPresenceData;
        if (presenceData?.deviceId) {
          const device = this._presenceToDevice(actorId, presenceData);
          this._actorToDeviceId.set(actorId, device.deviceId);
          if (!this._onlineDevices.has(device.deviceId)) {
            this._onlineDevices.set(device.deviceId, device);
            this.emit('deviceOnline', device);
          }
        }
      }
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

  private _restoreGroups(): void {
    // On reconnect, js-sdk auto-restores subscriptions.
    // Re-set presence on all active groups.
    for (const group of this._groups.values()) {
      group._updateLocalPresence();
    }

    // Re-fetch lobby presence
    this._lobby?.fetchPresence().then((state) => {
      this._onlineDevices.clear();
      this._actorToDeviceId.clear();
      this._hydrateOnlineDevices(state);
    }).catch((err) => {
      this._log('Failed to re-fetch lobby presence:', err);
    });
  }
}
