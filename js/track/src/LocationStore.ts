import type { LocationUpdate, GeoPoint } from './types';

/**
 * Per-asset bounded location history store.
 *
 * Deduplicates by update id, keeps entries sorted by timestamp (ascending),
 * and trims each asset's history to the configured maximum.
 */
export class LocationStore {
  private _history = new Map<string, LocationUpdate[]>();
  private _seenIds = new Set<string>();
  private _maxPerAsset: number;

  constructor(maxPerAsset: number) {
    this._maxPerAsset = maxPerAsset;
  }

  /**
   * Add a location update.
   * Returns true if the update was new and inserted, false if it was a duplicate.
   */
  add(update: LocationUpdate): boolean {
    if (this._seenIds.has(update.id)) return false;

    this._seenIds.add(update.id);

    const list = this._history.get(update.assetId) ?? [];

    // Insert in timestamp order (binary search position)
    const insertAt = this._findInsertPosition(list, update.timestamp);
    list.splice(insertAt, 0, update);

    // Trim to max, removing oldest (front of sorted array)
    while (list.length > this._maxPerAsset) {
      const evicted = list.shift()!;
      this._seenIds.delete(evicted.id);
    }

    this._history.set(update.assetId, list);
    return true;
  }

  /**
   * Get location history for a specific asset, or all updates across all
   * assets (sorted by timestamp) when assetId is omitted.
   */
  getHistory(assetId?: string): LocationUpdate[] {
    if (assetId !== undefined) {
      return [...(this._history.get(assetId) ?? [])];
    }

    // Merge all per-asset arrays and sort by timestamp
    const all: LocationUpdate[] = [];
    for (const list of this._history.values()) {
      all.push(...list);
    }
    all.sort((a, b) => a.timestamp - b.timestamp);
    return all;
  }

  /**
   * Get the most recent location update for an asset.
   */
  getLatest(assetId: string): LocationUpdate | undefined {
    const list = this._history.get(assetId);
    return list && list.length > 0 ? list[list.length - 1] : undefined;
  }

  /**
   * Returns true if an update with the given id has been stored.
   */
  has(id: string): boolean {
    return this._seenIds.has(id);
  }

  /**
   * Total number of location updates stored across all assets.
   */
  get size(): number {
    let count = 0;
    for (const list of this._history.values()) {
      count += list.length;
    }
    return count;
  }

  /**
   * Clear all stored location data.
   */
  clear(): void {
    this._history.clear();
    this._seenIds.clear();
  }

  // ============ Private ============

  private _findInsertPosition(list: LocationUpdate[], timestamp: number): number {
    let lo = 0;
    let hi = list.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (list[mid].timestamp <= timestamp) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    return lo;
  }
}
