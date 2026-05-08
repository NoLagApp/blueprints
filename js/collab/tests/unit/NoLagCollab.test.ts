import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock @nolag/js-sdk before importing NoLagCollab
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
  prefix: 'collab/my-doc',
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

import { NoLagCollab } from '../../src/NoLagCollab';

describe('NoLagCollab', () => {
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
      const collab = new NoLagCollab('test-token', { username: 'Alice' });
      expect(collab.connected).toBe(false);
      expect(collab.localUser).toBeNull();
    });

    it('should accept all options', () => {
      const collab = new NoLagCollab('test-token', {
        username: 'Alice',
        avatar: 'https://example.com/avatar.png',
        color: '#ff0000',
        debug: false,
        reconnect: true,
        maxOperationCache: 500,
        idleTimeout: 30000,
        cursorThrottle: 100,
      });
      expect(collab.connected).toBe(false);
    });
  });

  describe('connect', () => {
    it('should create a NoLag client and connect', async () => {
      const collab = new NoLagCollab('test-token', { username: 'Alice' });
      await collab.connect();

      expect(mockClient.connect).toHaveBeenCalled();
      expect(collab.connected).toBe(true);
      expect(collab.localUser).not.toBeNull();
      expect(collab.localUser!.actorTokenId).toBe('test-actor-123');
      expect(collab.localUser!.isLocal).toBe(true);
    });

    it('should assign a stable userId to local user', async () => {
      const collab = new NoLagCollab('test-token', { username: 'Alice' });
      await collab.connect();

      expect(collab.localUser!.userId).toBeDefined();
      expect(typeof collab.localUser!.userId).toBe('string');
      expect(collab.localUser!.userId.length).toBeGreaterThan(0);
    });

    it('should set the username on the local user', async () => {
      const collab = new NoLagCollab('test-token', { username: 'Bob' });
      await collab.connect();

      expect(collab.localUser!.username).toBe('Bob');
    });

    it('should subscribe to lobby', async () => {
      const collab = new NoLagCollab('test-token', { username: 'Alice' });
      await collab.connect();

      expect(mockAppContext.setLobby).toHaveBeenCalledWith('online');
      expect(mockLobbyContext.subscribe).toHaveBeenCalled();
    });

    it('should wire client lifecycle events', async () => {
      const collab = new NoLagCollab('test-token', { username: 'Alice' });
      await collab.connect();

      expect(mockClient.on).toHaveBeenCalledWith('connect', expect.any(Function));
      expect(mockClient.on).toHaveBeenCalledWith('disconnect', expect.any(Function));
      expect(mockClient.on).toHaveBeenCalledWith('reconnect', expect.any(Function));
      expect(mockClient.on).toHaveBeenCalledWith('error', expect.any(Function));
    });

    it('should emit connected event', async () => {
      const collab = new NoLagCollab('test-token', { username: 'Alice' });
      const handler = vi.fn();
      collab.on('connected', handler);
      await collab.connect();

      expect(handler).toHaveBeenCalled();
    });

    it('should use default app name', async () => {
      const collab = new NoLagCollab('test-token', { username: 'Alice' });
      await collab.connect();

      expect(mockClient.setApp).toHaveBeenCalledWith('collab');
    });

    it('should use custom app name when provided', async () => {
      const collab = new NoLagCollab('test-token', { username: 'Alice', appName: 'my-app' });
      await collab.connect();

      expect(mockClient.setApp).toHaveBeenCalledWith('my-app');
    });

    it('should attach metadata to local user', async () => {
      const collab = new NoLagCollab('test-token', {
        username: 'Alice',
        metadata: { role: 'admin' },
      });
      await collab.connect();

      expect(collab.localUser!.metadata).toEqual({ role: 'admin' });
    });

    it('should attach avatar and color to local user', async () => {
      const collab = new NoLagCollab('test-token', {
        username: 'Alice',
        avatar: 'https://example.com/pic.jpg',
        color: '#00ff00',
      });
      await collab.connect();

      expect(collab.localUser!.avatar).toBe('https://example.com/pic.jpg');
      expect(collab.localUser!.color).toBe('#00ff00');
    });

    it('should auto-join documents specified in options', async () => {
      const collab = new NoLagCollab('test-token', {
        username: 'Alice',
        documents: ['doc-a', 'doc-b'],
      });
      await collab.connect();

      expect(collab.documents.size).toBe(2);
      expect(collab.documents.has('doc-a')).toBe(true);
      expect(collab.documents.has('doc-b')).toBe(true);
    });
  });

  describe('joinDocument', () => {
    it('should create a CollabDocument and return it', async () => {
      const collab = new NoLagCollab('test-token', { username: 'Alice' });
      await collab.connect();

      const doc = collab.joinDocument('my-doc');

      expect(doc).toBeDefined();
      expect(doc.name).toBe('my-doc');
      expect(mockAppContext.setRoom).toHaveBeenCalledWith('my-doc');
    });

    it('should return the existing document if already joined (idempotent)', async () => {
      const collab = new NoLagCollab('test-token', { username: 'Alice' });
      await collab.connect();

      const doc1 = collab.joinDocument('my-doc');
      const doc2 = collab.joinDocument('my-doc');

      expect(doc1).toBe(doc2);
    });

    it('should throw if not connected', () => {
      const collab = new NoLagCollab('test-token', { username: 'Alice' });
      expect(() => collab.joinDocument('my-doc')).toThrow('Not connected');
    });

    it('should subscribe to operations and cursors topics', async () => {
      const collab = new NoLagCollab('test-token', { username: 'Alice' });
      await collab.connect();

      collab.joinDocument('my-doc');

      expect(mockRoomContext.subscribe).toHaveBeenCalledWith('operations');
      expect(mockRoomContext.subscribe).toHaveBeenCalledWith('_cursors');
    });
  });

  describe('leaveDocument', () => {
    it('should remove the document', async () => {
      const collab = new NoLagCollab('test-token', { username: 'Alice' });
      await collab.connect();

      collab.joinDocument('my-doc');
      collab.leaveDocument('my-doc');

      expect(collab.documents.size).toBe(0);
    });

    it('should be a no-op for unknown documents', async () => {
      const collab = new NoLagCollab('test-token', { username: 'Alice' });
      await collab.connect();

      expect(() => collab.leaveDocument('nonexistent')).not.toThrow();
    });

    it('should unsubscribe from topics on leave', async () => {
      const collab = new NoLagCollab('test-token', { username: 'Alice' });
      await collab.connect();

      collab.joinDocument('my-doc');
      collab.leaveDocument('my-doc');

      expect(mockRoomContext.unsubscribe).toHaveBeenCalledWith('operations');
      expect(mockRoomContext.unsubscribe).toHaveBeenCalledWith('_cursors');
    });
  });

  describe('getDocuments', () => {
    it('should return all joined documents', async () => {
      let callCount = 0;
      mockAppContext.setRoom.mockImplementation(() => {
        callCount++;
        return {
          ...mockRoomContext,
          prefix: `collab/room-${callCount}`,
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

      const collab = new NoLagCollab('test-token', { username: 'Alice' });
      await collab.connect();

      collab.joinDocument('doc-a');
      collab.joinDocument('doc-b');

      expect(collab.getDocuments().length).toBe(2);
    });
  });

  describe('disconnect', () => {
    it('should clean up documents and disconnect client', async () => {
      const collab = new NoLagCollab('test-token', { username: 'Alice' });
      await collab.connect();
      collab.joinDocument('my-doc');

      collab.disconnect();

      expect(collab.documents.size).toBe(0);
      expect(mockClient.disconnect).toHaveBeenCalled();
      expect(mockLobbyContext.unsubscribe).toHaveBeenCalled();
      expect(collab.localUser).toBeNull();
    });

    it('should clear online users on disconnect', async () => {
      const collab = new NoLagCollab('test-token', { username: 'Alice' });
      await collab.connect();

      collab.disconnect();

      expect(collab.getOnlineUsers()).toEqual([]);
    });
  });

  describe('getOnlineUsers', () => {
    it('should return empty array initially', async () => {
      const collab = new NoLagCollab('test-token', { username: 'Alice' });
      await collab.connect();

      expect(collab.getOnlineUsers()).toEqual([]);
    });

    it('should return empty array before connect', () => {
      const collab = new NoLagCollab('test-token', { username: 'Alice' });
      expect(collab.getOnlineUsers()).toEqual([]);
    });
  });

  describe('event forwarding', () => {
    it('should emit userOnline when a remote user joins via lobby', async () => {
      // Simulate lobby join via client event handler
      let lobbyJoinHandler: ((data: unknown) => void) | null = null;
      mockClient.on.mockImplementation((event: string, handler: (...args: any[]) => void) => {
        if (event === 'lobbyPresence:join') lobbyJoinHandler = handler;
      });

      const collab = new NoLagCollab('test-token', { username: 'Alice' });
      const onlineHandler = vi.fn();
      collab.on('userOnline', onlineHandler);
      await collab.connect();

      lobbyJoinHandler!({
        actorId: 'remote-actor-999',
        data: {
          userId: 'remote-user-999',
          username: 'Remote Bob',
          status: 'active',
        },
      });

      expect(onlineHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'remote-user-999',
          username: 'Remote Bob',
          isLocal: false,
        }),
      );
    });
  });
});
