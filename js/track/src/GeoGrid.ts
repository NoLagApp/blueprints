import type { GeoPoint, Geofence, CircleGeofence, PolygonGeofence } from './types';

/**
 * Simple grid-based spatial hashing for NoLag filter keys.
 *
 * Divides the world into cells of a configurable size (default ~1km).
 * Each cell has a key like "g:51.50:-0.12" that can be used as a NoLag filter.
 *
 * When publishing: compute the cell key for the asset's position.
 * When subscribing: compute all cell keys that overlap a geofence.
 */

/** Default cell size in degrees (~1km at mid-latitudes) */
const DEFAULT_CELL_SIZE = 0.01;

/**
 * Get the grid cell key for a point.
 */
export function pointToCell(point: GeoPoint, cellSize = DEFAULT_CELL_SIZE): string {
  const latCell = Math.floor(point.lat / cellSize) * cellSize;
  const lngCell = Math.floor(point.lng / cellSize) * cellSize;
  return `g:${latCell.toFixed(3)}:${lngCell.toFixed(3)}`;
}

/**
 * Get all grid cell keys that overlap a geofence.
 */
export function geofenceToCells(geofence: Geofence, cellSize = DEFAULT_CELL_SIZE): string[] {
  if (geofence.shape === 'circle') {
    return circleToCells(geofence, cellSize);
  }
  return polygonToCells(geofence, cellSize);
}

/**
 * Get all cells that a circle geofence overlaps.
 */
function circleToCells(geofence: CircleGeofence, cellSize: number): string[] {
  // Convert radius from meters to approximate degrees
  const radiusDeg = geofence.radiusMeters / 111_320; // ~111km per degree latitude
  const radiusLngDeg = radiusDeg / Math.cos((geofence.center.lat * Math.PI) / 180);

  const minLat = geofence.center.lat - radiusDeg;
  const maxLat = geofence.center.lat + radiusDeg;
  const minLng = geofence.center.lng - radiusLngDeg;
  const maxLng = geofence.center.lng + radiusLngDeg;

  return boundsToCells(minLat, maxLat, minLng, maxLng, cellSize);
}

/**
 * Get all cells that a polygon geofence overlaps.
 */
function polygonToCells(geofence: PolygonGeofence, cellSize: number): string[] {
  if (geofence.points.length === 0) return [];

  let minLat = Infinity, maxLat = -Infinity;
  let minLng = Infinity, maxLng = -Infinity;

  for (const p of geofence.points) {
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
    if (p.lng < minLng) minLng = p.lng;
    if (p.lng > maxLng) maxLng = p.lng;
  }

  return boundsToCells(minLat, maxLat, minLng, maxLng, cellSize);
}

/**
 * Enumerate all cell keys within a bounding box.
 */
function boundsToCells(
  minLat: number, maxLat: number,
  minLng: number, maxLng: number,
  cellSize: number,
): string[] {
  const cells: string[] = [];
  const startLat = Math.floor(minLat / cellSize) * cellSize;
  const startLng = Math.floor(minLng / cellSize) * cellSize;

  for (let lat = startLat; lat <= maxLat; lat += cellSize) {
    for (let lng = startLng; lng <= maxLng; lng += cellSize) {
      cells.push(`g:${lat.toFixed(3)}:${lng.toFixed(3)}`);
    }
  }

  return cells;
}
