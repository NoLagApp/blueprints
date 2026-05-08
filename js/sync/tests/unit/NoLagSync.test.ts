import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock @nolag/js-sdk before importing NoLagSync
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
  prefix: 'sync/todos',
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

import { NoLagSync } from '../../src/NoLagSync';

describe('NoLagSync', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockClient.connected = false;
    mockClient.connect.mockImplementation(async () => {
      mockClient.connected = true;
    });
    mockLobbyContext.subscribe.mockResolvedValue({});
    mockRoomContext.fetchPresence.mockResolvedValue([]);
  });

  // ============ constructor ============

  describe('constructor', () => {
    it('should accept token and options', () => {
      const sync = new NoLagSync('test-token');
      expect(sync.connected).toBe(false);
      expect(sync.localCollaborator).toBeNull();
    });

    it('should accept optional options', () => {
      const sync = new NoLagSync('test-token', { debug: false, reconnect: true });
      expect(sync.connected).toBe(false);
    });

    it('should work with no options argument', () => {
      const sync = new NoLagSync('test-token');
      expect(sync.connected).toBe(false);
      expect(sync.localCollaborator).toBeNull();
    });

    it('should generate a userId if not provided', async () => {
      const sync = new NoLagSync('test-token');
      await sync.connect();
      expect(sync.localCollaborator!.userId).toBeDefined();
      expect(typeof sync.localCollaborator!.userId).toBe('string');
    });

    it('should use the provided userId', async () => {
      const sync = new NoLagSync('test-token', { userId: 'my-stable-id' });
      await sync.connect();
      expect(sync.localCollaborator!.userId).toBe('my-stable-id');
    });
  });

  // ============ connect ============

  describe('connect', () => {
    it('should create a NoLag client and connect', async () => {
      const sync = new NoLagSync('test-token');
      await sync.connect();

      expect(mockClient.connect).toHaveBeenCalled();
      expect(sync.connected).toBe(true);
      expect(sync.localCollaborator).not.toBeNull();
      expect(sync.localCollaborator!.actorTokenId).toBe('test-actor-123');
      expect(sync.localCollaborator!.isLocal).toBe(true);
    });

    it('should subscribe to lobby', async () => {
      const sync = new NoLagSync('test-token');
      await sync.connect();

      expect(mockAppContext.setLobby).toHaveBeenCalledWith('online');
      expect(mockLobbyContext.subscribe).toHaveBeenCalled();
    });

    it('should wire client lifecycle events', async () => {
      const sync = new NoLagSync('test-token');
      await sync.connect();

      expect(mockClient.on).toHaveBeenCalledWith('connect', expect.any(Function));
      expect(mockClient.on).toHaveBeenCalledWith('disconnect', expect.any(Function));
      expect(mockClient.on).toHaveBeenCalledWith('reconnect', expect.any(Function));
      expect(mockClient.on).toHaveBeenCalledWith('error', expect.any(Function));
    });

    it('should emit connected event', async () => {
      const sync = new NoLagSync('test-token');
      const handler = vi.fn();
      sync.on('connected', handler);
      await sync.connect();

      expect(handler).toHaveBeenCalled();
    });

    it('should use default app name "sync"', async () => {
      const sync = new NoLagSync('test-token');
      await sync.connect();

      expect(mockClient.setApp).toHaveBeenCalledWith('sync');
    });

    it('should use custom app name when provided', async () => {
      const sync = new NoLagSync('test-token', { appName: 'my-app' });
      await sync.connect();

      expect(mockClient.setApp).toHaveBeenCalledWith('my-app');
    });

    it('should attach metadata to local collaborator', async () => {
      const sync = new NoLagSync('test-token', { metadata: { role: 'editor' } });
      await sync.connect();

      expect(sync.localCollaborator!.metadata).toEqual({ role: 'editor' });
    });

    it('should attach username to local collaborator', async () => {
      const sync = new NoLagSync('test-token', { username: 'Alice' });
      await sync.connect();

      expect(sync.localCollaborator!.username).toBe('Alice');
    });

    it('should auto-join pre-configured collections', async () => {
      const sync = new NoLagSync('test-token', { collections: ['todos', 'notes'] });
      await sync.connect();

      expect(sync.collections.size).toBe(2);
      expect(sync.collections.has('todos')).toBe(true);
      expect(sync.collections.has('notes')).toBe(true);
    });
  });

  // ============ joinCollection ============

  describe('joinCollection', () => {
    it('should create a SyncRoom and return it', async () => {
      const sync = new NoLagSync('test-token');
      await sync.connect();

      const collection = sync.joinCollection('todos');

      expect(collection).toBeDefined();
      expect(collection.name).toBe('todos');
      expect(mockAppContext.setRoom).toHaveBeenCalledWith('todos');
    });

    it('should return existing collection if already joined (idempotent)', async () => {
      const sync = new NoLagSync('test-token');
      await sync.connect();

      const c1 = sync.joinCollection('todos');
      const c2 = sync.joinCollection('todos');

      expect(c1).toBe(c2);
    });

    it('should throw if not connected', () => {
      const sync = new NoLagSync('test-token');
      expect(() => sync.joinCollection('todos')).toThrow('Not connected');
    });

    it('should subscribe to changes topic', async () => {
      const sync = new NoLagSync('test-token');
      await sync.connect();

      sync.joinCollection('todos');

      expect(mockRoomContext.subscribe).toHaveBeenCalledWith('changes');
    });
  });

  // ============ leaveCollection ============

  describe('leaveCollection', () => {
    it('should remove the collection', async () => {
      const sync = new NoLagSync('test-token');
      await sync.connect();

      sync.joinCollection('todos');
      sync.leaveCollection('todos');

      expect(sync.collections.size).toBe(0);
    });

    it('should be a no-op for unknown collections', async () => {
      const sync = new NoLagSync('test-token');
      await sync.connect();

      expect(() => sync.leaveCollection('nonexistent')).not.toThrow();
    });

    it('should unsubscribe from changes topic on leave', async () => {
      const sync = new NoLagSync('test-token');
      await sync.connect();

      sync.joinCollection('todos');
      sync.leaveCollection('todos');

      expect(mockRoomContext.unsubscribe).toHaveBeenCalledWith('changes');
    });
  });

  // ============ getCollections ============

  describe('getCollections', () => {
    it('should return all joined collections', async () => {
      let callCount = 0;
      mockAppContext.setRoom.mockImplementation(() => {
        callCount++;
        return {
          ...mockRoomContext,
          prefix: `sync/room-${callCount}`,
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

      const sync = new NoLagSync('test-token');
      await sync.connect();

      sync.joinCollection('todos');
      sync.joinCollection('notes');

      expect(sync.getCollections().length).toBe(2);
    });
  });

  // ============ disconnect ============

  describe('disconnect', () => {
    it('should clean up collections and disconnect client', async () => {
      const sync = new NoLagSync('test-token');
      await sync.connect();
      sync.joinCollection('todos');

      sync.disconnect();

      expect(sync.collections.size).toBe(0);
      expect(mockClient.disconnect).toHaveBeenCalled();
      expect(mockLobbyContext.unsubscribe).toHaveBeenCalled();
      expect(sync.localCollaborator).toBeNull();
    });

    it('should clear online collaborators on disconnect', async () => {
      const sync = new NoLagSync('test-token');
      await sync.connect();

      sync.disconnect();

      expect(sync.getCollaborators()).toEqual([]);
    });
  });

  // ============ getCollaborators ============

  describe('getCollaborators', () => {
    it('should return empty array initially', async () => {
      const sync = new NoLagSync('test-token');
      await sync.connect();

      expect(sync.getCollaborators()).toEqual([]);
    });

    it('should return empty array before connect', () => {
      const sync = new NoLagSync('test-token');
      expect(sync.getCollaborators()).toEqual([]);
    });
  });
});
