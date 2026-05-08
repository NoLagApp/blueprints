import type { Geofence, CircleGeofence, PolygonGeofence, GeoPoint, GeofenceEvent } from './types';

/**
 * Client-side geofence enter/exit detection.
 *
 * Tracks per-asset inside/outside state for every registered geofence and
 * emits GeofenceEvent objects when a transition is detected.
 */
export class GeofenceManager {
  private _geofences = new Map<string, Geofence>();
  /** _state[assetId][geofenceId] = true means the asset is currently inside */
  private _state = new Map<string, Map<string, boolean>>();

  /**
   * Register a geofence.
   */
  addGeofence(geofence: Geofence): void {
    this._geofences.set(geofence.id, geofence);
  }

  /**
   * Remove a geofence by ID.
   */
  removeGeofence(id: string): void {
    this._geofences.delete(id);
    // Remove stale state for all assets
    for (const assetState of this._state.values()) {
      assetState.delete(id);
    }
  }

  /**
   * Get all registered geofences.
   */
  getGeofences(): Geofence[] {
    return Array.from(this._geofences.values());
  }

  /**
   * Check a point against all geofences for a given asset.
   * Returns the list of GeofenceEvents triggered by the transition.
   */
  checkPoint(assetId: string, point: GeoPoint): GeofenceEvent[] {
    const events: GeofenceEvent[] = [];

    if (!this._state.has(assetId)) {
      this._state.set(assetId, new Map());
    }
    const assetState = this._state.get(assetId)!;

    for (const geofence of this._geofences.values()) {
      const inside = this._isInside(geofence, point);
      const wasInside = assetState.get(geofence.id) ?? false;

      if (inside && !wasInside) {
        assetState.set(geofence.id, true);
        events.push({
          geofenceId: geofence.id,
          assetId,
          type: 'enter',
          point,
          timestamp: Date.now(),
        });
      } else if (!inside && wasInside) {
        assetState.set(geofence.id, false);
        events.push({
          geofenceId: geofence.id,
          assetId,
          type: 'exit',
          point,
          timestamp: Date.now(),
        });
      }
    }

    return events;
  }

  /**
   * Clear all geofences and asset state.
   */
  clear(): void {
    this._geofences.clear();
    this._state.clear();
  }

  // ============ Private: geometry ============

  private _isInside(geofence: Geofence, point: GeoPoint): boolean {
    if (geofence.shape === 'circle') {
      return this._isInsideCircle(geofence, point);
    }
    return this._isInsidePolygon(geofence, point);
  }

  private _isInsideCircle(geofence: CircleGeofence, point: GeoPoint): boolean {
    const dist = haversineMeters(geofence.center, point);
    return dist <= geofence.radiusMeters;
  }

  private _isInsidePolygon(geofence: PolygonGeofence, point: GeoPoint): boolean {
    return pointInPolygon(point, geofence.points);
  }
}

// ============ Geometry helpers ============

/**
 * Haversine distance in metres between two GeoPoints.
 */
export function haversineMeters(a: GeoPoint, b: GeoPoint): number {
  const R = 6_371_000; // Earth radius in metres
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);

  const sinDLat = Math.sin(dLat / 2);
  const sinDLng = Math.sin(dLng / 2);

  const h =
    sinDLat * sinDLat +
    Math.cos(lat1) * Math.cos(lat2) * sinDLng * sinDLng;

  return 2 * R * Math.asin(Math.sqrt(h));
}

/**
 * Ray-casting point-in-polygon test.
 * Returns true when `point` is inside the polygon defined by `vertices`.
 */
export function pointInPolygon(point: GeoPoint, vertices: GeoPoint[]): boolean {
  if (vertices.length < 3) return false;

  const { lat: py, lng: px } = point;
  let inside = false;
  const n = vertices.length;

  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = vertices[i].lng;
    const yi = vertices[i].lat;
    const xj = vertices[j].lng;
    const yj = vertices[j].lat;

    const intersects =
      yi > py !== yj > py &&
      px < ((xj - xi) * (py - yi)) / (yj - yi) + xi;

    if (intersects) inside = !inside;
  }

  return inside;
}

function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}
