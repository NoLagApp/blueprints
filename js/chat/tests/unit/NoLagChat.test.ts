import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock @nolag/js-sdk before importing NoLagChat
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
  prefix: 'chat/general',
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
    // Reset connected state for each call
    mockClient.connected = false;
    mockClient.connect.mockImplementation(async () => {
      mockClient.connected = true;
    });
    return mockClient;
  }),
}));

import { NoLagChat } from '../../src/NoLagChat';

describe('NoLagChat', () => {
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
      const chat = new NoLagChat('test-token', { username: 'Alice' });
      expect(chat.connected).toBe(false);
      expect(chat.localUser).toBeNull();
    });
  });

  describe('connect', () => {
    it('should create a NoLag client and connect', async () => {
      const chat = new NoLagChat('test-token', { username: 'Alice' });
      await chat.connect();

      expect(mockClient.connect).toHaveBeenCalled();
      expect(chat.connected).toBe(true);
      expect(chat.localUser).not.toBeNull();
      expect(chat.localUser!.username).toBe('Alice');
      expect(chat.localUser!.actorTokenId).toBe('test-actor-123');
    });

    it('should subscribe to lobby', async () => {
      const chat = new NoLagChat('test-token', { username: 'Alice' });
      await chat.connect();

      expect(mockAppContext.setLobby).toHaveBeenCalledWith('online');
      expect(mockLobbyContext.subscribe).toHaveBeenCalled();
    });

    it('should wire client lifecycle events', async () => {
      const chat = new NoLagChat('test-token', { username: 'Alice' });
      await chat.connect();

      // Should register handlers for connect, disconnect, reconnect, error
      expect(mockClient.on).toHaveBeenCalledWith('connect', expect.any(Function));
      expect(mockClient.on).toHaveBeenCalledWith('disconnect', expect.any(Function));
      expect(mockClient.on).toHaveBeenCalledWith('reconnect', expect.any(Function));
      expect(mockClient.on).toHaveBeenCalledWith('error', expect.any(Function));
    });

    it('should emit connected event', async () => {
      const chat = new NoLagChat('test-token', { username: 'Alice' });
      const handler = vi.fn();
      chat.on('connected', handler);
      await chat.connect();

      // Find the connect handler and call it
      const connectCall = mockClient.on.mock.calls.find(
        (call: any[]) => call[0] === 'connect',
      );
      if (connectCall) connectCall[1]();

      expect(handler).toHaveBeenCalled();
    });
  });

  describe('joinRoom', () => {
    it('should create a ChatRoom and return it', async () => {
      const chat = new NoLagChat('test-token', { username: 'Alice' });
      await chat.connect();

      const room = chat.joinRoom('general');

      expect(room).toBeDefined();
      expect(room.name).toBe('general');
      expect(mockAppContext.setRoom).toHaveBeenCalledWith('general');
    });

    it('should return existing room if already joined (idempotent)', async () => {
      const chat = new NoLagChat('test-token', { username: 'Alice' });
      await chat.connect();

      const room1 = chat.joinRoom('general');
      const room2 = chat.joinRoom('general');

      expect(room1).toBe(room2);
    });

    it('should throw if not connected', () => {
      const chat = new NoLagChat('test-token', { username: 'Alice' });

      expect(() => chat.joinRoom('general')).toThrow('Not connected');
    });
  });

  describe('leaveRoom', () => {
    it('should remove the room', async () => {
      const chat = new NoLagChat('test-token', { username: 'Alice' });
      await chat.connect();

      chat.joinRoom('general');
      chat.leaveRoom('general');

      expect(chat.rooms.size).toBe(0);
    });

    it('should be a no-op for unknown rooms', async () => {
      const chat = new NoLagChat('test-token', { username: 'Alice' });
      await chat.connect();

      expect(() => chat.leaveRoom('nonexistent')).not.toThrow();
    });
  });

  describe('getRooms', () => {
    it('should return all joined rooms', async () => {
      // Reset mockAppContext.setRoom to return different contexts
      let callCount = 0;
      mockAppContext.setRoom.mockImplementation(() => {
        callCount++;
        return {
          ...mockRoomContext,
          prefix: `chat/room-${callCount}`,
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

      const chat = new NoLagChat('test-token', { username: 'Alice' });
      await chat.connect();

      chat.joinRoom('general');
      chat.joinRoom('random');

      expect(chat.getRooms().length).toBe(2);
    });
  });

  describe('disconnect', () => {
    it('should clean up rooms and disconnect client', async () => {
      const chat = new NoLagChat('test-token', { username: 'Alice' });
      await chat.connect();
      chat.joinRoom('general');

      chat.disconnect();

      expect(chat.rooms.size).toBe(0);
      expect(mockClient.disconnect).toHaveBeenCalled();
      expect(mockLobbyContext.unsubscribe).toHaveBeenCalled();
      expect(chat.localUser).toBeNull();
    });
  });

  describe('getOnlineUsers', () => {
    it('should return empty array initially', async () => {
      const chat = new NoLagChat('test-token', { username: 'Alice' });
      await chat.connect();

      expect(chat.getOnlineUsers()).toEqual([]);
    });
  });

  describe('setStatus', () => {
    it('should update local user status', async () => {
      const chat = new NoLagChat('test-token', { username: 'Alice' });
      await chat.connect();

      chat.setStatus('away');
      expect(chat.localUser!.status).toBe('away');
    });
  });

  describe('updateProfile', () => {
    it('should update local user profile', async () => {
      const chat = new NoLagChat('test-token', { username: 'Alice' });
      await chat.connect();

      chat.updateProfile({ username: 'Alice2', avatar: 'new.png' });

      expect(chat.localUser!.username).toBe('Alice2');
      expect(chat.localUser!.avatar).toBe('new.png');
    });
  });
});
