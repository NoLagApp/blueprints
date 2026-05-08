import type {
  NoLagOptions,
  LobbyPresenceEvent,
  LobbyPresenceState,
  LobbyContext,
  ActorPresence,
} from '@nolag/js-sdk';
import { NoLag } from '@nolag/js-sdk';
import { EventEmitter } from './EventEmitter';
import { TrackingZone } from './TrackingZone';
import { generateId, createLogger } from './utils';
import { DEFAULT_APP_NAME, DEFAULT_MAX_LOCATION_HISTORY, LOBBY_ID } from './constants';
import type {
  NoLagTrackOptions,
  ResolvedTrackOptions,
  TrackClientEvents,
  TrackedAsset,
  TrackPresenceData,
} from './types';

// The NoLag factory returns a client instance. We type it loosely
// because the actual class isn't exported (only the factory is).
type NoLagClient = ReturnType<typeof NoLag>;

/**
 * NoLagTrack — high-level vehicle/asset GPS tracking SDK built on @nolag/js-sdk.
 *
 * Provides real-time location publishing and subscription, client-side geofencing,
 * and global online presence — all framework-agnostic via events.
 *
 * @example
 * ```typescript
 * import { NoLagTrack } from '@nolag/track';
 *
 * const track = new NoLagTrack(token, { assetName: 'Truck-01', debug: true });
 *
 * track.on('connected', () => console.log('Connected!'));
 * track.on('assetOnline', (asset) => console.log(asset.assetId, 'is online'));
 *
 * await track.connect();
 *
 * const zone = track.joinZone('fleet-zone');
 * zone.on('locationUpdate', (update) => console.log(update.assetId, update.point));
 *
 * zone.sendLocation({ lat: 51.5074, lng: -0.1278 });
 * ```
 */
export class NoLagTrack extends EventEmitter<TrackClientEvents> {
  private _token: string;
  private _options: ResolvedTrackOptions;
  private _client: NoLagClient | null = null;
  private _localAsset: TrackedAsset | null = null;
  private _zones = new Map<string, TrackingZone>();
  private _lobby: LobbyContext | null = null;
  private _onlineAssets = new Map<string, TrackedAsset>();
  private _actorToAssetId = new Map<string, string>();
  private _assetId: string;
  private _log: (...args: unknown[]) => void;

  constructor(token: string, options: NoLagTrackOptions = {}) {
    super();
    this._token = token;
    this._assetId = options.assetId ?? generateId();

    this._options = {
      assetId: this._assetId,
      assetName: options.assetName,
      metadata: options.metadata,
      appName: options.appName ?? DEFAULT_APP_NAME,
      url: options.url,
      maxLocationHistory: options.maxLocationHistory ?? DEFAULT_MAX_LOCATION_HISTORY,
      debug: options.debug ?? false,
      reconnect: options.reconnect ?? true,
      zones: options.zones ?? [],
    };

    this._log = createLogger('NoLagTrack', this._options.debug);
  }

  // ============ Public Properties ============

  /** Whether the underlying connection is established */
  get connected(): boolean {
    return this._client?.connected ?? false;
  }

  /** The local asset's info (available after connect) */
  get localAsset(): TrackedAsset | null {
    return this._localAsset;
  }

  /** All currently joined zones */
  get zones(): Map<string, TrackingZone> {
    return this._zones;
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
      if (this._zones.size > 0) {
        this._log('Reconnected — restoring zones...');
        this._restoreZones();
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

    // Create local asset
    this._localAsset = {
      assetId: this._assetId,
      actorTokenId: this._client.actorId!,
      assetName: this._options.assetName,
      metadata: this._options.metadata,
      joinedAt: Date.now(),
      isLocal: true,
    };

    this._log('Local asset:', this._localAsset.assetId, '→', this._localAsset.actorTokenId);

    // Set up lobby for global presence
    await this._setupLobby();

    // Emit connected now that _localAsset and lobby are ready
    this.emit('connected');

    // Deferred lobby refetch to catch assets who joined during the setup window
    setTimeout(() => {
      if (this._lobby && this._client?.connected) {
        this._lobby.fetchPresence().then((state) => {
          this._hydrateOnlineAssets(state);
        }).catch(() => { /* ignore — best-effort */ });
      }
    }, 2000);
  }

  /**
   * Disconnect from NoLag and clean up all zones.
   */
  disconnect(): void {
    this._log('Disconnecting...');

    // Clean up zones
    for (const name of [...this._zones.keys()]) {
      this.leaveZone(name);
    }

    // Unsubscribe from lobby
    this._lobby?.unsubscribe();
    this._lobby = null;

    // Disconnect client
    this._client?.disconnect();
    this._client = null;

    // Clear state
    this._onlineAssets.clear();
    this._actorToAssetId.clear();
    this._localAsset = null;
  }

  // ============ Zone Management ============

  /**
   * Join a tracking zone. Creates, subscribes, and activates it.
   * Returns an existing zone if already joined.
   */
  joinZone(name: string): TrackingZone {
    if (!this._client || !this._localAsset) {
      throw new Error('Not connected — call connect() first');
    }

    let zone = this._zones.get(name);
    if (!zone) {
      zone = this._subscribeZone(name);
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

  // ============ Private: Zone Setup ============

  private _subscribeZone(name: string): TrackingZone {
    if (!this._client || !this._localAsset) {
      throw new Error('Not connected — call connect() first');
    }

    this._log('Subscribing zone:', name);

    const roomContext = this._client.setApp(this._options.appName).setRoom(name);
    const zone = new TrackingZone(
      name,
      roomContext,
      this._localAsset,
      this._options,
      createLogger(`TrackingZone:${name}`, this._options.debug),
    );

    this._zones.set(name, zone);
    zone._subscribe();

    return zone;
  }

  // ============ Private: Room Presence ============

  private _handleRoomPresenceJoin(data: ActorPresence): void {
    if (data.actorTokenId === this._localAsset?.actorTokenId) return;
    const presenceData = data.presence as unknown as TrackPresenceData;
    if (!presenceData?.assetId) return;

    const asset = this._presenceToAsset(data.actorTokenId, presenceData);
    this._actorToAssetId.set(data.actorTokenId, asset.assetId);
    if (!this._onlineAssets.has(asset.assetId)) {
      this._onlineAssets.set(asset.assetId, asset);
      this.emit('assetOnline', asset);
    }

    // Route to all zones
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
    if (!presenceData?.assetId) return;

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
      this._hydrateOnlineAssets(initialState);
      this._log('Lobby subscribed, online assets:', this._onlineAssets.size);
    } catch (err) {
      this._log('Lobby subscription failed:', err);
    }
  }

  private _handleLobbyJoin(event: LobbyPresenceEvent): void {
    const { actorId, data } = event;
    if (actorId === this._localAsset?.actorTokenId) return;

    const presenceData = data as unknown as TrackPresenceData;
    if (!presenceData.assetId) return;

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
    if (!presenceData.assetId) return;

    const asset = this._presenceToAsset(actorId, presenceData);
    this._onlineAssets.set(asset.assetId, asset);
  }

  private _hydrateOnlineAssets(state: LobbyPresenceState): void {
    for (const roomId of Object.keys(state)) {
      const roomPresence = state[roomId];
      for (const actorId of Object.keys(roomPresence)) {
        if (actorId === this._localAsset?.actorTokenId) continue;

        const raw = roomPresence[actorId] as Record<string, unknown>;
        const presenceData = (raw?.presence ?? raw) as unknown as TrackPresenceData;
        if (presenceData?.assetId) {
          const asset = this._presenceToAsset(actorId, presenceData);
          this._actorToAssetId.set(actorId, asset.assetId);
          if (!this._onlineAssets.has(asset.assetId)) {
            this._onlineAssets.set(asset.assetId, asset);
            this.emit('assetOnline', asset);
          }
        }
      }
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

  private _restoreZones(): void {
    // On reconnect, js-sdk auto-restores subscriptions.
    // Re-set presence on all active zones.
    for (const zone of this._zones.values()) {
      zone._updateLocalPresence();
    }

    // Re-fetch lobby presence
    this._lobby?.fetchPresence().then((state) => {
      this._onlineAssets.clear();
      this._actorToAssetId.clear();
      this._hydrateOnlineAssets(state);
    }).catch((err) => {
      this._log('Failed to re-fetch lobby presence:', err);
    });
  }
}
