/**
 * @nolag/track
 * Vehicle/asset GPS tracking SDK for Node.js
 */

export { NoLagTrack } from './NoLagTrack';
export { TrackingZone } from './TrackingZone';
export { EventEmitter } from './EventEmitter';

export type {
  NoLagTrackOptions,
  ResolvedTrackOptions,
  GeoPoint,
  LocationUpdate,
  TrackedAsset,
  CircleGeofence,
  PolygonGeofence,
  Geofence,
  GeofenceEventType,
  GeofenceEvent,
  TrackPresenceData,
  TrackClientEvents,
  TrackZoneEvents,
} from './types';
