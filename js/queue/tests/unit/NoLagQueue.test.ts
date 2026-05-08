import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock @nolag/js-sdk before importing NoLagQueue
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
  prefix: 'queue/image-processing',
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

import { NoLagQueue } from '../../src/NoLagQueue';

describe('NoLagQueue', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockClient.connected = false;
    mockClient.connect.mockImplementation(async () => {
      mockClient.connected = true;
    });
    mockLobbyContext.subscribe.mockResolvedValue({});
    mockRoomContext.fetchPresence.mockResolvedValue([]);
    mockClient.setApp.mockReturnValue(mockAppContext);
    mockAppContext.setRoom.mockReturnValue(mockRoomContext);
    mockAppContext.setLobby.mockReturnValue(mockLobbyContext);
  });

  // ============ constructor ============

  describe('constructor', () => {
    it('should accept token and options', () => {
      const queue = new NoLagQueue('test-token');
      expect(queue.connected).toBe(false);
      expect(queue.localWorker).toBeNull();
    });

    it('should work with no options argument', () => {
      const queue = new NoLagQueue('test-token');
      expect(queue.connected).toBe(false);
      expect(queue.localWorker).toBeNull();
    });

    it('should accept custom workerId', () => {
      const queue = new NoLagQueue('test-token', { workerId: 'my-worker' });
      expect(queue.connected).toBe(false);
    });
  });

  // ============ connect ============

  describe('connect', () => {
    it('should create a NoLag client and connect', async () => {
      const queue = new NoLagQueue('test-token');
      await queue.connect();

      expect(mockClient.connect).toHaveBeenCalled();
      expect(queue.connected).toBe(true);
      expect(queue.localWorker).not.toBeNull();
      expect(queue.localWorker!.actorTokenId).toBe('test-actor-123');
      expect(queue.localWorker!.isLocal).toBe(true);
    });

    it('should assign a stable workerId to local worker', async () => {
      const queue = new NoLagQueue('test-token', { workerId: 'my-stable-id' });
      await queue.connect();

      expect(queue.localWorker!.workerId).toBe('my-stable-id');
    });

    it('should auto-generate workerId when not provided', async () => {
      const queue = new NoLagQueue('test-token');
      await queue.connect();

      expect(queue.localWorker!.workerId).toBeDefined();
      expect(typeof queue.localWorker!.workerId).toBe('string');
      expect(queue.localWorker!.workerId.length).toBeGreaterThan(0);
    });

    it('should set default role to monitor', async () => {
      const queue = new NoLagQueue('test-token');
      await queue.connect();

      expect(queue.localWorker!.role).toBe('monitor');
    });

    it('should apply custom role', async () => {
      const queue = new NoLagQueue('test-token', { role: 'producer' });
      await queue.connect();

      expect(queue.localWorker!.role).toBe('producer');
    });

    it('should apply concurrency setting', async () => {
      const queue = new NoLagQueue('test-token', { role: 'worker', concurrency: 4 });
      await queue.connect();

      expect(queue.localWorker!.concurrency).toBe(4);
    });

    it('should subscribe to lobby', async () => {
      const queue = new NoLagQueue('test-token');
      await queue.connect();

      expect(mockAppContext.setLobby).toHaveBeenCalledWith('online');
      expect(mockLobbyContext.subscribe).toHaveBeenCalled();
    });

    it('should wire client lifecycle events', async () => {
      const queue = new NoLagQueue('test-token');
      await queue.connect();

      expect(mockClient.on).toHaveBeenCalledWith('connect', expect.any(Function));
      expect(mockClient.on).toHaveBeenCalledWith('disconnect', expect.any(Function));
      expect(mockClient.on).toHaveBeenCalledWith('reconnect', expect.any(Function));
      expect(mockClient.on).toHaveBeenCalledWith('error', expect.any(Function));
    });

    it('should emit connected event', async () => {
      const queue = new NoLagQueue('test-token');
      const handler = vi.fn();
      queue.on('connected', handler);
      await queue.connect();

      expect(handler).toHaveBeenCalled();
    });

    it('should use default app name', async () => {
      const queue = new NoLagQueue('test-token');
      await queue.connect();

      expect(mockClient.setApp).toHaveBeenCalledWith('queue');
    });

    it('should use custom app name when provided', async () => {
      const queue = new NoLagQueue('test-token', { appName: 'my-app' });
      await queue.connect();

      expect(mockClient.setApp).toHaveBeenCalledWith('my-app');
    });

    it('should attach metadata to local worker', async () => {
      const queue = new NoLagQueue('test-token', { metadata: { env: 'prod' } });
      await queue.connect();

      expect(queue.localWorker!.metadata).toEqual({ env: 'prod' });
    });
  });

  // ============ joinQueue ============

  describe('joinQueue', () => {
    it('should create a QueueRoom and return it', async () => {
      const queue = new NoLagQueue('test-token');
      await queue.connect();

      const room = queue.joinQueue('image-processing');

      expect(room).toBeDefined();
      expect(room.name).toBe('image-processing');
      expect(mockAppContext.setRoom).toHaveBeenCalledWith('image-processing');
    });

    it('should return existing room if already joined (idempotent)', async () => {
      const queue = new NoLagQueue('test-token');
      await queue.connect();

      const room1 = queue.joinQueue('image-processing');
      const room2 = queue.joinQueue('image-processing');

      expect(room1).toBe(room2);
    });

    it('should throw if not connected', () => {
      const queue = new NoLagQueue('test-token');
      expect(() => queue.joinQueue('image-processing')).toThrow('Not connected');
    });

    it('should subscribe to jobs topic', async () => {
      const queue = new NoLagQueue('test-token');
      await queue.connect();

      queue.joinQueue('image-processing');

      expect(mockRoomContext.subscribe).toHaveBeenCalledWith('jobs');
    });

    it('should subscribe to _progress topic', async () => {
      const queue = new NoLagQueue('test-token');
      await queue.connect();

      queue.joinQueue('image-processing');

      expect(mockRoomContext.subscribe).toHaveBeenCalledWith('_progress');
    });
  });

  // ============ leaveQueue ============

  describe('leaveQueue', () => {
    it('should remove the queue room', async () => {
      const queue = new NoLagQueue('test-token');
      await queue.connect();

      queue.joinQueue('image-processing');
      queue.leaveQueue('image-processing');

      expect(queue.queues.size).toBe(0);
    });

    it('should be a no-op for unknown queues', async () => {
      const queue = new NoLagQueue('test-token');
      await queue.connect();

      expect(() => queue.leaveQueue('nonexistent')).not.toThrow();
    });

    it('should unsubscribe from both topics on leave', async () => {
      const queue = new NoLagQueue('test-token');
      await queue.connect();

      queue.joinQueue('image-processing');
      queue.leaveQueue('image-processing');

      expect(mockRoomContext.unsubscribe).toHaveBeenCalledWith('jobs');
      expect(mockRoomContext.unsubscribe).toHaveBeenCalledWith('_progress');
    });
  });

  // ============ getQueues ============

  describe('getQueues', () => {
    it('should return all joined queue rooms', async () => {
      let callCount = 0;
      mockAppContext.setRoom.mockImplementation(() => {
        callCount++;
        return {
          ...mockRoomContext,
          prefix: `queue/room-${callCount}`,
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

      const queue = new NoLagQueue('test-token');
      await queue.connect();

      queue.joinQueue('queue-a');
      queue.joinQueue('queue-b');

      expect(queue.getQueues().length).toBe(2);
    });
  });

  // ============ disconnect ============

  describe('disconnect', () => {
    it('should clean up rooms and disconnect client', async () => {
      const queue = new NoLagQueue('test-token');
      await queue.connect();
      queue.joinQueue('image-processing');

      queue.disconnect();

      expect(queue.queues.size).toBe(0);
      expect(mockClient.disconnect).toHaveBeenCalled();
      expect(mockLobbyContext.unsubscribe).toHaveBeenCalled();
      expect(queue.localWorker).toBeNull();
    });

    it('should clear online workers on disconnect', async () => {
      const queue = new NoLagQueue('test-token');
      await queue.connect();

      queue.disconnect();

      expect(queue.getOnlineWorkers()).toEqual([]);
    });
  });

  // ============ getOnlineWorkers ============

  describe('getOnlineWorkers', () => {
    it('should return empty array initially', async () => {
      const queue = new NoLagQueue('test-token');
      await queue.connect();

      expect(queue.getOnlineWorkers()).toEqual([]);
    });

    it('should return empty array before connect', () => {
      const queue = new NoLagQueue('test-token');
      expect(queue.getOnlineWorkers()).toEqual([]);
    });
  });
});
