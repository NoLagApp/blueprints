import type { TelemetryReading } from './types';

/**
 * Per-device, per-sensor time-series buffer.
 *
 * Readings are stored under a composite key `${deviceId}:${sensorId}` and
 * bounded to `maxPoints` entries per key (oldest entries are dropped first).
 */
export class TelemetryStore {
  private _store = new Map<string, TelemetryReading[]>();
  private _ids = new Set<string>();
  private _maxPoints: number;

  constructor(maxPoints: number) {
    this._maxPoints = maxPoints;
  }

  // ============ Public API ============

  /**
   * Add a telemetry reading to the store.
   * Returns false if the reading id is a duplicate (idempotent).
   */
  add(reading: TelemetryReading): boolean {
    if (this._ids.has(reading.id)) return false;

    const key = this._key(reading.deviceId, reading.sensorId);
    if (!this._store.has(key)) {
      this._store.set(key, []);
    }

    const bucket = this._store.get(key)!;
    bucket.push(reading);

    // Enforce per-key cap
    if (bucket.length > this._maxPoints) {
      bucket.splice(0, bucket.length - this._maxPoints);
    }

    this._ids.add(reading.id);
    return true;
  }

  /**
   * Retrieve readings, optionally filtered by deviceId and/or sensorId.
   *
   * - No args → all readings across all devices and sensors
   * - deviceId only → all readings for that device across all sensors
   * - deviceId + sensorId → readings for that exact device/sensor pair
   */
  getAll(deviceId?: string, sensorId?: string): TelemetryReading[] {
    if (deviceId !== undefined && sensorId !== undefined) {
      return [...(this._store.get(this._key(deviceId, sensorId)) ?? [])];
    }

    const results: TelemetryReading[] = [];
    for (const [key, bucket] of this._store.entries()) {
      if (deviceId !== undefined && !key.startsWith(`${deviceId}:`)) continue;
      results.push(...bucket);
    }
    return results;
  }

  /**
   * Get the most recent reading for a specific device/sensor pair.
   */
  getLatest(deviceId: string, sensorId: string): TelemetryReading | undefined {
    const bucket = this._store.get(this._key(deviceId, sensorId));
    if (!bucket || bucket.length === 0) return undefined;
    return bucket[bucket.length - 1];
  }

  /**
   * Check whether a reading id already exists in the store.
   */
  has(id: string): boolean {
    return this._ids.has(id);
  }

  /**
   * Total number of readings across all device/sensor buckets.
   */
  get size(): number {
    let total = 0;
    for (const bucket of this._store.values()) {
      total += bucket.length;
    }
    return total;
  }

  /**
   * Clear all stored readings and ids.
   */
  clear(): void {
    this._store.clear();
    this._ids.clear();
  }

  // ============ Private ============

  private _key(deviceId: string, sensorId: string): string {
    return `${deviceId}:${sensorId}`;
  }
}
