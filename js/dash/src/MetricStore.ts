import type { MetricPoint, Aggregation } from './types';

export class MetricStore {
  private _streams = new Map<string, MetricPoint[]>();
  private _ids = new Set<string>();
  private _maxPerStream: number;

  constructor(maxPerStream: number) {
    this._maxPerStream = maxPerStream;
  }

  add(point: MetricPoint): boolean {
    if (this._ids.has(point.id)) return false;
    this._ids.add(point.id);

    if (!this._streams.has(point.streamId)) this._streams.set(point.streamId, []);
    const points = this._streams.get(point.streamId)!;
    points.push(point);

    if (points.length > 1 && point.timestamp < points[points.length - 2].timestamp) {
      points.sort((a, b) => a.timestamp - b.timestamp);
    }

    while (points.length > this._maxPerStream) {
      const removed = points.shift()!;
      this._ids.delete(removed.id);
    }

    return true;
  }

  getAll(streamId?: string): MetricPoint[] {
    if (streamId) return [...(this._streams.get(streamId) ?? [])];
    const all: MetricPoint[] = [];
    for (const points of this._streams.values()) all.push(...points);
    return all.sort((a, b) => a.timestamp - b.timestamp);
  }

  getAggregation(streamId: string, windowMs?: number): Aggregation {
    const points = this._streams.get(streamId) ?? [];
    const now = Date.now();
    const window = windowMs ?? 60000;
    const filtered = points.filter(p => p.timestamp >= now - window);

    if (filtered.length === 0) {
      return { streamId, min: 0, max: 0, avg: 0, sum: 0, count: 0, last: 0, windowMs: window };
    }

    let min = Infinity, max = -Infinity, sum = 0;
    for (const p of filtered) {
      if (p.value < min) min = p.value;
      if (p.value > max) max = p.value;
      sum += p.value;
    }

    return { streamId, min, max, avg: sum / filtered.length, sum, count: filtered.length, last: filtered[filtered.length - 1].value, windowMs: window };
  }

  has(id: string): boolean { return this._ids.has(id); }
  get size(): number { return this._ids.size; }

  clear(): void {
    this._streams.clear();
    this._ids.clear();
  }
}
