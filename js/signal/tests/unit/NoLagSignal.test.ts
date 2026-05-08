import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock @nolag/js-sdk before importing NoLagSignal
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
  prefix: 'signal/call-room',
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

import { NoLagSignal } from '../../src/NoLagSignal';

describe('NoLagSignal', () => {
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
      const signal = new NoLagSignal('test-token');
      expect(signal.connected).toBe(false);
      expect(signal.localPeer).toBeNull();
    });

    it('should accept optional options', () => {
      const signal = new NoLagSignal('test-token', { debug: false, reconnect: true });
      expect(signal.connected).toBe(false);
    });

    it('should work with no options argument', () => {
      const signal = new NoLagSignal('test-token');
      expect(signal.connected).toBe(false);
      expect(signal.localPeer).toBeNull();
    });
  });

  describe('connect', () => {
    it('should create a NoLag client and connect', async () => {
      const signal = new NoLagSignal('test-token');
      await signal.connect();

      expect(mockClient.connect).toHaveBeenCalled();
      expect(signal.connected).toBe(true);
      expect(signal.localPeer).not.toBeNull();
      expect(signal.localPeer!.actorTokenId).toBe('test-actor-123');
      expect(signal.localPeer!.isLocal).toBe(true);
    });

    it('should assign a stable peerId to local peer', async () => {
      const signal = new NoLagSignal('test-token');
      await signal.connect();

      expect(signal.localPeer!.peerId).toBeDefined();
      expect(typeof signal.localPeer!.peerId).toBe('string');
      expect(signal.localPeer!.peerId.length).toBeGreaterThan(0);
    });

    it('should subscribe to lobby', async () => {
      const signal = new NoLagSignal('test-token');
      await signal.connect();

      expect(mockAppContext.setLobby).toHaveBeenCalledWith('online');
      expect(mockLobbyContext.subscribe).toHaveBeenCalled();
    });

    it('should wire client lifecycle events', async () => {
      const signal = new NoLagSignal('test-token');
      await signal.connect();

      expect(mockClient.on).toHaveBeenCalledWith('connect', expect.any(Function));
      expect(mockClient.on).toHaveBeenCalledWith('disconnect', expect.any(Function));
      expect(mockClient.on).toHaveBeenCalledWith('reconnect', expect.any(Function));
      expect(mockClient.on).toHaveBeenCalledWith('error', expect.any(Function));
    });

    it('should emit connected event', async () => {
      const signal = new NoLagSignal('test-token');
      const handler = vi.fn();
      signal.on('connected', handler);
      await signal.connect();

      expect(handler).toHaveBeenCalled();
    });

    it('should use default app name', async () => {
      const signal = new NoLagSignal('test-token');
      await signal.connect();

      expect(mockClient.setApp).toHaveBeenCalledWith('signal');
    });

    it('should use custom app name when provided', async () => {
      const signal = new NoLagSignal('test-token', { appName: 'my-app' });
      await signal.connect();

      expect(mockClient.setApp).toHaveBeenCalledWith('my-app');
    });

    it('should attach metadata to local peer', async () => {
      const signal = new NoLagSignal('test-token', { metadata: { role: 'host' } });
      await signal.connect();

      expect(signal.localPeer!.metadata).toEqual({ role: 'host' });
    });
  });

  describe('joinRoom', () => {
    it('should create a SignalRoom and return it', async () => {
      const signal = new NoLagSignal('test-token');
      await signal.connect();

      const room = signal.joinRoom('call-room');

      expect(room).toBeDefined();
      expect(room.name).toBe('call-room');
      expect(mockAppContext.setRoom).toHaveBeenCalledWith('call-room');
    });

    it('should return existing room if already joined (idempotent)', async () => {
      const signal = new NoLagSignal('test-token');
      await signal.connect();

      const room1 = signal.joinRoom('call-room');
      const room2 = signal.joinRoom('call-room');

      expect(room1).toBe(room2);
    });

    it('should throw if not connected', () => {
      const signal = new NoLagSignal('test-token');
      expect(() => signal.joinRoom('call-room')).toThrow('Not connected');
    });

    it('should subscribe to signaling topic', async () => {
      const signal = new NoLagSignal('test-token');
      await signal.connect();

      signal.joinRoom('call-room');

      expect(mockRoomContext.subscribe).toHaveBeenCalledWith('signaling');
    });
  });

  describe('leaveRoom', () => {
    it('should remove the room', async () => {
      const signal = new NoLagSignal('test-token');
      await signal.connect();

      signal.joinRoom('call-room');
      signal.leaveRoom('call-room');

      expect(signal.rooms.size).toBe(0);
    });

    it('should be a no-op for unknown rooms', async () => {
      const signal = new NoLagSignal('test-token');
      await signal.connect();

      expect(() => signal.leaveRoom('nonexistent')).not.toThrow();
    });

    it('should unsubscribe from signaling topic on leave', async () => {
      const signal = new NoLagSignal('test-token');
      await signal.connect();

      signal.joinRoom('call-room');
      signal.leaveRoom('call-room');

      expect(mockRoomContext.unsubscribe).toHaveBeenCalledWith('signaling');
    });
  });

  describe('getRooms', () => {
    it('should return all joined rooms', async () => {
      let callCount = 0;
      mockAppContext.setRoom.mockImplementation(() => {
        callCount++;
        return {
          ...mockRoomContext,
          prefix: `signal/room-${callCount}`,
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

      const signal = new NoLagSignal('test-token');
      await signal.connect();

      signal.joinRoom('room-a');
      signal.joinRoom('room-b');

      expect(signal.getRooms().length).toBe(2);
    });
  });

  describe('disconnect', () => {
    it('should clean up rooms and disconnect client', async () => {
      const signal = new NoLagSignal('test-token');
      await signal.connect();
      signal.joinRoom('call-room');

      signal.disconnect();

      expect(signal.rooms.size).toBe(0);
      expect(mockClient.disconnect).toHaveBeenCalled();
      expect(mockLobbyContext.unsubscribe).toHaveBeenCalled();
      expect(signal.localPeer).toBeNull();
    });

    it('should clear online peers on disconnect', async () => {
      const signal = new NoLagSignal('test-token');
      await signal.connect();

      signal.disconnect();

      expect(signal.getOnlinePeers()).toEqual([]);
    });
  });

  describe('getOnlinePeers', () => {
    it('should return empty array initially', async () => {
      const signal = new NoLagSignal('test-token');
      await signal.connect();

      expect(signal.getOnlinePeers()).toEqual([]);
    });

    it('should return empty array before connect', () => {
      const signal = new NoLagSignal('test-token');
      expect(signal.getOnlinePeers()).toEqual([]);
    });
  });
});
