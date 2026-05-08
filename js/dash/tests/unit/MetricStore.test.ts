import { describe, it, expect } from 'vitest';
import { MetricStore } from '../../src/MetricStore';
import type { MetricPoint } from '../../src/types';

function makePoint(overrides: Partial<MetricPoint> = {}): MetricPoint {
  return { id: Math.random().toString(36).slice(2), streamId: 'cpu', value: 50, timestamp: Date.now(), isReplay: false, ...overrides };
}

describe('MetricStore', () => {
  it('should add and retrieve by stream', () => {
    const store = new MetricStore(100);
    store.add(makePoint({ id: '1', streamId: 'cpu', value: 50 }));
    store.add(makePoint({ id: '2', streamId: 'mem', value: 70 }));
    expect(store.getAll('cpu').length).toBe(1);
    expect(store.getAll().length).toBe(2);
  });

  it('should deduplicate', () => {
    const store = new MetricStore(100);
    expect(store.add(makePoint({ id: 'dup' }))).toBe(true);
    expect(store.add(makePoint({ id: 'dup' }))).toBe(false);
  });

  it('should compute aggregation', () => {
    const store = new MetricStore(100);
    const now = Date.now();
    store.add(makePoint({ id: '1', streamId: 'cpu', value: 10, timestamp: now - 1000 }));
    store.add(makePoint({ id: '2', streamId: 'cpu', value: 20, timestamp: now - 500 }));
    store.add(makePoint({ id: '3', streamId: 'cpu', value: 30, timestamp: now }));
    const agg = store.getAggregation('cpu', 60000);
    expect(agg.min).toBe(10);
    expect(agg.max).toBe(30);
    expect(agg.avg).toBe(20);
    expect(agg.sum).toBe(60);
    expect(agg.count).toBe(3);
    expect(agg.last).toBe(30);
  });

  it('should enforce max per stream', () => {
    const store = new MetricStore(2);
    store.add(makePoint({ id: '1', streamId: 'cpu', timestamp: 1000 }));
    store.add(makePoint({ id: '2', streamId: 'cpu', timestamp: 2000 }));
    store.add(makePoint({ id: '3', streamId: 'cpu', timestamp: 3000 }));
    expect(store.getAll('cpu').length).toBe(2);
  });
});
