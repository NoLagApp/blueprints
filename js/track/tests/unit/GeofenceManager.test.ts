import { describe, it, expect, beforeEach } from 'vitest';
import { GeofenceManager, haversineMeters, pointInPolygon } from '../../src/GeofenceManager';
import type { CircleGeofence, PolygonGeofence, GeoPoint } from '../../src/types';

function makeCircle(overrides: Partial<CircleGeofence> = {}): CircleGeofence {
  return {
    id: 'circle-1',
    shape: 'circle',
    center: { lat: 51.5074, lng: -0.1278 },
    radiusMeters: 500,
    ...overrides,
  };
}

function makePolygon(overrides: Partial<PolygonGeofence> = {}): PolygonGeofence {
  // A simple square around (0, 0) ± 1 degree
  return {
    id: 'poly-1',
    shape: 'polygon',
    points: [
      { lat: 1, lng: -1 },
      { lat: 1, lng: 1 },
      { lat: -1, lng: 1 },
      { lat: -1, lng: -1 },
    ],
    ...overrides,
  };
}

describe('GeofenceManager', () => {
  let gm: GeofenceManager;

  beforeEach(() => {
    gm = new GeofenceManager();
  });

  describe('addGeofence / getGeofences', () => {
    it('should add and retrieve a circle geofence', () => {
      gm.addGeofence(makeCircle({ id: 'c1' }));
      expect(gm.getGeofences().length).toBe(1);
      expect(gm.getGeofences()[0].id).toBe('c1');
    });

    it('should add and retrieve a polygon geofence', () => {
      gm.addGeofence(makePolygon({ id: 'p1' }));
      expect(gm.getGeofences()[0].shape).toBe('polygon');
    });

    it('should support multiple geofences', () => {
      gm.addGeofence(makeCircle({ id: 'c1' }));
      gm.addGeofence(makePolygon({ id: 'p1' }));
      expect(gm.getGeofences().length).toBe(2);
    });

    it('should overwrite a geofence with the same id', () => {
      gm.addGeofence(makeCircle({ id: 'c1', radiusMeters: 100 }));
      gm.addGeofence(makeCircle({ id: 'c1', radiusMeters: 200 }));
      const fences = gm.getGeofences();
      expect(fences.length).toBe(1);
      expect((fences[0] as CircleGeofence).radiusMeters).toBe(200);
    });
  });

  describe('removeGeofence', () => {
    it('should remove a geofence by id', () => {
      gm.addGeofence(makeCircle({ id: 'c1' }));
      gm.removeGeofence('c1');
      expect(gm.getGeofences().length).toBe(0);
    });

    it('should be a no-op for unknown id', () => {
      gm.addGeofence(makeCircle({ id: 'c1' }));
      gm.removeGeofence('unknown');
      expect(gm.getGeofences().length).toBe(1);
    });
  });

  describe('checkPoint — circle geofence', () => {
    it('should emit enter event when asset moves inside the circle', () => {
      gm.addGeofence(makeCircle({ id: 'c1', center: { lat: 0, lng: 0 }, radiusMeters: 1000 }));

      // Point well inside 1000m of (0,0)
      const events = gm.checkPoint('asset-1', { lat: 0.001, lng: 0.001 });
      expect(events.length).toBe(1);
      expect(events[0].type).toBe('enter');
      expect(events[0].geofenceId).toBe('c1');
      expect(events[0].assetId).toBe('asset-1');
    });

    it('should emit exit event when asset leaves the circle', () => {
      gm.addGeofence(makeCircle({ id: 'c1', center: { lat: 0, lng: 0 }, radiusMeters: 100 }));

      // Enter
      gm.checkPoint('asset-1', { lat: 0, lng: 0 });
      // Exit — 1 degree is ~111km, well outside 100m
      const events = gm.checkPoint('asset-1', { lat: 1, lng: 1 });
      expect(events.length).toBe(1);
      expect(events[0].type).toBe('exit');
    });

    it('should not emit if asset stays inside', () => {
      gm.addGeofence(makeCircle({ id: 'c1', center: { lat: 0, lng: 0 }, radiusMeters: 100000 }));

      gm.checkPoint('asset-1', { lat: 0, lng: 0 });
      const events = gm.checkPoint('asset-1', { lat: 0.001, lng: 0.001 });
      expect(events.length).toBe(0);
    });

    it('should not emit if asset stays outside', () => {
      gm.addGeofence(makeCircle({ id: 'c1', center: { lat: 0, lng: 0 }, radiusMeters: 10 }));

      gm.checkPoint('asset-1', { lat: 10, lng: 10 });
      const events = gm.checkPoint('asset-1', { lat: 20, lng: 20 });
      expect(events.length).toBe(0);
    });

    it('should track enter/exit state independently per asset', () => {
      gm.addGeofence(makeCircle({ id: 'c1', center: { lat: 0, lng: 0 }, radiusMeters: 100000 }));

      const e1 = gm.checkPoint('asset-1', { lat: 0, lng: 0 });
      const e2 = gm.checkPoint('asset-2', { lat: 0, lng: 0 });
      // Both should get 'enter' independently
      expect(e1[0].type).toBe('enter');
      expect(e2[0].type).toBe('enter');
    });
  });

  describe('checkPoint — polygon geofence', () => {
    it('should emit enter when asset moves inside the polygon', () => {
      gm.addGeofence(makePolygon({ id: 'p1' }));

      const events = gm.checkPoint('asset-1', { lat: 0, lng: 0 });
      expect(events.length).toBe(1);
      expect(events[0].type).toBe('enter');
      expect(events[0].geofenceId).toBe('p1');
    });

    it('should emit exit when asset leaves the polygon', () => {
      gm.addGeofence(makePolygon({ id: 'p1' }));

      gm.checkPoint('asset-1', { lat: 0, lng: 0 }); // enter
      const events = gm.checkPoint('asset-1', { lat: 5, lng: 5 }); // exit
      expect(events.length).toBe(1);
      expect(events[0].type).toBe('exit');
    });

    it('should not emit for point outside polygon', () => {
      gm.addGeofence(makePolygon({ id: 'p1' }));

      const events = gm.checkPoint('asset-1', { lat: 5, lng: 5 });
      expect(events.length).toBe(0);
    });
  });

  describe('checkPoint — multiple geofences', () => {
    it('should return events for all triggered geofences', () => {
      gm.addGeofence(makeCircle({ id: 'c1', center: { lat: 0, lng: 0 }, radiusMeters: 100000 }));
      gm.addGeofence(makePolygon({ id: 'p1' }));

      const events = gm.checkPoint('asset-1', { lat: 0, lng: 0 });
      expect(events.length).toBe(2);
      expect(events.every(e => e.type === 'enter')).toBe(true);
    });
  });

  describe('removeGeofence clears asset state', () => {
    it('should not emit exit for a removed geofence', () => {
      gm.addGeofence(makeCircle({ id: 'c1', center: { lat: 0, lng: 0 }, radiusMeters: 100000 }));
      gm.checkPoint('asset-1', { lat: 0, lng: 0 }); // enter

      gm.removeGeofence('c1');

      // Re-add the same fence — asset state for it should be gone
      gm.addGeofence(makeCircle({ id: 'c1', center: { lat: 0, lng: 0 }, radiusMeters: 100000 }));
      const events = gm.checkPoint('asset-1', { lat: 0, lng: 0 });
      // Should re-enter (no prior state), not emit exit
      expect(events.length).toBe(1);
      expect(events[0].type).toBe('enter');
    });
  });

  describe('clear', () => {
    it('should remove all geofences and state', () => {
      gm.addGeofence(makeCircle({ id: 'c1', center: { lat: 0, lng: 0 }, radiusMeters: 100000 }));
      gm.checkPoint('asset-1', { lat: 0, lng: 0 });
      gm.clear();

      expect(gm.getGeofences().length).toBe(0);

      // Re-adding and checking should start fresh
      gm.addGeofence(makeCircle({ id: 'c1', center: { lat: 0, lng: 0 }, radiusMeters: 100000 }));
      const events = gm.checkPoint('asset-1', { lat: 0, lng: 0 });
      expect(events[0].type).toBe('enter');
    });
  });
});

describe('haversineMeters', () => {
  it('should return 0 for identical points', () => {
    expect(haversineMeters({ lat: 0, lng: 0 }, { lat: 0, lng: 0 })).toBe(0);
  });

  it('should return ~111 km for 1 degree latitude difference', () => {
    const dist = haversineMeters({ lat: 0, lng: 0 }, { lat: 1, lng: 0 });
    expect(dist).toBeGreaterThan(110_000);
    expect(dist).toBeLessThan(112_000);
  });

  it('should be symmetric', () => {
    const a: GeoPoint = { lat: 51.5074, lng: -0.1278 };
    const b: GeoPoint = { lat: 48.8566, lng: 2.3522 };
    expect(haversineMeters(a, b)).toBeCloseTo(haversineMeters(b, a), 0);
  });
});

describe('pointInPolygon', () => {
  const square: GeoPoint[] = [
    { lat: 1, lng: -1 },
    { lat: 1, lng: 1 },
    { lat: -1, lng: 1 },
    { lat: -1, lng: -1 },
  ];

  it('should return true for a point inside the polygon', () => {
    expect(pointInPolygon({ lat: 0, lng: 0 }, square)).toBe(true);
  });

  it('should return false for a point outside the polygon', () => {
    expect(pointInPolygon({ lat: 5, lng: 5 }, square)).toBe(false);
  });

  it('should return false for degenerate polygon (fewer than 3 vertices)', () => {
    expect(pointInPolygon({ lat: 0, lng: 0 }, [{ lat: 0, lng: 0 }, { lat: 1, lng: 1 }])).toBe(false);
  });
});
