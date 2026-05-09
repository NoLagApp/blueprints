import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock @nolag/js-sdk before importing NoLagIoT
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
  prefix: 'iot/factory-floor',
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

import { NoLagIoT } from '../../src/NoLagIoT';

describe('NoLagIoT', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockClient.connected = false;
    mockClient.connect.mockImplementation(async () => {
      mockClient.connected = true;
    });
    mockLobbyContext.subscribe.mockResolvedValue({});
    mockRoomContext.fetchPresence.mockResolvedValue([]);
    mockAppContext.setRoom.mockReturnValue(mockRoomContext);
    mockAppContext.setLobby.mockReturnValue(mockLobbyContext);
    mockClient.setApp.mockReturnValue(mockAppContext);
  });

  describe('constructor', () => {
    it('should accept token and options', () => {
      const iot = new NoLagIoT('test-token');
      expect(iot.connected).toBe(false);
      expect(iot.localDevice).toBeNull();
    });

    it('should work with no options', () => {
      const iot = new NoLagIoT('test-token');
      expect(iot.connected).toBe(false);
    });

    it('should accept optional options', () => {
      const iot = new NoLagIoT('test-token', { debug: false, reconnect: true, role: 'controller' });
      expect(iot.connected).toBe(false);
    });

    it('should use provided deviceId', async () => {
      const iot = new NoLagIoT('test-token', { deviceId: 'my-sensor-01' });
      await iot.connect();
      expect(iot.localDevice!.deviceId).toBe('my-sensor-01');
    });

    it('should generate a deviceId when not provided', async () => {
      const iot = new NoLagIoT('test-token');
      await iot.connect();
      expect(iot.localDevice!.deviceId).toBeDefined();
      expect(typeof iot.localDevice!.deviceId).toBe('string');
    });
  });

  describe('connect', () => {
    it('should create a NoLag client and connect', async () => {
      const iot = new NoLagIoT('test-token');
      await iot.connect();

      expect(mockClient.connect).toHaveBeenCalled();
      expect(iot.connected).toBe(true);
      expect(iot.localDevice).not.toBeNull();
      expect(iot.localDevice!.actorTokenId).toBe('test-actor-123');
      expect(iot.localDevice!.isLocal).toBe(true);
    });

    it('should set role on local device', async () => {
      const iot = new NoLagIoT('test-token', { role: 'controller' });
      await iot.connect();
      expect(iot.localDevice!.role).toBe('controller');
    });

    it('should default role to device', async () => {
      const iot = new NoLagIoT('test-token');
      await iot.connect();
      expect(iot.localDevice!.role).toBe('device');
    });

    it('should attach metadata to local device', async () => {
      const iot = new NoLagIoT('test-token', { metadata: { location: 'factory-A' } });
      await iot.connect();
      expect(iot.localDevice!.metadata).toEqual({ location: 'factory-A' });
    });

    it('should subscribe to lobby', async () => {
      const iot = new NoLagIoT('test-token');
      await iot.connect();

      expect(mockAppContext.setLobby).toHaveBeenCalledWith('online');
      expect(mockLobbyContext.subscribe).toHaveBeenCalled();
    });

    it('should wire client lifecycle events', async () => {
      const iot = new NoLagIoT('test-token');
      await iot.connect();

      expect(mockClient.on).toHaveBeenCalledWith('connect', expect.any(Function));
      expect(mockClient.on).toHaveBeenCalledWith('disconnect', expect.any(Function));
      expect(mockClient.on).toHaveBeenCalledWith('reconnect', expect.any(Function));
      expect(mockClient.on).toHaveBeenCalledWith('error', expect.any(Function));
    });

    it('should emit connected event', async () => {
      const iot = new NoLagIoT('test-token');
      const handler = vi.fn();
      iot.on('connected', handler);
      await iot.connect();

      expect(handler).toHaveBeenCalled();
    });

    it('should use default app name', async () => {
      const iot = new NoLagIoT('test-token');
      await iot.connect();

      expect(mockClient.setApp).toHaveBeenCalledWith('iot');
    });

    it('should use custom app name when provided', async () => {
      const iot = new NoLagIoT('test-token', { appName: 'my-iot-app' });
      await iot.connect();

      expect(mockClient.setApp).toHaveBeenCalledWith('my-iot-app');
    });

    it('should auto-join configured groups', async () => {
      const iot = new NoLagIoT('test-token', { groups: ['factory-floor'] });
      await iot.connect();

      expect(iot.groups.size).toBe(1);
      expect(iot.groups.has('factory-floor')).toBe(true);
    });
  });

  describe('joinGroup', () => {
    it('should create a DeviceGroup and return it', async () => {
      const iot = new NoLagIoT('test-token');
      await iot.connect();

      const group = iot.joinGroup('factory-floor');

      expect(group).toBeDefined();
      expect(group.name).toBe('factory-floor');
      expect(mockAppContext.setRoom).toHaveBeenCalledWith('factory-floor');
    });

    it('should return existing group if already joined (idempotent)', async () => {
      const iot = new NoLagIoT('test-token');
      await iot.connect();

      const group1 = iot.joinGroup('factory-floor');
      const group2 = iot.joinGroup('factory-floor');

      expect(group1).toBe(group2);
    });

    it('should throw if not connected', () => {
      const iot = new NoLagIoT('test-token');
      expect(() => iot.joinGroup('factory-floor')).toThrow('Not connected');
    });

    it('should subscribe to telemetry, commands and _cmd_ack topics', async () => {
      const iot = new NoLagIoT('test-token');
      await iot.connect();

      iot.joinGroup('factory-floor');

      expect(mockRoomContext.subscribe).toHaveBeenCalledWith('telemetry');
      // Device subscribes to commands with its deviceId as filter
      expect(mockRoomContext.subscribe).toHaveBeenCalledWith('commands', { filters: [iot.localDevice!.deviceId] });
      expect(mockRoomContext.subscribe).toHaveBeenCalledWith('_cmd_ack');
    });
  });

  describe('leaveGroup', () => {
    it('should remove the group', async () => {
      const iot = new NoLagIoT('test-token');
      await iot.connect();

      iot.joinGroup('factory-floor');
      iot.leaveGroup('factory-floor');

      expect(iot.groups.size).toBe(0);
    });

    it('should be a no-op for unknown groups', async () => {
      const iot = new NoLagIoT('test-token');
      await iot.connect();

      expect(() => iot.leaveGroup('nonexistent')).not.toThrow();
    });

    it('should unsubscribe from topics on leave', async () => {
      const iot = new NoLagIoT('test-token');
      await iot.connect();

      iot.joinGroup('factory-floor');
      iot.leaveGroup('factory-floor');

      expect(mockRoomContext.unsubscribe).toHaveBeenCalledWith('telemetry');
      expect(mockRoomContext.unsubscribe).toHaveBeenCalledWith('commands');
      expect(mockRoomContext.unsubscribe).toHaveBeenCalledWith('_cmd_ack');
    });
  });

  describe('getGroups', () => {
    it('should return all joined groups', async () => {
      let callCount = 0;
      mockAppContext.setRoom.mockImplementation(() => {
        callCount++;
        return {
          ...mockRoomContext,
          prefix: `iot/group-${callCount}`,
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

      const iot = new NoLagIoT('test-token');
      await iot.connect();

      iot.joinGroup('group-a');
      iot.joinGroup('group-b');

      expect(iot.getGroups().length).toBe(2);
    });
  });

  describe('disconnect', () => {
    it('should clean up groups and disconnect client', async () => {
      const iot = new NoLagIoT('test-token');
      await iot.connect();
      iot.joinGroup('factory-floor');

      iot.disconnect();

      expect(iot.groups.size).toBe(0);
      expect(mockClient.disconnect).toHaveBeenCalled();
      expect(mockLobbyContext.unsubscribe).toHaveBeenCalled();
      expect(iot.localDevice).toBeNull();
    });

    it('should clear online devices on disconnect', async () => {
      const iot = new NoLagIoT('test-token');
      await iot.connect();

      iot.disconnect();

      expect(iot.getOnlineDevices()).toEqual([]);
    });
  });

  describe('getOnlineDevices', () => {
    it('should return empty array initially', async () => {
      const iot = new NoLagIoT('test-token');
      await iot.connect();

      expect(iot.getOnlineDevices()).toEqual([]);
    });

    it('should return empty array before connect', () => {
      const iot = new NoLagIoT('test-token');
      expect(iot.getOnlineDevices()).toEqual([]);
    });
  });

  describe('device name', () => {
    it('should attach deviceName to local device when provided', async () => {
      const iot = new NoLagIoT('test-token', { deviceName: 'Temperature Sensor A' });
      await iot.connect();
      expect(iot.localDevice!.deviceName).toBe('Temperature Sensor A');
    });

    it('should leave deviceName undefined when not provided', async () => {
      const iot = new NoLagIoT('test-token');
      await iot.connect();
      expect(iot.localDevice!.deviceName).toBeUndefined();
    });
  });

  describe('EventEmitter surface', () => {
    it('should support on/off for lifecycle events', async () => {
      const iot = new NoLagIoT('test-token');
      const handler = vi.fn();

      iot.on('connected', handler);
      await iot.connect();
      expect(handler).toHaveBeenCalledTimes(1);

      iot.off('connected', handler);
      // No way to re-trigger connected in unit test, just ensure no throw
    });

    it('should count listeners correctly', () => {
      const iot = new NoLagIoT('test-token');
      const h1 = vi.fn();
      const h2 = vi.fn();

      iot.on('error', h1);
      iot.on('error', h2);
      expect(iot.listenerCount('error')).toBe(2);

      iot.off('error', h1);
      expect(iot.listenerCount('error')).toBe(1);
    });
  });
});
