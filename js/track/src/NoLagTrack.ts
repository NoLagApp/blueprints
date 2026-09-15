import type {
  LobbyPresenceEvent,
  LobbyPresenceState,
  LobbyContext,
  ActorPresence,
  NoLagSocket,
} from '@nolag/js-sdk';
import { EventEmitter } from './EventEmitter';
import { TrackingZone } from './TrackingZone';
import { generateId, createLogger, registerWrapper, releaseWrapper } from './utils';
import {
  DEFAULT_APP_NAME,
  DEFAULT_MAX_LOCATION_HISTORY,
  LOBBY_ID,
  LOBBY_REFRESH_DELAY_MS,
} from './constants';
import type {
  NoLagTrackOptions,
  ResolvedTrackOptions,
  TrackClientEvents,
  TrackedAsset,
  TrackPresenceData,
  FilterValue,
  JoinZoneOptions,
} from './types';

/**
 * NoLagTrack — high-level vehicle/asset GPS tracking SDK built on @nolag/js-sdk.
 *
 * Provides real-time location publishing and subscription, client-side geofencing,
 * and global online presence — all framework-agnostic via events.
 *
 * The wrapper NEVER manages the connection. The app owns one core NoLag
 * client (shared by any number of wrappers on distinct apps) and the
 * wrapper attaches to it at construction and releases it via `detach()`.
 *
 * @example
 * ```typescript
 * import { NoLag } from '@nolag/js-sdk';
 * import { NoLagTrack } from '@nolag/track';
 *
 * const client = NoLag(async () => (await (await fetch('/api/nolag-token')).json()).token);
 * const track = new NoLagTrack({ client, assetName: 'Truck-01' });
 *
 * track.on('assetOnline', (asset) => console.log(asset.assetId, 'is online'));
 *
 * await client.connect();   // the app owns the connection
 * await track.ready();      // wrapper setup done (identity, lobby, zones)
 *
 * const zone = track.joinZone('fleet-zone');
 * zone.on('locationUpdate', (update) => console.log(update.assetId, update.point));
 * zone.sendLocation({ lat: 51.5074, lng: -0.1278 });
 *
 * track.detach();           // wrapper releases its handlers and topics
 * client.disconnect();      // the app closes the socket
 * ```
 */
export class NoLagTrack extends EventEmitter<TrackClientEvents> {
  private _client: NoLagSocket;
  private _options: ResolvedTrackOptions;
  private _localAsset: TrackedAsset | null = null;
  private _zones = new Map<string, TrackingZone>();
  private _lobby: LobbyContext | null = null;
  private _onlineAssets = new Map<string, TrackedAsset>();
  private _actorToAssetId = new Map<string, string>();
  private _assetId: string;
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

  constructor(options: NoLagTrackOptions) {
    super();

    if (!options?.client) {
      throw new TypeError(
        'NoLagTrack requires an injected NoLag client: new NoLagTrack({ client, assetName, ... })',
      );
    }

    this._client = options.client;
    this._assetId = options.assetId ?? generateId();

    this._options = {
      assetId: this._assetId,
      assetName: options.assetName,
      metadata: options.metadata,
      appName: options.appName ?? DEFAULT_APP_NAME,
      maxLocationHistory: options.maxLocationHistory ?? DEFAULT_MAX_LOCATION_HISTORY,
      debug: options.debug ?? false,
      zoneNames: options.zoneNames ?? [],
      zones: options.zones ?? [],
    };

    this._log = createLogger('NoLagTrack', this._options.debug);

    this._readyPromise = new Promise<void>((resolve, reject) => {
      this._readyResolve = resolve;
      this._readyReject = reject;
    });
    // ready() rejection is only meaningful to callers that await it
    this._readyPromise.catch(() => {});

    registerWrapper(this._client, this._options.appName, 'NoLagTrack');

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

  /** The local asset's info (available after ready) */
  get localAsset(): TrackedAsset | null {
    return this._localAsset;
  }

  /** All currently joined zones */
  get zones(): Map<string, TrackingZone> {
    return this._zones;
  }

  // ============ Lifecycle ============

  /**
   * Resolves once the wrapper's first setup completed (identity, lobby and
   * configured zones ready — equivalently, once 'connected' has fired).
   * Rejects only if detach() is called before that. Client auth failures
   * surface via the app's own `await client.connect()`, not here.
   */
  ready(): Promise<void> {
    return this._readyPromise;
  }

  /**
   * Detach from the client: remove every handler this wrapper added,
   * unsubscribe its topics and lobby (when connected), clear state.
   * Terminal and idempotent; never touches the socket. To use tracking
   * again, construct a new instance.
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

    // Zones: handler-specific off + connected-gated server unsubscribe
    for (const name of [...this._zones.keys()]) {
      this._zones.get(name)!._cleanup();
      this._zones.delete(name);
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

    this._onlineAssets.clear();
    this._actorToAssetId.clear();
    this._localAsset = null;

    releaseWrapper(this._client, this._options.appName);

    if (!this._isReady) {
      this._readyReject(new Error('NoLagTrack detached before ready'));
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
    if (!this._localAsset) {
      this._localAsset = {
        assetId: this._assetId,
        actorTokenId: this._client.actorId!,
        assetName: this._options.assetName,
        metadata: this._options.metadata,
        joinedAt: Date.now(),
        isLocal: true,
      };
      this._log('Local asset:', this._localAsset.assetId, '→', this._localAsset.actorTokenId);
    } else {
      this._localAsset.actorTokenId = this._client.actorId!;
    }

    // Lobby: subscribe every epoch (idempotent server-side) and diff-hydrate
    // from the returned snapshot — one path for setup and restore.
    if (!this._lobby) {
      this._lobby = this._client.setApp(this._options.appName).setLobby(LOBBY_ID);
    }
    try {
      const state = await this._lobby.subscribe();
      if (stale()) return;
      this._diffHydrateOnlineAssets(state);
      this._log('Lobby subscribed, online assets:', this._onlineAssets.size);
    } catch (err) {
      if (stale()) return;
      this._log('Lobby subscription failed:', err);
    }

    if (!this._isReady) {
      // First successful setup: join configured zones (subscribe topics and
      // set zone-scoped presence).
      for (const zoneName of this._options.zoneNames) {
        this._subscribeZoneInternal(zoneName)._activate();
      }
    } else {
      // Reconnect: the server auto-restored topic subscriptions. Re-apply the
      // asset's zone-scoped presence on every joined zone (persistent presence
      // — the core does not restore presence).
      for (const zone of this._zones.values()) {
        zone._updateLocalPresence();
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

    // Deferred lobby refetch: catches assets who joined during the setup
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
          this._diffHydrateOnlineAssets(state);
        })
        .catch(() => {
          /* best-effort */
        });
    }, LOBBY_REFRESH_DELAY_MS);
  }

  // ============ Zone Management ============

  /**
   * Join a tracking zone. Creates, subscribes, and activates it.
   * Returns an existing zone if already joined.
   */
  joinZone(name: string, opts?: JoinZoneOptions): TrackingZone {
    this._assertUsable();

    let zone = this._zones.get(name);
    if (!zone) {
      zone = this._subscribeZoneInternal(name, opts?.filters);
      zone._activate();
    }

    return zone;
  }

  /**
   * Leave a tracking zone. Fully unsubscribes and removes it.
   */
  leaveZone(name: string): void {
    const zone = this._zones.get(name);
    if (!zone) return;

    this._log('Leaving zone:', name);
    zone._cleanup();
    this._zones.delete(name);
  }

  /**
   * Get all joined zones.
   */
  getZones(): TrackingZone[] {
    return Array.from(this._zones.values());
  }

  // ============ Global Presence ============

  /**
   * Get all assets currently online across all zones.
   */
  getOnlineAssets(): TrackedAsset[] {
    return Array.from(this._onlineAssets.values());
  }

  // ============ Private: Guards ============

  private _assertUsable(): void {
    if (this._detached) {
      throw new Error('NoLagTrack has been detached — construct a new instance');
    }
    if (!this._isReady || !this._localAsset) {
      throw new Error('NoLagTrack not ready — await ready() or the "connected" event');
    }
  }

  // ============ Private: Zone Setup ============

  private _subscribeZoneInternal(name: string, filters?: FilterValue[]): TrackingZone {
    this._log('Subscribing zone:', name);

    const roomContext = this._client.setApp(this._options.appName).setRoom(name);
    const zone = new TrackingZone(
      name,
      roomContext,
      this._localAsset!,
      this._options,
      createLogger(`TrackingZone:${name}`, this._options.debug),
      () => this._client.connected,
    );

    this._zones.set(name, zone);
    zone._subscribe(filters);

    return zone;
  }

  // ============ Private: Scope Filtering ============

  /**
   * On a shared client, presence events from other apps' wrappers arrive on
   * the same connection-level events. Wrappers stamp their presence with a
   * `__scope` (their appName); a mismatched tag means another app's data.
   * Untagged presence is accepted (older peers in this same app).
   */
  private _foreignScope(data: TrackPresenceData | undefined): boolean {
    const scope = (data as Record<string, unknown> | undefined)?.__scope;
    return typeof scope === 'string' && scope !== this._options.appName;
  }

  // ============ Private: Room Presence → All Zones ============

  private _handleRoomPresenceJoin(data: ActorPresence): void {
    if (data.actorTokenId === this._localAsset?.actorTokenId) return;
    const presenceData = data.presence as unknown as TrackPresenceData;
    if (!presenceData?.assetId || this._foreignScope(presenceData)) return;

    const asset = this._presenceToAsset(data.actorTokenId, presenceData);
    this._actorToAssetId.set(data.actorTokenId, asset.assetId);
    if (!this._onlineAssets.has(asset.assetId)) {
      this._onlineAssets.set(asset.assetId, asset);
      this.emit('assetOnline', asset);
    }

    // Route to all zones (multi-zone — presence is not tied to one active zone)
    for (const zone of this._zones.values()) {
      zone._handlePresenceJoin(data.actorTokenId, presenceData);
    }
  }

  private _handleRoomPresenceLeave(data: ActorPresence): void {
    if (data.actorTokenId === this._localAsset?.actorTokenId) return;

    // Route to all zones
    for (const zone of this._zones.values()) {
      zone._handlePresenceLeave(data.actorTokenId);
    }
  }

  private _handleRoomPresenceUpdate(data: ActorPresence): void {
    if (data.actorTokenId === this._localAsset?.actorTokenId) return;
    const presenceData = data.presence as unknown as TrackPresenceData;
    if (!presenceData?.assetId || this._foreignScope(presenceData)) return;

    if (this._onlineAssets.has(presenceData.assetId)) {
      const asset = this._presenceToAsset(data.actorTokenId, presenceData);
      this._onlineAssets.set(asset.assetId, asset);
    }

    // Route to all zones
    for (const zone of this._zones.values()) {
      zone._handlePresenceUpdate(data.actorTokenId, presenceData);
    }
  }

  // ============ Private: Lobby ============

  private _handleLobbyJoin(event: LobbyPresenceEvent): void {
    const { actorId, data } = event;
    if (actorId === this._localAsset?.actorTokenId) return;

    const presenceData = data as unknown as TrackPresenceData;
    if (!presenceData.assetId || this._foreignScope(presenceData)) return;

    const asset = this._presenceToAsset(actorId, presenceData);
    this._actorToAssetId.set(actorId, asset.assetId);
    if (!this._onlineAssets.has(asset.assetId)) {
      this._onlineAssets.set(asset.assetId, asset);
      this.emit('assetOnline', asset);
    }
  }

  private _handleLobbyLeave(event: LobbyPresenceEvent): void {
    const { actorId, data } = event;
    if (actorId === this._localAsset?.actorTokenId) return;

    const presenceData = data as unknown as TrackPresenceData;
    if (this._foreignScope(presenceData)) return;
    const assetId = presenceData?.assetId
      || this._actorToAssetId.get(actorId)
      || this._findAssetIdByActorId(actorId);

    if (assetId) {
      const asset = this._onlineAssets.get(assetId);
      if (asset) {
        this._onlineAssets.delete(assetId);
        this._actorToAssetId.delete(actorId);
        this.emit('assetOffline', asset);
      }
    }
  }

  private _handleLobbyUpdate(event: LobbyPresenceEvent): void {
    const { actorId, data } = event;
    if (actorId === this._localAsset?.actorTokenId) return;

    const presenceData = data as unknown as TrackPresenceData;
    if (!presenceData.assetId || this._foreignScope(presenceData)) return;

    const asset = this._presenceToAsset(actorId, presenceData);
    this._onlineAssets.set(asset.assetId, asset);
  }

  /**
   * Reconcile the online-asset map against a fresh lobby snapshot, emitting
   * only the deltas (assetOffline for vanished, assetOnline for new). One path
   * for initial hydration, reconnect restore, and the deferred refetch.
   */
  private _diffHydrateOnlineAssets(state: LobbyPresenceState): void {
    // Build the fresh asset set from the snapshot
    const fresh = new Map<string, TrackedAsset>();
    const freshActors = new Map<string, string>();

    for (const roomId of Object.keys(state)) {
      const roomPresence = state[roomId];
      for (const actorId of Object.keys(roomPresence)) {
        if (actorId === this._localAsset?.actorTokenId) continue;

        const raw = roomPresence[actorId] as Record<string, unknown>;
        // Server returns full actor records with presence nested under .presence
        const presenceData = (raw?.presence ?? raw) as unknown as TrackPresenceData;
        if (presenceData?.assetId && !this._foreignScope(presenceData)) {
          if (!fresh.has(presenceData.assetId)) {
            fresh.set(presenceData.assetId, this._presenceToAsset(actorId, presenceData));
          }
          freshActors.set(actorId, presenceData.assetId);
        }
      }
    }

    // Vanished assets
    for (const [assetId, asset] of [...this._onlineAssets]) {
      if (!fresh.has(assetId)) {
        this._onlineAssets.delete(assetId);
        for (const [actorId, mappedAssetId] of [...this._actorToAssetId]) {
          if (mappedAssetId === assetId) this._actorToAssetId.delete(actorId);
        }
        this.emit('assetOffline', asset);
      }
    }

    // New assets
    for (const [assetId, asset] of fresh) {
      if (!this._onlineAssets.has(assetId)) {
        this._onlineAssets.set(assetId, asset);
        this.emit('assetOnline', asset);
      }
    }
    for (const [actorId, assetId] of freshActors) {
      this._actorToAssetId.set(actorId, assetId);
    }
  }

  // ============ Private: Helpers ============

  private _presenceToAsset(actorTokenId: string, data: TrackPresenceData): TrackedAsset {
    return {
      assetId: data.assetId,
      actorTokenId,
      assetName: data.assetName,
      metadata: data.metadata,
      joinedAt: Date.now(),
      isLocal: false,
    };
  }

  private _findAssetIdByActorId(actorTokenId: string): string | undefined {
    for (const asset of this._onlineAssets.values()) {
      if (asset.actorTokenId === actorTokenId) return asset.assetId;
    }
    return undefined;
  }
}
