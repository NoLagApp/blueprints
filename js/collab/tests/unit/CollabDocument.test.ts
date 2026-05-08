import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CollabDocument } from '../../src/CollabDocument';
import type { CollabUser, ResolvedCollabOptions, CollabPresenceData } from '../../src/types';
import type { RoomContext, MessageHandler } from '@nolag/js-sdk';

// Mock RoomContext
function createMockRoomContext(): RoomContext & {
  _handlers: Map<string, MessageHandler>;
  _fireMessage: (topic: string, data: unknown) => void;
} {
  const handlers = new Map<string, MessageHandler>();
  const ctx: any = {
    prefix: 'collab/my-doc',
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
    getPresence: vi.fn(() => ({})),
    fetchPresence: vi.fn(() => Promise.resolve([])),
    _fireMessage(topic: string, data: unknown) {
      const h = handlers.get(topic);
      if (h) h(data, {});
    },
  };
  return ctx;
}

function createLocalUser(): CollabUser {
  return {
    userId: 'local-user-id',
    actorTokenId: 'local-actor',
    username: 'Alice',
    color: '#ff0000',
    status: 'active',
    joinedAt: Date.now(),
    isLocal: true,
  };
}

function createOptions(): ResolvedCollabOptions {
  return {
    username: 'Alice',
    appName: 'collab',
    maxOperationCache: 1000,
    idleTimeout: 60000,
    cursorThrottle: 50,
    debug: false,
    reconnect: true,
    documents: [],
  };
}

const noop = () => {};

describe('CollabDocument', () => {
  let doc: CollabDocument;
  let ctx: ReturnType<typeof createMockRoomContext>;

  beforeEach(() => {
    vi.useFakeTimers();
    ctx = createMockRoomContext();
    doc = new CollabDocument('my-doc', ctx, createLocalUser(), createOptions(), noop);
  });

  afterEach(() => {
    doc._cleanup();
    vi.useRealTimers();
  });

  describe('_subscribe', () => {
    it('should subscribe to operations and cursors topics', () => {
      doc._subscribe();
      expect(ctx.subscribe).toHaveBeenCalledWith('operations');
      expect(ctx.subscribe).toHaveBeenCalledWith('_cursors');
    });

    it('should register message handlers for both topics', () => {
      doc._subscribe();
      expect(ctx.on).toHaveBeenCalledWith('operations', expect.any(Function));
      expect(ctx.on).toHaveBeenCalledWith('_cursors', expect.any(Function));
    });
  });

  describe('sendOperation', () => {
    it('should emit the operation on the operations topic with echo: false', () => {
      doc._subscribe();
      doc.sendOperation('insert', { position: 0, content: 'Hello' });

      expect(ctx.emit).toHaveBeenCalledWith(
        'operations',
        expect.objectContaining({
          type: 'insert',
          position: 0,
          content: 'Hello',
          userId: 'local-user-id',
          username: 'Alice',
          isReplay: false,
        }),
        { echo: false },
      );
    });

    it('should return the created operation', () => {
      doc._subscribe();
      const op = doc.sendOperation('delete', { position: 5, length: 3 });

      expect(op.id).toBeDefined();
      expect(op.type).toBe('delete');
      expect(op.position).toBe(5);
      expect(op.length).toBe(3);
      expect(op.isReplay).toBe(false);
    });

    it('should include a unique id and timestamp', () => {
      doc._subscribe();
      const op1 = doc.sendOperation('insert');
      const op2 = doc.sendOperation('insert');

      expect(op1.id).not.toBe(op2.id);
      expect(typeof op1.timestamp).toBe('number');
    });

    it('should store the operation in the operation cache', () => {
      doc._subscribe();
      doc.sendOperation('insert', { content: 'a' });
      doc.sendOperation('insert', { content: 'b' });

      expect(doc.getOperations().length).toBe(2);
    });
  });

  describe('incoming operations', () => {
    it('should emit "operation" event for incoming operations', () => {
      doc._subscribe();
      const handler = vi.fn();
      doc.on('operation', handler);

      ctx._fireMessage('operations', {
        id: 'remote-op-1',
        type: 'insert',
        userId: 'user-b',
        username: 'Bob',
        position: 10,
        content: 'Hi',
        timestamp: Date.now(),
        isReplay: false,
      });

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'remote-op-1',
          type: 'insert',
          userId: 'user-b',
        }),
      );
    });

    it('should deduplicate incoming operations', () => {
      doc._subscribe();
      const handler = vi.fn();
      doc.on('operation', handler);

      const op = {
        id: 'dup-op',
        type: 'insert',
        userId: 'user-b',
        username: 'Bob',
        timestamp: Date.now(),
        isReplay: false,
      };

      ctx._fireMessage('operations', op);
      ctx._fireMessage('operations', op);

      expect(handler).toHaveBeenCalledTimes(1);
    });
  });

  describe('updateCursor', () => {
    it('should emit cursor on _cursors topic', () => {
      doc._subscribe();
      doc.updateCursor({ x: 50, y: 100 });

      expect(ctx.emit).toHaveBeenCalledWith(
        '_cursors',
        expect.objectContaining({
          userId: 'local-user-id',
          username: 'Alice',
          x: 50,
          y: 100,
        }),
        { echo: false },
      );
    });

    it('should throttle cursor updates', () => {
      doc._subscribe();
      doc.updateCursor({ x: 1 });
      doc.updateCursor({ x: 2 });
      doc.updateCursor({ x: 3 });

      // Only one emit should have happened immediately
      expect(ctx.emit).toHaveBeenCalledTimes(1);

      // After throttle window, the last pending update flushes
      vi.advanceTimersByTime(50);
      expect(ctx.emit).toHaveBeenCalledTimes(2);
      const lastCall = ctx.emit.mock.calls[1];
      expect(lastCall[1].x).toBe(3);
    });
  });

  describe('getCursors', () => {
    it('should return remote cursors (not local)', () => {
      doc._subscribe();

      ctx._fireMessage('_cursors', {
        userId: 'user-b',
        username: 'Bob',
        x: 10,
        y: 20,
        timestamp: Date.now(),
      });

      const cursors = doc.getCursors();
      expect(cursors.length).toBe(1);
      expect(cursors[0].userId).toBe('user-b');
    });

    it('should emit cursorMoved for incoming cursor updates', () => {
      doc._subscribe();
      const handler = vi.fn();
      doc.on('cursorMoved', handler);

      ctx._fireMessage('_cursors', {
        userId: 'user-b',
        username: 'Bob',
        x: 10,
        y: 20,
        timestamp: Date.now(),
      });

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'user-b', x: 10, y: 20 }),
      );
    });

    it('should ignore own cursor echo', () => {
      doc._subscribe();
      const handler = vi.fn();
      doc.on('cursorMoved', handler);

      ctx._fireMessage('_cursors', {
        userId: 'local-user-id',
        username: 'Alice',
        x: 5,
        y: 5,
        timestamp: Date.now(),
      });

      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe('setStatus', () => {
    it('should update presence with new status', () => {
      doc._subscribe();
      doc.setStatus('idle');

      expect(ctx.setPresence).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'idle' }),
      );
    });
  });

  describe('presence events', () => {
    it('should emit userJoined on _handlePresenceJoin', () => {
      doc._subscribe();
      const handler = vi.fn();
      doc.on('userJoined', handler);

      const presence: CollabPresenceData = {
        userId: 'user-b',
        username: 'Bob',
        status: 'active',
      };
      doc._handlePresenceJoin('actor-b', presence);

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'user-b',
          username: 'Bob',
          isLocal: false,
        }),
      );
    });

    it('should emit userLeft on _handlePresenceLeave', () => {
      doc._subscribe();
      const leftHandler = vi.fn();
      doc.on('userLeft', leftHandler);

      const presence: CollabPresenceData = {
        userId: 'user-b',
        username: 'Bob',
        status: 'active',
      };
      doc._handlePresenceJoin('actor-b', presence);
      doc._handlePresenceLeave('actor-b');

      expect(leftHandler).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'user-b' }),
      );
    });

    it('should not emit for self on join', () => {
      doc._subscribe();
      const handler = vi.fn();
      doc.on('userJoined', handler);

      doc._handlePresenceJoin('local-actor', {
        userId: 'local-user-id',
        username: 'Alice',
        status: 'active',
      });

      expect(handler).not.toHaveBeenCalled();
    });

    it('should not emit userLeft for unknown actor', () => {
      doc._subscribe();
      const handler = vi.fn();
      doc.on('userLeft', handler);

      doc._handlePresenceLeave('unknown-actor');

      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe('awarenessChanged', () => {
    it('should emit awarenessChanged when a user goes idle', () => {
      doc._subscribe();
      const handler = vi.fn();
      doc.on('awarenessChanged', handler);

      const presence: CollabPresenceData = {
        userId: 'user-b',
        username: 'Bob',
        status: 'active',
      };
      doc._handlePresenceJoin('actor-b', presence);

      // Simulate idle timeout
      vi.advanceTimersByTime(60000);

      expect(handler).toHaveBeenCalledWith({ userId: 'user-b', status: 'idle' });
    });
  });

  describe('_cleanup', () => {
    it('should unsubscribe from both topics', () => {
      doc._subscribe();
      doc._cleanup();

      expect(ctx.unsubscribe).toHaveBeenCalledWith('operations');
      expect(ctx.unsubscribe).toHaveBeenCalledWith('_cursors');
    });

    it('should remove all event listeners', () => {
      doc._subscribe();
      doc.on('operation', vi.fn());
      doc.on('cursorMoved', vi.fn());
      doc._cleanup();

      expect(doc.listenerCount('operation')).toBe(0);
      expect(doc.listenerCount('cursorMoved')).toBe(0);
    });
  });

  describe('_replayOperations', () => {
    it('should emit replayStart and replayEnd with counts', () => {
      doc._subscribe();
      const startHandler = vi.fn();
      const endHandler = vi.fn();
      doc.on('replayStart', startHandler);
      doc.on('replayEnd', endHandler);

      const ops = [
        { id: 'hist-1', type: 'insert' as const, userId: 'user-b', username: 'Bob', timestamp: Date.now() - 100, isReplay: false },
        { id: 'hist-2', type: 'delete' as const, userId: 'user-b', username: 'Bob', timestamp: Date.now() - 50, isReplay: false },
      ];

      doc._replayOperations(ops);

      expect(startHandler).toHaveBeenCalledWith({ count: 2 });
      expect(endHandler).toHaveBeenCalledWith({ replayed: 2 });
    });

    it('should skip operations already in the store', () => {
      doc._subscribe();
      const opHandler = vi.fn();
      doc.on('operation', opHandler);

      doc.sendOperation('insert', { content: 'existing' });
      const existingId = doc.getOperations()[0].id;

      doc._replayOperations([
        { id: existingId, type: 'insert', userId: 'user-b', username: 'Bob', timestamp: Date.now(), isReplay: false },
      ]);

      // No new operation event for the duplicate
      expect(opHandler).not.toHaveBeenCalled();
    });

    it('should mark replayed operations with isReplay: true', () => {
      doc._subscribe();
      const opHandler = vi.fn();
      doc.on('operation', opHandler);

      doc._replayOperations([
        { id: 'replay-1', type: 'insert', userId: 'user-b', username: 'Bob', timestamp: Date.now(), isReplay: false },
      ]);

      expect(opHandler).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'replay-1', isReplay: true }),
      );
    });
  });
});
