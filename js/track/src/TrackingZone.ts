import type { RoomContext, MessageMeta } from '@nolag/js-sdk';
import { EventEmitter } from './EventEmitter';
import { PresenceManager } from './PresenceManager';
import { LocationStore } from './LocationStore';
import { GeofenceManager } from './GeofenceManager';
import { pointToCell, geofenceToCells } from './GeoGrid';
import { generateId, filterEmitOptions, mergeFilters, withoutFilters } from './utils';
import { TOPIC_LOCATIONS, TOPIC_GEOFENCE } from './constants';
import type {
  TrackZoneEvents,
  LocationUpdate,
  GeoPoint,
  Geofence,
  GeofenceEvent,
  TrackedAsset,
  TrackPresenceData,
  ResolvedTrackOptions,
  FilterValue,
  SendLocationOptions,
} from './types';

/**
 * TrackingZone — a single GPS tracking zone for asset location exchange and geofencing.
 *
 * Created via `NoLagTrack.joinZone(name)`. Do not instantiate directly.
 */
export class TrackingZone extends EventEmitter<TrackZoneEvents> {
  /** Zone name */
  readonly name: string;

  private _roomContext: RoomContext;
  private _localAsset: TrackedAsset;
  private _options: ResolvedTrackOptions;
  private _presenceManager: PresenceManager;
  private _locationStore: LocationStore;
  private _geofenceManager: GeofenceManager;
  private _locationCells = new Set<string>();

  /**
   * Filter values set through the public filter API. Kept apart from the
   * geofence cells so recalculating one never discards the other.
   */
  private _userFilters: FilterValue[] = [];
  private _log: (...args: unknown[]) => void;
  private _isConnected: () => boolean;

  // Stored topic handler refs — cleanup removes exactly these, never all
  // handlers for a topic (the client may be shared with other consumers).
  private _onLocationsRef: ((data: unknown, meta: MessageMeta) => void) | null = null;
  private _onGeofenceRef: ((data: unknown) => void) | null = null;

  /** @internal */
  constructor(
    name: string,
    roomContext: RoomContext,
    localAsset: TrackedAsset,
    options: ResolvedTrackOptions,
    log: (...args: unknown[]) => void,
    isConnected: () => boolean,
  ) {
    super();
    this.name = name;
    this._roomContext = roomContext;
    this._localAsset = localAsset;
    this._options = options;
    this._log = log;
    this._isConnected = isConnected;

    this._presenceManager = new PresenceManager(localAsset.actorTokenId);
    this._locationStore = new LocationStore(options.maxLocationHistory);
    this._geofenceManager = new GeofenceManager();

    // Register any pre-configured geofences
    for (const zone of options.zones) {
      this._geofenceManager.addGeofence(zone);
    }
  }

  // ============ Public Properties ============

  /** All remote assets currently in this zone */
  get assets(): Map<string, TrackedAsset> {
    return this._presenceManager.assets;
  }

  // ============ Location ============

  /**
   * Publish a location update for the local asset.
   * Returns the LocationUpdate that was sent.
   */
  sendLocation(
    point: GeoPoint,
    metadata?: Record<string, unknown>,
    opts?: SendLocationOptions,
  ): LocationUpdate {
    const update: LocationUpdate = {
      id: generateId(),
      assetId: this._localAsset.assetId,
      point,
      metadata,
      timestamp: Date.now(),
      isReplay: false,
    };

    const cellKey = pointToCell(point);
    // Default routing is by grid cell, which is what geofence subscriptions
    // match on. An explicit filter replaces it (see SendLocationOptions).
    const routing = opts?.filter || opts?.filters?.length
      ? filterEmitOptions(opts)
      : { filter: cellKey };
    this._log('Sending location:', update.assetId, point.lat, point.lng, 'cell:', cellKey);
    this._roomContext.emit(TOPIC_LOCATIONS, update, { echo: false, ...routing });

    // Store locally and emit event (no echo needed — we handle our own updates)
    this._locationStore.add(update);
    this.emit('locationUpdate', update);

    // Check client-side geofences for our own location
    this._checkGeofences(update.assetId, point, update.timestamp);

    return update;
  }

  /**
   * Get location history for a specific asset, or all assets when omitted.
   */
  getLocationHistory(assetId?: string): LocationUpdate[] {
    return this._locationStore.getHistory(assetId);
  }

  // ============ Filters ============

  /**
   * The filter values set through this API. Does not include the geo-grid
   * cells derived from geofences — those are managed separately and unioned
   * with these when subscribing.
   */
  get filters(): FilterValue[] {
    return [...this._userFilters];
  }

  /**
   * Replace this zone's location filters. The values are unioned with the
   * geo-grid cells from any geofences rather than replacing them, so calling
   * this never silently switches geofencing off.
   *
   * Only matters for updates sent with an explicit
   * `sendLocation(point, meta, { filter })` — ordinary updates are tagged with
   * their grid cell, which these values will not match.
   *
   * Passing an empty array removes your values and leaves the geofence cells
   * in place; with no geofences either, the subscription is a wildcard.
   *
   * @example
   * ```ts
   * zone.setFilters(['fleet-a']);   // plus whatever geofences are active
   * zone.setFilters([]);            // geofence cells only
   * ```
   */
  setFilters(values: FilterValue[]): void {
    this._userFilters = [...values];
    this._applyLocationFilters();
  }

  /** Add filter values to the existing set. Existing AND groups are kept. */
  addFilters(values: string[]): void {
    this.setFilters(mergeFilters(this._userFilters, values));
  }

  /** Remove filter values from the existing set. */
  removeFilters(values: string[]): void {
    this.setFilters(withoutFilters(this._userFilters, values));
  }

  // ============ Geofencing ============

  /**
   * Add a geofence to this zone.
   * Automatically subscribes to the NoLag location filters for the
   * grid cells that overlap this geofence — so only location updates
   * from the relevant geographic area are delivered.
   */
  addGeofence(geofence: Geofence): void {
    this._geofenceManager.addGeofence(geofence);
    this._updateLocationFilters();
  }

  /**
   * Remove a geofence by ID.
   * Recalculates location filters for remaining geofences.
   */
  removeGeofence(id: string): void {
    this._geofenceManager.removeGeofence(id);
    this._updateLocationFilters();
  }

  /**
   * Get all registered client-side geofences.
   */
  getGeofences(): Geofence[] {
    return this._geofenceManager.getGeofences();
  }

  // ============ Assets ============

  /**
   * Get all remote assets in this zone.
   */
  getAssets(): TrackedAsset[] {
    return this._presenceManager.getAll();
  }

  /**
   * Get a specific asset by assetId.
   */
  getAsset(assetId: string): TrackedAsset | undefined {
    return this._presenceManager.getAsset(assetId);
  }

  // ============ Internal (called by NoLagTrack) ============

  /** @internal Subscribe to locations and geofence topics, attach listeners */
  _subscribe(filters?: FilterValue[]): void {
    this._log('Zone subscribe:', this.name);

    this._userFilters = filters ? [...filters] : [];

    // If geofences are pre-configured, subscribe with their cell filters so we
    // only receive location updates from relevant areas. User-supplied filters
    // are unioned in. With neither, subscribe as wildcard.
    const geofences = this._geofenceManager.getGeofences();
    if (geofences.length > 0) {
      const cells = new Set<string>();
      for (const gf of geofences) {
        for (const cell of geofenceToCells(gf)) cells.add(cell);
      }
      this._locationCells = cells;
      this._log('Subscribing to locations with', cells.size, 'cell filters');
    }

    const effective = this._effectiveLocationFilters();
    if (effective.length > 0) {
      this._roomContext.subscribe(TOPIC_LOCATIONS, { filters: effective });
    } else {
      this._roomContext.subscribe(TOPIC_LOCATIONS);
    }
    this._roomContext.subscribe(TOPIC_GEOFENCE);

    // Listeners (refs stored for handler-specific removal)
    this._onLocationsRef = (data: unknown) => {
      this._handleIncomingLocation(data);
    };
    this._roomContext.on(TOPIC_LOCATIONS, this._onLocationsRef);

    this._onGeofenceRef = (data: unknown) => {
      this._handleIncomingGeofenceEvent(data);
    };
    this._roomContext.on(TOPIC_GEOFENCE, this._onGeofenceRef);
  }

  /** @internal Set presence and fetch zone members */
  _activate(): void {
    this._log('Zone activate:', this.name);
    this._setPresence();

    this._roomContext.fetchPresence().then((actors) => {
      this._log('Zone presence fetched:', this.name, actors.length, 'actors');
      for (const actor of actors) {
        if (actor.presence) {
          const asset = this._presenceManager.addFromPresence(
            actor.actorTokenId,
            actor.presence as TrackPresenceData,
            actor.joinedAt,
          );
          if (asset) {
            this.emit('assetJoined', asset);
          }
        }
      }
    }).catch((err) => {
      this._log('Failed to fetch zone presence:', err);
    });
  }

  /** @internal Re-set presence after reconnect */
  _updateLocalPresence(): void {
    this._setPresence();
  }

  /** @internal Handle a presence:join event */
  _handlePresenceJoin(actorTokenId: string, presenceData: TrackPresenceData): void {
    const asset = this._presenceManager.addFromPresence(actorTokenId, presenceData);
    if (asset) {
      this._log('Asset joined zone:', this.name, asset.assetId);
      this.emit('assetJoined', asset);
    }
  }

  /** @internal Handle a presence:leave event */
  _handlePresenceLeave(actorTokenId: string): void {
    const asset = this._presenceManager.removeByActorId(actorTokenId);
    if (asset) {
      this._log('Asset left zone:', this.name, asset.assetId);
      this.emit('assetLeft', asset);
    }
  }

  /** @internal Handle a presence:update event */
  _handlePresenceUpdate(actorTokenId: string, presenceData: TrackPresenceData): void {
    this._presenceManager.addFromPresence(actorTokenId, presenceData);
  }

  /** @internal Handle replay start notification */
  _handleReplayStart(count: number): void {
    this._log('Zone replay start:', this.name, count, 'items');
    this.emit('replayStart', { count });
  }

  /** @internal Handle replay end notification */
  _handleReplayEnd(replayed: number): void {
    this._log('Zone replay end:', this.name, replayed, 'items replayed');
    this.emit('replayEnd', { replayed });
  }

  /** @internal Unsubscribe and clean up */
  _cleanup(): void {
    this._log('Zone cleanup:', this.name);

    // Server unsubscribes need a live socket; skip when disconnected
    // (best-effort — the core would no-op with an error callback anyway).
    if (this._isConnected()) {
      this._roomContext.unsubscribe(TOPIC_LOCATIONS);
      this._roomContext.unsubscribe(TOPIC_GEOFENCE);
    }

    // Handler-specific removal only: the client may be shared, and a bare
    // off(topic) would strip other consumers' handlers too.
    if (this._onLocationsRef) this._roomContext.off(TOPIC_LOCATIONS, this._onLocationsRef);
    if (this._onGeofenceRef) this._roomContext.off(TOPIC_GEOFENCE, this._onGeofenceRef);
    this._onLocationsRef = null;
    this._onGeofenceRef = null;

    this._presenceManager.clear();
    this._locationStore.clear();
    this._geofenceManager.clear();
    this.removeAllListeners();
  }

  // ============ Private ============

  /**
   * Recalculate location cell filters based on current geofences.
   * Calls setFilters on the locations topic to update server-side filtering.
   */
  private _updateLocationFilters(): void {
    const geofences = this._geofenceManager.getGeofences();
    if (geofences.length === 0) {
      // No geofences — drop back to whatever the user asked for on its own
      // (wildcard when they asked for nothing).
      if (this._locationCells.size > 0) {
        this._locationCells.clear();
        this._applyLocationFilters();
        this._log('Geofence cell filters cleared');
      }
      return;
    }

    const newCells = new Set<string>();
    for (const gf of geofences) {
      for (const cell of geofenceToCells(gf)) newCells.add(cell);
    }

    // Only update if cells changed
    const oldArr = [...this._locationCells].sort();
    const newArr = [...newCells].sort();
    if (oldArr.join(',') !== newArr.join(',')) {
      this._locationCells = newCells;
      this._applyLocationFilters();
      this._log('Location filters updated:', newArr.length, 'cells');
    }
  }

  /**
   * The location filter set actually sent to the server: geofence cells and
   * user-set values unioned. Empty means wildcard (receive everything).
   */
  private _effectiveLocationFilters(): FilterValue[] {
    return [...this._locationCells, ...this._userFilters];
  }

  private _applyLocationFilters(): void {
    // The core types filters as `string[]`, but both its implementation and
    // the wire protocol accept AND groups (nested arrays).
    this._roomContext.setFilters(
      TOPIC_LOCATIONS,
      this._effectiveLocationFilters() as unknown as string[],
    );
  }

  private _handleIncomingLocation(data: unknown): void {
    const update = data as LocationUpdate;
    if (!update?.assetId || !update?.point) return;

    // Skip our own updates — already handled locally in sendLocation
    if (update.assetId === this._localAsset.assetId) return;

    this._log('Received location:', update.assetId, update.point.lat, update.point.lng);

    const isNew = this._locationStore.add(update);
    if (!isNew) return;

    this.emit('locationUpdate', update);

    // Check client-side geofences for remote asset locations
    this._checkGeofences(update.assetId, update.point, update.timestamp);
  }

  private _handleIncomingGeofenceEvent(data: unknown): void {
    const event = data as GeofenceEvent;
    if (!event?.geofenceId || !event?.assetId) return;

    this._log('Received geofence event:', event.type, event.geofenceId, 'for', event.assetId);
    this.emit('geofenceTriggered', event);
  }

  private _checkGeofences(assetId: string, point: GeoPoint, _timestamp: number): void {
    const events = this._geofenceManager.checkPoint(assetId, point);
    for (const event of events) {
      this._log('Geofence triggered:', event.type, event.geofenceId, 'for', assetId);
      this.emit('geofenceTriggered', event);
    }
  }

  private _setPresence(): void {
    const presenceData: TrackPresenceData = {
      assetId: this._localAsset.assetId,
      assetName: this._localAsset.assetName,
      metadata: this._localAsset.metadata,
      // Scope tag: on a shared client, other apps' wrappers filter our
      // presence out by this (and we filter theirs).
      __scope: this._options.appName,
    };
    this._roomContext.setPresence(presenceData);
  }
}
