/**
 * @nolag/track — Browser entry point
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
