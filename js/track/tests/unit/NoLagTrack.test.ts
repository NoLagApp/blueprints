import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock @nolag/js-sdk before importing NoLagTrack
const mockClient = {
  connected: false,
  actorId: 'test-actor-123',
  connect: vi.fn(),
  disconnect: vi.fn(),
  on: vi.fn(),
  off: vi.fn(),
  setApp: vi.fn(),
};

const mockRoomContext = {
  prefix: 'track/fleet-zone',
  subscribe: vi.fn(),
  unsubscribe: vi.fn(),
  emit: vi.fn(),
  on: vi.fn().mockReturnThis(),
  off: vi.fn().mockReturnThis(),
  setPresence: vi.fn(),
  getPresence: vi.fn(() => ({})),
  fetchPresence: vi.fn(() => Promise.resolve([])),
};

const mockLobbyContext = {
  lobbyId: 'online',
  subscribe: vi.fn(() => Promise.resolve({})),
  unsubscribe: vi.fn(),
  fetchPresence: vi.fn(() => Promise.resolve({})),
  on: vi.fn().mockReturnThis(),
  off: vi.fn().mockReturnThis(),
};

const mockAppContext = {
  setRoom: vi.fn(() => mockRoomContext),
  setLobby: vi.fn(() => mockLobbyContext),
};

mockClient.setApp.mockReturnValue(mockAppContext);

vi.mock('@nolag/js-sdk', () => ({
  NoLag: vi.fn(() => {
    mockClient.connected = false;
    mockClient.connect.mockImplementation(async () => {
      mockClient.connected = true;
    });
    return mockClient;
  }),
}));

import { NoLagTrack } from '../../src/NoLagTrack';

describe('NoLagTrack', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockClient.connected = false;
    mockClient.connect.mockImplementation(async () => {
      mockClient.connected = true;
    });
    mockLobbyContext.subscribe.mockResolvedValue({});
    mockRoomContext.fetchPresence.mockResolvedValue([]);
  });

  describe('constructor', () => {
    it('should accept token and options', () => {
      const track = new NoLagTrack('test-token');
      expect(track.connected).toBe(false);
      expect(track.localAsset).toBeNull();
    });

    it('should accept optional options', () => {
      const track = new NoLagTrack('test-token', { debug: false, reconnect: true });
      expect(track.connected).toBe(false);
    });

    it('should work with no options argument', () => {
      const track = new NoLagTrack('test-token');
      expect(track.connected).toBe(false);
      expect(track.localAsset).toBeNull();
    });

    it('should accept a custom assetId', () => {
      const track = new NoLagTrack('test-token', { assetId: 'my-truck-01' });
      // assetId is accessible after connect, but we can verify options are applied
      expect(track.connected).toBe(false);
    });
  });

  describe('connect', () => {
    it('should create a NoLag client and connect', async () => {
      const track = new NoLagTrack('test-token');
      await track.connect();

      expect(mockClient.connect).toHaveBeenCalled();
      expect(track.connected).toBe(true);
      expect(track.localAsset).not.toBeNull();
      expect(track.localAsset!.actorTokenId).toBe('test-actor-123');
      expect(track.localAsset!.isLocal).toBe(true);
    });

    it('should assign a stable assetId to local asset', async () => {
      const track = new NoLagTrack('test-token');
      await track.connect();

      expect(track.localAsset!.assetId).toBeDefined();
      expect(typeof track.localAsset!.assetId).toBe('string');
      expect(track.localAsset!.assetId.length).toBeGreaterThan(0);
    });

    it('should use the provided assetId', async () => {
      const track = new NoLagTrack('test-token', { assetId: 'vehicle-007' });
      await track.connect();

      expect(track.localAsset!.assetId).toBe('vehicle-007');
    });

    it('should attach assetName to local asset', async () => {
      const track = new NoLagTrack('test-token', { assetName: 'Fleet Truck' });
      await track.connect();

      expect(track.localAsset!.assetName).toBe('Fleet Truck');
    });

    it('should attach metadata to local asset', async () => {
      const track = new NoLagTrack('test-token', { metadata: { fleet: 'north' } });
      await track.connect();

      expect(track.localAsset!.metadata).toEqual({ fleet: 'north' });
    });

    it('should subscribe to lobby', async () => {
      const track = new NoLagTrack('test-token');
      await track.connect();

      expect(mockAppContext.setLobby).toHaveBeenCalledWith('online');
      expect(mockLobbyContext.subscribe).toHaveBeenCalled();
    });

    it('should wire client lifecycle events', async () => {
      const track = new NoLagTrack('test-token');
      await track.connect();

      expect(mockClient.on).toHaveBeenCalledWith('connect', expect.any(Function));
      expect(mockClient.on).toHaveBeenCalledWith('disconnect', expect.any(Function));
      expect(mockClient.on).toHaveBeenCalledWith('reconnect', expect.any(Function));
      expect(mockClient.on).toHaveBeenCalledWith('error', expect.any(Function));
    });

    it('should emit connected event', async () => {
      const track = new NoLagTrack('test-token');
      const handler = vi.fn();
      track.on('connected', handler);
      await track.connect();

      expect(handler).toHaveBeenCalled();
    });

    it('should use default app name "track"', async () => {
      const track = new NoLagTrack('test-token');
      await track.connect();

      expect(mockClient.setApp).toHaveBeenCalledWith('track');
    });

    it('should use custom app name when provided', async () => {
      const track = new NoLagTrack('test-token', { appName: 'my-fleet' });
      await track.connect();

      expect(mockClient.setApp).toHaveBeenCalledWith('my-fleet');
    });
  });

  describe('joinZone', () => {
    it('should create a TrackingZone and return it', async () => {
      const track = new NoLagTrack('test-token');
      await track.connect();

      const zone = track.joinZone('fleet-zone');

      expect(zone).toBeDefined();
      expect(zone.name).toBe('fleet-zone');
      expect(mockAppContext.setRoom).toHaveBeenCalledWith('fleet-zone');
    });

    it('should return existing zone if already joined (idempotent)', async () => {
      const track = new NoLagTrack('test-token');
      await track.connect();

      const zone1 = track.joinZone('fleet-zone');
      const zone2 = track.joinZone('fleet-zone');

      expect(zone1).toBe(zone2);
    });

    it('should throw if not connected', () => {
      const track = new NoLagTrack('test-token');
      expect(() => track.joinZone('fleet-zone')).toThrow('Not connected');
    });

    it('should subscribe to locations topic', async () => {
      const track = new NoLagTrack('test-token');
      await track.connect();

      track.joinZone('fleet-zone');

      expect(mockRoomContext.subscribe).toHaveBeenCalledWith('locations');
    });

    it('should subscribe to _geofence topic', async () => {
      const track = new NoLagTrack('test-token');
      await track.connect();

      track.joinZone('fleet-zone');

      expect(mockRoomContext.subscribe).toHaveBeenCalledWith('_geofence');
    });
  });

  describe('leaveZone', () => {
    it('should remove the zone', async () => {
      const track = new NoLagTrack('test-token');
      await track.connect();

      track.joinZone('fleet-zone');
      track.leaveZone('fleet-zone');

      expect(track.zones.size).toBe(0);
    });

    it('should be a no-op for unknown zones', async () => {
      const track = new NoLagTrack('test-token');
      await track.connect();

      expect(() => track.leaveZone('nonexistent')).not.toThrow();
    });

    it('should unsubscribe from locations topic on leave', async () => {
      const track = new NoLagTrack('test-token');
      await track.connect();

      track.joinZone('fleet-zone');
      track.leaveZone('fleet-zone');

      expect(mockRoomContext.unsubscribe).toHaveBeenCalledWith('locations');
    });

    it('should unsubscribe from _geofence topic on leave', async () => {
      const track = new NoLagTrack('test-token');
      await track.connect();

      track.joinZone('fleet-zone');
      track.leaveZone('fleet-zone');

      expect(mockRoomContext.unsubscribe).toHaveBeenCalledWith('_geofence');
    });
  });

  describe('getZones', () => {
    it('should return all joined zones', async () => {
      let callCount = 0;
      mockAppContext.setRoom.mockImplementation(() => {
        callCount++;
        return {
          ...mockRoomContext,
          prefix: `track/zone-${callCount}`,
          subscribe: vi.fn(),
          unsubscribe: vi.fn(),
          emit: vi.fn(),
          on: vi.fn().mockReturnThis(),
          off: vi.fn().mockReturnThis(),
          setPresence: vi.fn(),
          getPresence: vi.fn(() => ({})),
          fetchPresence: vi.fn(() => Promise.resolve([])),
        };
      });

      const track = new NoLagTrack('test-token');
      await track.connect();

      track.joinZone('zone-a');
      track.joinZone('zone-b');

      expect(track.getZones().length).toBe(2);
    });
  });

  describe('disconnect', () => {
    it('should clean up zones and disconnect client', async () => {
      const track = new NoLagTrack('test-token');
      await track.connect();
      track.joinZone('fleet-zone');

      track.disconnect();

      expect(track.zones.size).toBe(0);
      expect(mockClient.disconnect).toHaveBeenCalled();
      expect(mockLobbyContext.unsubscribe).toHaveBeenCalled();
      expect(track.localAsset).toBeNull();
    });

    it('should clear online assets on disconnect', async () => {
      const track = new NoLagTrack('test-token');
      await track.connect();

      track.disconnect();

      expect(track.getOnlineAssets()).toEqual([]);
    });
  });

  describe('getOnlineAssets', () => {
    it('should return empty array initially', async () => {
      const track = new NoLagTrack('test-token');
      await track.connect();

      expect(track.getOnlineAssets()).toEqual([]);
    });

    it('should return empty array before connect', () => {
      const track = new NoLagTrack('test-token');
      expect(track.getOnlineAssets()).toEqual([]);
    });
  });
});
