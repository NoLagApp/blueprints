/**
 * @nolag/track — Public types
 */

// ============ Options ============

export interface NoLagTrackOptions {
  /** Stable identifier for this asset (generated if omitted) */
  assetId?: string;
  /** Human-readable name for this asset */
  assetName?: string;
  /** Custom metadata attached to asset presence */
  metadata?: Record<string, unknown>;
  /** NoLag app name (default: 'track') */
  appName?: string;
  /** WebSocket URL override */
  url?: string;
  /** Maximum location history entries per asset (default: 500) */
  maxLocationHistory?: number;
  /** Enable debug logging (default: false) */
  debug?: boolean;
  /** Auto-reconnect on disconnect (default: true) */
  reconnect?: boolean;
  /** Client-side geofence zones to register on connect */
  zones?: Geofence[];
}

/** Resolved options with defaults applied */
export interface ResolvedTrackOptions {
  assetId: string;
  assetName?: string;
  metadata?: Record<string, unknown>;
  appName: string;
  url?: string;
  maxLocationHistory: number;
  debug: boolean;
  reconnect: boolean;
  zones: Geofence[];
}

// ============ Geo Types ============

export interface GeoPoint {
  /** Latitude in decimal degrees */
  lat: number;
  /** Longitude in decimal degrees */
  lng: number;
  /** Altitude in metres above sea level */
  altitude?: number;
  /** Horizontal accuracy in metres */
  accuracy?: number;
  /** Heading in degrees (0–360) */
  heading?: number;
  /** Speed in metres per second */
  speed?: number;
}

// ============ Location Update ============

export interface LocationUpdate {
  /** Client-generated unique ID */
  id: string;
  /** The asset that sent this location */
  assetId: string;
  /** The geographic point */
  point: GeoPoint;
  /** Optional metadata attached to this specific update */
  metadata?: Record<string, unknown>;
  /** Timestamp (ms since epoch) */
  timestamp: number;
  /** True when this update is part of a history replay */
  isReplay: boolean;
}

// ============ Tracked Asset ============

export interface TrackedAsset {
  /** Stable client-generated asset ID */
  assetId: string;
  /** NoLag internal actor token ID */
  actorTokenId: string;
  /** Human-readable name */
  assetName?: string;
  /** Most recent location, if any */
  lastLocation?: GeoPoint;
  /** Custom metadata */
  metadata?: Record<string, unknown>;
  /** Timestamp when the asset joined */
  joinedAt: number;
  /** Whether this is the local asset */
  isLocal: boolean;
}

// ============ Geofences ============

export interface CircleGeofence {
  /** Unique geofence ID */
  id: string;
  shape: 'circle';
  /** Centre point of the circle */
  center: GeoPoint;
  /** Radius in metres */
  radiusMeters: number;
  /** Human-readable name */
  name?: string;
  /** Custom metadata */
  metadata?: Record<string, unknown>;
}

export interface PolygonGeofence {
  /** Unique geofence ID */
  id: string;
  shape: 'polygon';
  /** Ordered list of vertices forming the polygon */
  points: GeoPoint[];
  /** Human-readable name */
  name?: string;
  /** Custom metadata */
  metadata?: Record<string, unknown>;
}

export type Geofence = CircleGeofence | PolygonGeofence;

// ============ Geofence Events ============

export type GeofenceEventType = 'enter' | 'exit';

export interface GeofenceEvent {
  /** ID of the geofence that was triggered */
  geofenceId: string;
  /** ID of the asset that triggered it */
  assetId: string;
  /** Whether the asset entered or exited */
  type: GeofenceEventType;
  /** The location point that caused the transition */
  point: GeoPoint;
  /** Timestamp (ms since epoch) */
  timestamp: number;
}

// ============ Presence Payload ============

/** Shape of data stored in NoLag presence for tracked assets */
export interface TrackPresenceData {
  [key: string]: unknown;
  assetId: string;
  assetName?: string;
  metadata?: Record<string, unknown>;
}

// ============ Event Maps ============

export interface TrackClientEvents {
  connected: [];
  disconnected: [reason: string];
  reconnected: [];
  error: [error: Error];
  assetOnline: [asset: TrackedAsset];
  assetOffline: [asset: TrackedAsset];
}

export interface TrackZoneEvents {
  locationUpdate: [update: LocationUpdate];
  assetJoined: [asset: TrackedAsset];
  assetLeft: [asset: TrackedAsset];
  geofenceTriggered: [event: GeofenceEvent];
  replayStart: [info: { count: number }];
  replayEnd: [info: { replayed: number }];
}
