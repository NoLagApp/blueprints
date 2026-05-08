import { describe, it, expect, beforeEach } from 'vitest';
import { TelemetryStore } from '../../src/TelemetryStore';
import type { TelemetryReading } from '../../src/types';

function makeReading(overrides: Partial<TelemetryReading> = {}): TelemetryReading {
  return {
    id: 'reading-' + Math.random().toString(36).slice(2, 8),
    deviceId: 'device-01',
    sensorId: 'temperature',
    value: 22.5,
    timestamp: Date.now(),
    isReplay: false,
    ...overrides,
  };
}

describe('TelemetryStore', () => {
  let store: TelemetryStore;

  beforeEach(() => {
    store = new TelemetryStore(100);
  });

  describe('add', () => {
    it('should add a reading and return true', () => {
      const reading = makeReading();
      expect(store.add(reading)).toBe(true);
    });

    it('should return false for duplicate id (idempotent)', () => {
      const reading = makeReading({ id: 'dup-id' });
      expect(store.add(reading)).toBe(true);
      expect(store.add(reading)).toBe(false);
    });

    it('should increase size after adding a reading', () => {
      expect(store.size).toBe(0);
      store.add(makeReading({ id: 'r1' }));
      expect(store.size).toBe(1);
      store.add(makeReading({ id: 'r2' }));
      expect(store.size).toBe(2);
    });

    it('should store readings per device/sensor key', () => {
      store.add(makeReading({ id: 'a', deviceId: 'dev-1', sensorId: 'temp' }));
      store.add(makeReading({ id: 'b', deviceId: 'dev-1', sensorId: 'humidity' }));
      store.add(makeReading({ id: 'c', deviceId: 'dev-2', sensorId: 'temp' }));

      expect(store.getAll('dev-1', 'temp').length).toBe(1);
      expect(store.getAll('dev-1', 'humidity').length).toBe(1);
      expect(store.getAll('dev-2', 'temp').length).toBe(1);
    });

    it('should enforce the maxPoints cap per key', () => {
      const small = new TelemetryStore(3);
      for (let i = 0; i < 5; i++) {
        small.add(makeReading({ id: `r${i}`, deviceId: 'dev-1', sensorId: 'temp' }));
      }
      expect(small.getAll('dev-1', 'temp').length).toBe(3);
    });

    it('should keep the most recent readings when cap is exceeded', () => {
      const small = new TelemetryStore(2);
      small.add(makeReading({ id: 'oldest', deviceId: 'd', sensorId: 's', value: 1 }));
      small.add(makeReading({ id: 'middle', deviceId: 'd', sensorId: 's', value: 2 }));
      small.add(makeReading({ id: 'newest', deviceId: 'd', sensorId: 's', value: 3 }));

      const all = small.getAll('d', 's');
      expect(all.length).toBe(2);
      expect(all.map(r => r.id)).not.toContain('oldest');
      expect(all.map(r => r.id)).toContain('middle');
      expect(all.map(r => r.id)).toContain('newest');
    });
  });

  describe('getAll', () => {
    beforeEach(() => {
      store.add(makeReading({ id: 'a1', deviceId: 'dev-1', sensorId: 'temp', value: 20 }));
      store.add(makeReading({ id: 'a2', deviceId: 'dev-1', sensorId: 'temp', value: 21 }));
      store.add(makeReading({ id: 'b1', deviceId: 'dev-1', sensorId: 'humidity', value: 55 }));
      store.add(makeReading({ id: 'c1', deviceId: 'dev-2', sensorId: 'temp', value: 18 }));
    });

    it('should return all readings when called with no args', () => {
      expect(store.getAll().length).toBe(4);
    });

    it('should filter by deviceId only', () => {
      const readings = store.getAll('dev-1');
      expect(readings.length).toBe(3);
      expect(readings.every(r => r.deviceId === 'dev-1')).toBe(true);
    });

    it('should filter by deviceId and sensorId', () => {
      const readings = store.getAll('dev-1', 'temp');
      expect(readings.length).toBe(2);
      expect(readings.every(r => r.sensorId === 'temp')).toBe(true);
    });

    it('should return empty array for unknown device', () => {
      expect(store.getAll('unknown-device')).toEqual([]);
    });

    it('should return empty array for unknown sensor', () => {
      expect(store.getAll('dev-1', 'pressure')).toEqual([]);
    });

    it('should return copies (not live references)', () => {
      const readings = store.getAll('dev-1', 'temp');
      expect(readings).not.toBe(store.getAll('dev-1', 'temp'));
    });
  });

  describe('getLatest', () => {
    it('should return the most recent reading for a device/sensor', () => {
      store.add(makeReading({ id: 'r1', deviceId: 'dev-1', sensorId: 'temp', value: 20 }));
      store.add(makeReading({ id: 'r2', deviceId: 'dev-1', sensorId: 'temp', value: 25 }));

      const latest = store.getLatest('dev-1', 'temp');
      expect(latest).toBeDefined();
      expect(latest!.id).toBe('r2');
      expect(latest!.value).toBe(25);
    });

    it('should return undefined for unknown device/sensor', () => {
      expect(store.getLatest('unknown', 'temp')).toBeUndefined();
    });

    it('should return undefined for empty store', () => {
      expect(store.getLatest('dev-1', 'temp')).toBeUndefined();
    });
  });

  describe('has', () => {
    it('should return true for an existing reading id', () => {
      store.add(makeReading({ id: 'known-id' }));
      expect(store.has('known-id')).toBe(true);
    });

    it('should return false for an unknown reading id', () => {
      expect(store.has('nonexistent')).toBe(false);
    });
  });

  describe('size', () => {
    it('should be 0 for an empty store', () => {
      expect(store.size).toBe(0);
    });

    it('should reflect total readings across all keys', () => {
      store.add(makeReading({ id: 'x1', deviceId: 'd1', sensorId: 's1' }));
      store.add(makeReading({ id: 'x2', deviceId: 'd1', sensorId: 's2' }));
      store.add(makeReading({ id: 'x3', deviceId: 'd2', sensorId: 's1' }));
      expect(store.size).toBe(3);
    });
  });

  describe('clear', () => {
    it('should remove all readings and ids', () => {
      store.add(makeReading({ id: 'to-clear' }));
      store.clear();
      expect(store.size).toBe(0);
      expect(store.has('to-clear')).toBe(false);
      expect(store.getAll()).toEqual([]);
    });
  });

  describe('value types', () => {
    it('should store numeric values', () => {
      store.add(makeReading({ id: 'num', value: 42.5 }));
      expect(store.getLatest('device-01', 'temperature')!.value).toBe(42.5);
    });

    it('should store string values', () => {
      store.add(makeReading({ id: 'str', value: 'running' }));
      expect(store.getLatest('device-01', 'temperature')!.value).toBe('running');
    });

    it('should store boolean values', () => {
      store.add(makeReading({ id: 'bool', value: true }));
      expect(store.getLatest('device-01', 'temperature')!.value).toBe(true);
    });

    it('should store object values', () => {
      store.add(makeReading({ id: 'obj', value: { x: 1, y: 2 } }));
      expect(store.getLatest('device-01', 'temperature')!.value).toEqual({ x: 1, y: 2 });
    });
  });
});
