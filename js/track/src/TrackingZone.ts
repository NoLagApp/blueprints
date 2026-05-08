import type { RoomContext } from '@nolag/js-sdk';
import { EventEmitter } from './EventEmitter';
import { PresenceManager } from './PresenceManager';
import { LocationStore } from './LocationStore';
import { GeofenceManager } from './GeofenceManager';
import { generateId } from './utils';
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
  private _log: (...args: unknown[]) => void;

  /** @internal */
  constructor(
    name: string,
    roomContext: RoomContext,
    localAsset: TrackedAsset,
    options: ResolvedTrackOptions,
    log: (...args: unknown[]) => void,
  ) {
    super();
    this.name = name;
    this._roomContext = roomContext;
    this._localAsset = localAsset;
    this._options = options;
    this._log = log;

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
  sendLocation(point: GeoPoint, metadata?: Record<string, unknown>): LocationUpdate {
    const update: LocationUpdate = {
      id: generateId(),
      assetId: this._localAsset.assetId,
      point,
      metadata,
      timestamp: Date.now(),
      isReplay: false,
    };

    this._log('Sending location:', update.assetId, point.lat, point.lng);
    this._roomContext.emit(TOPIC_LOCATIONS, update, { echo: true });

    // Store locally
    this._locationStore.add(update);

    // Check client-side geofences
    this._checkGeofences(update.assetId, point, update.timestamp);

    return update;
  }

  /**
   * Get location history for a specific asset, or all assets when omitted.
   */
  getLocationHistory(assetId?: string): LocationUpdate[] {
    return this._locationStore.getHistory(assetId);
  }

  // ============ Geofencing ============

  /**
   * Add a client-side geofence to this zone.
   */
  addGeofence(geofence: Geofence): void {
    this._geofenceManager.addGeofence(geofence);
  }

  /**
   * Remove a client-side geofence by ID.
   */
  removeGeofence(id: string): void {
    this._geofenceManager.removeGeofence(id);
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
  _subscribe(): void {
    this._log('Zone subscribe:', this.name);

    this._roomContext.subscribe(TOPIC_LOCATIONS);
    this._roomContext.subscribe(TOPIC_GEOFENCE);

    this._roomContext.on(TOPIC_LOCATIONS, (data: unknown) => {
      this._handleIncomingLocation(data);
    });

    this._roomContext.on(TOPIC_GEOFENCE, (data: unknown) => {
      this._handleIncomingGeofenceEvent(data);
    });
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

    this._roomContext.unsubscribe(TOPIC_LOCATIONS);
    this._roomContext.unsubscribe(TOPIC_GEOFENCE);
    this._roomContext.off(TOPIC_LOCATIONS);
    this._roomContext.off(TOPIC_GEOFENCE);

    this._presenceManager.clear();
    this._locationStore.clear();
    this._geofenceManager.clear();
    this.removeAllListeners();
  }

  // ============ Private ============

  private _handleIncomingLocation(data: unknown): void {
    const update = data as LocationUpdate;
    if (!update?.assetId || !update?.point) return;

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
    };
    this._roomContext.setPresence(presenceData);
  }
}
