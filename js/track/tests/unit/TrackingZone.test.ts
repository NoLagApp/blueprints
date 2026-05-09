import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TrackingZone } from '../../src/TrackingZone';
import type { TrackedAsset, ResolvedTrackOptions, TrackPresenceData, GeoPoint } from '../../src/types';
import type { RoomContext, MessageHandler } from '@nolag/js-sdk';

// Mock RoomContext
function createMockRoomContext(): RoomContext & {
  _handlers: Map<string, MessageHandler>;
  _fireMessage: (topic: string, data: unknown) => void;
} {
  const handlers = new Map<string, MessageHandler>();
  const ctx: any = {
    prefix: 'track/fleet-zone',
    _handlers: handlers,
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
    emit: vi.fn(),
    on: vi.fn((topic: string, handler: MessageHandler) => {
      handlers.set(topic, handler);
      return ctx;
    }),
    off: vi.fn((topic: string) => {
      handlers.delete(topic);
      return ctx;
    }),
    setPresence: vi.fn(),
    setFilters: vi.fn(),
    addFilters: vi.fn(),
    removeFilters: vi.fn(),
    getPresence: vi.fn(() => ({})),
    fetchPresence: vi.fn(() => Promise.resolve([])),
    _fireMessage(topic: string, data: unknown) {
      const h = handlers.get(topic);
      if (h) h(data, {});
    },
  };
  return ctx;
}

function createLocalAsset(): TrackedAsset {
  return {
    assetId: 'local-asset-id',
    actorTokenId: 'local-actor',
    assetName: 'Test Vehicle',
    joinedAt: Date.now(),
    isLocal: true,
  };
}

function createOptions(): ResolvedTrackOptions {
  return {
    assetId: 'local-asset-id',
    appName: 'track',
    maxLocationHistory: 500,
    debug: false,
    reconnect: true,
    zones: [],
  };
}

const noop = () => {};

describe('TrackingZone', () => {
  let zone: TrackingZone;
  let ctx: ReturnType<typeof createMockRoomContext>;

  beforeEach(() => {
    ctx = createMockRoomContext();
    zone = new TrackingZone('fleet-zone', ctx, createLocalAsset(), createOptions(), noop);
  });

  describe('_subscribe', () => {
    it('should subscribe to the locations topic', () => {
      zone._subscribe();
      expect(ctx.subscribe).toHaveBeenCalledWith('locations');
    });

    it('should subscribe to the _geofence topic', () => {
      zone._subscribe();
      expect(ctx.subscribe).toHaveBeenCalledWith('_geofence');
    });

    it('should listen for location messages', () => {
      zone._subscribe();
      expect(ctx.on).toHaveBeenCalledWith('locations', expect.any(Function));
    });

    it('should listen for geofence messages', () => {
      zone._subscribe();
      expect(ctx.on).toHaveBeenCalledWith('_geofence', expect.any(Function));
    });
  });

  describe('sendLocation', () => {
    it('should emit location to room context', () => {
      zone._subscribe();
      const point: GeoPoint = { lat: 51.5074, lng: -0.1278 };
      zone.sendLocation(point);

      expect(ctx.emit).toHaveBeenCalledWith(
        'locations',
        expect.objectContaining({
          assetId: 'local-asset-id',
          point,
          isReplay: false,
        }),
        expect.objectContaining({ echo: false, filter: expect.any(String) }),
      );
    });

    it('should include a unique id and timestamp', () => {
      zone._subscribe();
      const update = zone.sendLocation({ lat: 0, lng: 0 });

      expect(typeof update.id).toBe('string');
      expect(update.id.length).toBeGreaterThan(0);
      expect(typeof update.timestamp).toBe('number');
    });

    it('should attach metadata when provided', () => {
      zone._subscribe();
      const update = zone.sendLocation({ lat: 0, lng: 0 }, { driver: 'Alice' });

      expect(update.metadata).toEqual({ driver: 'Alice' });
    });

    it('should store the update in location history', () => {
      zone._subscribe();
      zone.sendLocation({ lat: 1, lng: 2 });

      const history = zone.getLocationHistory('local-asset-id');
      expect(history.length).toBe(1);
      expect(history[0].point.lat).toBe(1);
    });

    it('should return the LocationUpdate', () => {
      zone._subscribe();
      const update = zone.sendLocation({ lat: 10, lng: 20 });

      expect(update).toBeDefined();
      expect(update.assetId).toBe('local-asset-id');
    });
  });

  describe('incoming location messages', () => {
    it('should emit locationUpdate event for valid location', () => {
      zone._subscribe();
      const handler = vi.fn();
      zone.on('locationUpdate', handler);

      ctx._fireMessage('locations', {
        id: 'loc-1',
        assetId: 'remote-asset',
        point: { lat: 51.5, lng: -0.1 },
        timestamp: Date.now(),
        isReplay: false,
      });

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'loc-1',
          assetId: 'remote-asset',
        }),
      );
    });

    it('should not emit locationUpdate for duplicate id', () => {
      zone._subscribe();
      const handler = vi.fn();
      zone.on('locationUpdate', handler);

      const msg = {
        id: 'loc-1',
        assetId: 'remote-asset',
        point: { lat: 51.5, lng: -0.1 },
        timestamp: Date.now(),
        isReplay: false,
      };
      ctx._fireMessage('locations', msg);
      ctx._fireMessage('locations', msg);

      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('should not emit locationUpdate for malformed data', () => {
      zone._subscribe();
      const handler = vi.fn();
      zone.on('locationUpdate', handler);

      ctx._fireMessage('locations', { bad: 'data' });

      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe('incoming geofence events (server-side)', () => {
    it('should emit geofenceTriggered for valid geofence event', () => {
      zone._subscribe();
      const handler = vi.fn();
      zone.on('geofenceTriggered', handler);

      ctx._fireMessage('_geofence', {
        geofenceId: 'gf-1',
        assetId: 'remote-asset',
        type: 'enter',
        point: { lat: 0, lng: 0 },
        timestamp: Date.now(),
      });

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          geofenceId: 'gf-1',
          type: 'enter',
        }),
      );
    });

    it('should not emit for malformed geofence data', () => {
      zone._subscribe();
      const handler = vi.fn();
      zone.on('geofenceTriggered', handler);

      ctx._fireMessage('_geofence', { bad: 'data' });

      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe('client-side geofencing', () => {
    it('should emit geofenceTriggered when location enters a circle geofence', () => {
      zone._subscribe();
      zone.addGeofence({
        id: 'circle-1',
        shape: 'circle',
        center: { lat: 0, lng: 0 },
        radiusMeters: 100000,
      });

      const handler = vi.fn();
      zone.on('geofenceTriggered', handler);

      zone.sendLocation({ lat: 0, lng: 0 });

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          geofenceId: 'circle-1',
          type: 'enter',
        }),
      );
    });

    it('should remove a geofence', () => {
      zone._subscribe();
      zone.addGeofence({
        id: 'circle-1',
        shape: 'circle',
        center: { lat: 0, lng: 0 },
        radiusMeters: 100000,
      });
      zone.removeGeofence('circle-1');

      expect(zone.getGeofences().length).toBe(0);
    });

    it('should register zones from options on construction', () => {
      const optionsWithZones = {
        ...createOptions(),
        zones: [
          { id: 'pre-zone', shape: 'circle' as const, center: { lat: 0, lng: 0 }, radiusMeters: 500 },
        ],
      };
      const zoneWithFences = new TrackingZone('z', ctx, createLocalAsset(), optionsWithZones, noop);
      expect(zoneWithFences.getGeofences().length).toBe(1);
    });
  });

  describe('getLocationHistory', () => {
    it('should return empty array initially', () => {
      zone._subscribe();
      expect(zone.getLocationHistory('unknown')).toEqual([]);
    });

    it('should return history for a specific asset after receiving location', () => {
      zone._subscribe();
      ctx._fireMessage('locations', {
        id: 'loc-1',
        assetId: 'asset-x',
        point: { lat: 10, lng: 20 },
        timestamp: 1000,
        isReplay: false,
      });

      const history = zone.getLocationHistory('asset-x');
      expect(history.length).toBe(1);
      expect(history[0].point.lat).toBe(10);
    });
  });

  describe('presence events', () => {
    it('should emit assetJoined on _handlePresenceJoin', () => {
      zone._subscribe();
      const handler = vi.fn();
      zone.on('assetJoined', handler);

      const presence: TrackPresenceData = { assetId: 'remote-asset', assetName: 'Bus-01' };
      zone._handlePresenceJoin('actor-remote', presence);

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          assetId: 'remote-asset',
          assetName: 'Bus-01',
          isLocal: false,
        }),
      );
    });

    it('should emit assetLeft on _handlePresenceLeave', () => {
      zone._subscribe();
      const joinHandler = vi.fn();
      const leaveHandler = vi.fn();
      zone.on('assetJoined', joinHandler);
      zone.on('assetLeft', leaveHandler);

      zone._handlePresenceJoin('actor-remote', { assetId: 'remote-asset' });
      zone._handlePresenceLeave('actor-remote');

      expect(leaveHandler).toHaveBeenCalledWith(
        expect.objectContaining({ assetId: 'remote-asset' }),
      );
    });

    it('should not emit for self', () => {
      zone._subscribe();
      const handler = vi.fn();
      zone.on('assetJoined', handler);

      zone._handlePresenceJoin('local-actor', { assetId: 'local-asset-id' });

      expect(handler).not.toHaveBeenCalled();
    });

    it('should not emit assetLeft for unknown actor', () => {
      zone._subscribe();
      const handler = vi.fn();
      zone.on('assetLeft', handler);

      zone._handlePresenceLeave('unknown-actor');

      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe('getAssets', () => {
    it('should return all remote assets', () => {
      zone._subscribe();
      zone._handlePresenceJoin('actor-1', { assetId: 'a1' });
      zone._handlePresenceJoin('actor-2', { assetId: 'a2' });

      expect(zone.getAssets().length).toBe(2);
    });

    it('should return empty initially', () => {
      zone._subscribe();
      expect(zone.getAssets().length).toBe(0);
    });
  });

  describe('replay events', () => {
    it('should emit replayStart', () => {
      const handler = vi.fn();
      zone.on('replayStart', handler);
      zone._handleReplayStart(42);

      expect(handler).toHaveBeenCalledWith({ count: 42 });
    });

    it('should emit replayEnd', () => {
      const handler = vi.fn();
      zone.on('replayEnd', handler);
      zone._handleReplayEnd(38);

      expect(handler).toHaveBeenCalledWith({ replayed: 38 });
    });
  });

  describe('_cleanup', () => {
    it('should unsubscribe from locations and _geofence topics', () => {
      zone._subscribe();
      zone._cleanup();

      expect(ctx.unsubscribe).toHaveBeenCalledWith('locations');
      expect(ctx.unsubscribe).toHaveBeenCalledWith('_geofence');
      expect(ctx.off).toHaveBeenCalledWith('locations');
      expect(ctx.off).toHaveBeenCalledWith('_geofence');
    });

    it('should remove all event listeners', () => {
      zone._subscribe();
      zone.on('locationUpdate', vi.fn());
      zone._cleanup();

      expect(zone.listenerCount('locationUpdate')).toBe(0);
    });
  });
});
