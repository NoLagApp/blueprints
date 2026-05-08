import { describe, it, expect, beforeEach } from 'vitest';
import { LocationStore } from '../../src/LocationStore';
import type { LocationUpdate, GeoPoint } from '../../src/types';

function makePoint(lat = 0, lng = 0): GeoPoint {
  return { lat, lng };
}

function makeUpdate(overrides: Partial<LocationUpdate> = {}): LocationUpdate {
  const id = overrides.id ?? 'id-' + Math.random().toString(36).slice(2, 8);
  return {
    id,
    assetId: 'asset-1',
    point: makePoint(),
    timestamp: Date.now(),
    isReplay: false,
    ...overrides,
  };
}

describe('LocationStore', () => {
  let store: LocationStore;

  beforeEach(() => {
    store = new LocationStore(10);
  });

  describe('add', () => {
    it('should return true when a new update is added', () => {
      const update = makeUpdate({ id: 'u1' });
      expect(store.add(update)).toBe(true);
    });

    it('should return false for a duplicate id', () => {
      const update = makeUpdate({ id: 'u1' });
      store.add(update);
      expect(store.add(update)).toBe(false);
    });

    it('should deduplicate by id across different timestamps', () => {
      const update = makeUpdate({ id: 'u1', timestamp: 1000 });
      store.add(update);
      const duplicate = { ...update, timestamp: 2000 };
      expect(store.add(duplicate)).toBe(false);
      expect(store.size).toBe(1);
    });

    it('should store updates sorted by timestamp', () => {
      store.add(makeUpdate({ id: 'u3', assetId: 'a1', timestamp: 3000 }));
      store.add(makeUpdate({ id: 'u1', assetId: 'a1', timestamp: 1000 }));
      store.add(makeUpdate({ id: 'u2', assetId: 'a1', timestamp: 2000 }));

      const history = store.getHistory('a1');
      expect(history.map(u => u.id)).toEqual(['u1', 'u2', 'u3']);
    });

    it('should trim old entries when max is exceeded per asset', () => {
      const maxStore = new LocationStore(3);
      for (let i = 1; i <= 5; i++) {
        maxStore.add(makeUpdate({ id: `u${i}`, assetId: 'a1', timestamp: i * 1000 }));
      }
      const history = maxStore.getHistory('a1');
      expect(history.length).toBe(3);
      // Oldest should be evicted — only u3, u4, u5 remain
      expect(history.map(u => u.id)).toEqual(['u3', 'u4', 'u5']);
    });

    it('should track per-asset separately — trimming one asset does not affect another', () => {
      const maxStore = new LocationStore(2);
      maxStore.add(makeUpdate({ id: 'a1-u1', assetId: 'a1', timestamp: 1000 }));
      maxStore.add(makeUpdate({ id: 'a1-u2', assetId: 'a1', timestamp: 2000 }));
      maxStore.add(makeUpdate({ id: 'a1-u3', assetId: 'a1', timestamp: 3000 }));
      maxStore.add(makeUpdate({ id: 'a2-u1', assetId: 'a2', timestamp: 1000 }));

      expect(maxStore.getHistory('a1').length).toBe(2);
      expect(maxStore.getHistory('a2').length).toBe(1);
    });
  });

  describe('getHistory', () => {
    it('should return empty array for unknown asset', () => {
      expect(store.getHistory('unknown')).toEqual([]);
    });

    it('should return history for a specific asset', () => {
      store.add(makeUpdate({ id: 'u1', assetId: 'a1', timestamp: 1000 }));
      store.add(makeUpdate({ id: 'u2', assetId: 'a2', timestamp: 2000 }));

      const history = store.getHistory('a1');
      expect(history.length).toBe(1);
      expect(history[0].id).toBe('u1');
    });

    it('should return all updates sorted by timestamp when no assetId given', () => {
      store.add(makeUpdate({ id: 'b2', assetId: 'b', timestamp: 2000 }));
      store.add(makeUpdate({ id: 'a1', assetId: 'a', timestamp: 1000 }));
      store.add(makeUpdate({ id: 'b1', assetId: 'b', timestamp: 500 }));

      const all = store.getHistory();
      expect(all.map(u => u.id)).toEqual(['b1', 'a1', 'b2']);
    });

    it('should return a copy — mutations do not affect the store', () => {
      store.add(makeUpdate({ id: 'u1', assetId: 'a1', timestamp: 1000 }));
      const history = store.getHistory('a1');
      history.pop();
      expect(store.getHistory('a1').length).toBe(1);
    });
  });

  describe('getLatest', () => {
    it('should return undefined for unknown asset', () => {
      expect(store.getLatest('unknown')).toBeUndefined();
    });

    it('should return the most recent update for an asset', () => {
      store.add(makeUpdate({ id: 'u1', assetId: 'a1', timestamp: 1000 }));
      store.add(makeUpdate({ id: 'u2', assetId: 'a1', timestamp: 3000 }));
      store.add(makeUpdate({ id: 'u3', assetId: 'a1', timestamp: 2000 }));

      const latest = store.getLatest('a1');
      expect(latest?.id).toBe('u2');
      expect(latest?.timestamp).toBe(3000);
    });
  });

  describe('has', () => {
    it('should return false for unknown id', () => {
      expect(store.has('missing')).toBe(false);
    });

    it('should return true after an update is added', () => {
      store.add(makeUpdate({ id: 'u1' }));
      expect(store.has('u1')).toBe(true);
    });
  });

  describe('size', () => {
    it('should be 0 initially', () => {
      expect(store.size).toBe(0);
    });

    it('should count total updates across all assets', () => {
      store.add(makeUpdate({ id: 'u1', assetId: 'a1' }));
      store.add(makeUpdate({ id: 'u2', assetId: 'a1' }));
      store.add(makeUpdate({ id: 'u3', assetId: 'a2' }));
      expect(store.size).toBe(3);
    });

    it('should not count duplicates', () => {
      const u = makeUpdate({ id: 'u1' });
      store.add(u);
      store.add(u);
      expect(store.size).toBe(1);
    });
  });

  describe('clear', () => {
    it('should remove all updates', () => {
      store.add(makeUpdate({ id: 'u1', assetId: 'a1' }));
      store.add(makeUpdate({ id: 'u2', assetId: 'a2' }));
      store.clear();

      expect(store.size).toBe(0);
      expect(store.getHistory()).toEqual([]);
      expect(store.has('u1')).toBe(false);
    });

    it('should allow re-adding previously evicted ids after clear', () => {
      store.add(makeUpdate({ id: 'u1' }));
      store.clear();
      expect(store.add(makeUpdate({ id: 'u1' }))).toBe(true);
    });
  });
});
