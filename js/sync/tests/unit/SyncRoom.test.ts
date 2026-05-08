import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SyncRoom } from '../../src/SyncRoom';
import type { SyncCollaborator, ResolvedSyncOptions, SyncPresenceData, SyncChange } from '../../src/types';
import type { RoomContext, MessageHandler } from '@nolag/js-sdk';

// Mock RoomContext
function createMockRoomContext(): RoomContext & {
  _handlers: Map<string, MessageHandler>;
  _fireMessage: (topic: string, data: unknown) => void;
} {
  const handlers = new Map<string, MessageHandler>();
  const ctx: any = {
    prefix: 'sync/todos',
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

function createLocalCollaborator(): SyncCollaborator {
  return {
    userId: 'local-user-id',
    actorTokenId: 'local-actor',
    username: 'Alice',
    joinedAt: Date.now(),
    isLocal: true,
  };
}

function createOptions(): ResolvedSyncOptions {
  return {
    userId: 'local-user-id',
    appName: 'sync',
    debug: false,
    reconnect: true,
    collections: [],
  };
}

const noop = () => {};

describe('SyncRoom', () => {
  let room: SyncRoom;
  let ctx: ReturnType<typeof createMockRoomContext>;

  beforeEach(() => {
    ctx = createMockRoomContext();
    room = new SyncRoom('todos', ctx, createLocalCollaborator(), createOptions(), noop);
  });

  // ============ _subscribe ============

  describe('_subscribe', () => {
    it('should subscribe to the changes topic', () => {
      room._subscribe();
      expect(ctx.subscribe).toHaveBeenCalledWith('changes');
    });

    it('should listen for change messages', () => {
      room._subscribe();
      expect(ctx.on).toHaveBeenCalledWith('changes', expect.any(Function));
    });
  });

  // ============ createDocument ============

  describe('createDocument', () => {
    it('should create a document with version 1', () => {
      room._subscribe();
      const doc = room.createDocument('todo-1', { text: 'Hello', done: false });

      expect(doc.id).toBe('todo-1');
      expect(doc.version).toBe(1);
      expect(doc.data).toEqual({ text: 'Hello', done: false });
      expect(doc.deleted).toBe(false);
    });

    it('should publish a create change', () => {
      room._subscribe();
      room.createDocument('todo-1', { text: 'Hello' });

      expect(ctx.emit).toHaveBeenCalledWith(
        'changes',
        expect.objectContaining({
          type: 'create',
          documentId: 'todo-1',
          version: 1,
          updatedBy: 'local-user-id',
        }),
        { echo: false },
      );
    });

    it('should emit documentCreated and localChange events', () => {
      room._subscribe();
      const createdHandler = vi.fn();
      const localChangeHandler = vi.fn();
      room.on('documentCreated', createdHandler);
      room.on('localChange', localChangeHandler);

      room.createDocument('todo-1', { text: 'Hello' });

      expect(createdHandler).toHaveBeenCalledTimes(1);
      expect(localChangeHandler).toHaveBeenCalledTimes(1);
      expect(createdHandler).toHaveBeenCalledWith(expect.objectContaining({ id: 'todo-1' }));
    });
  });

  // ============ updateDocument ============

  describe('updateDocument', () => {
    it('should update an existing document', () => {
      room._subscribe();
      room.createDocument('todo-1', { text: 'Hello', done: false });
      const doc = room.updateDocument('todo-1', { done: true });

      expect(doc).not.toBeNull();
      expect(doc!.version).toBe(2);
      expect(doc!.data.done).toBe(true);
      expect(doc!.data.text).toBe('Hello');
    });

    it('should return null for non-existent document', () => {
      room._subscribe();
      const doc = room.updateDocument('nonexistent', { text: 'Hi' });
      expect(doc).toBeNull();
    });

    it('should publish an update change', () => {
      room._subscribe();
      room.createDocument('todo-1', { text: 'Hello' });
      room.updateDocument('todo-1', { text: 'Updated' });

      const calls = ctx.emit.mock.calls;
      const updateCall = calls.find((c: any) => c[1]?.type === 'update');
      expect(updateCall).toBeDefined();
      expect(updateCall[1]).toMatchObject({ type: 'update', documentId: 'todo-1', fields: { text: 'Updated' } });
    });

    it('should emit documentUpdated and localChange events', () => {
      room._subscribe();
      room.createDocument('todo-1', { text: 'Hello' });

      const updatedHandler = vi.fn();
      const localChangeHandler = vi.fn();
      room.on('documentUpdated', updatedHandler);
      room.on('localChange', localChangeHandler);

      room.updateDocument('todo-1', { done: true });

      expect(updatedHandler).toHaveBeenCalledTimes(1);
      expect(localChangeHandler).toHaveBeenCalledTimes(1);
    });
  });

  // ============ deleteDocument ============

  describe('deleteDocument', () => {
    it('should soft-delete a document', () => {
      room._subscribe();
      room.createDocument('todo-1', { text: 'Hello' });
      const doc = room.deleteDocument('todo-1');

      expect(doc).not.toBeNull();
      expect(doc!.deleted).toBe(true);
      expect(doc!.version).toBe(2);
    });

    it('should return null for non-existent document', () => {
      room._subscribe();
      const doc = room.deleteDocument('nonexistent');
      expect(doc).toBeNull();
    });

    it('should publish a delete change', () => {
      room._subscribe();
      room.createDocument('todo-1', { text: 'Hello' });
      room.deleteDocument('todo-1');

      const calls = ctx.emit.mock.calls;
      const deleteCall = calls.find((c: any) => c[1]?.type === 'delete');
      expect(deleteCall).toBeDefined();
      expect(deleteCall[1]).toMatchObject({ type: 'delete', documentId: 'todo-1' });
    });

    it('should emit documentDeleted and localChange events', () => {
      room._subscribe();
      room.createDocument('todo-1', { text: 'Hello' });

      const deletedHandler = vi.fn();
      const localChangeHandler = vi.fn();
      room.on('documentDeleted', deletedHandler);
      room.on('localChange', localChangeHandler);

      room.deleteDocument('todo-1');

      expect(deletedHandler).toHaveBeenCalledTimes(1);
      expect(localChangeHandler).toHaveBeenCalledTimes(1);
    });
  });

  // ============ getDocument / getAllDocuments ============

  describe('getDocument', () => {
    it('should return a document by id', () => {
      room._subscribe();
      room.createDocument('todo-1', { text: 'Hello' });
      const doc = room.getDocument('todo-1');
      expect(doc).toBeDefined();
      expect(doc!.id).toBe('todo-1');
    });

    it('should return undefined for unknown id', () => {
      room._subscribe();
      expect(room.getDocument('nonexistent')).toBeUndefined();
    });
  });

  describe('getAllDocuments', () => {
    it('should return all non-deleted documents', () => {
      room._subscribe();
      room.createDocument('todo-1', { text: 'A' });
      room.createDocument('todo-2', { text: 'B' });
      room.deleteDocument('todo-1');

      const all = room.getAllDocuments();
      expect(all.length).toBe(1);
      expect(all[0].id).toBe('todo-2');
    });

    it('should return empty array initially', () => {
      room._subscribe();
      expect(room.getAllDocuments()).toEqual([]);
    });
  });

  // ============ Incoming remote changes ============

  describe('incoming remote changes', () => {
    it('should emit documentCreated for a remote create change', () => {
      room._subscribe();
      const handler = vi.fn();
      room.on('documentCreated', handler);

      const change: SyncChange = {
        id: 'c1',
        documentId: 'doc-remote',
        type: 'create',
        fields: { text: 'From remote' },
        version: 1,
        updatedBy: 'remote-user',
        timestamp: Date.now(),
        optimistic: false,
        isReplay: false,
      };
      ctx._fireMessage('changes', change);

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(expect.objectContaining({ id: 'doc-remote' }));
    });

    it('should emit documentUpdated for a remote update change', () => {
      room._subscribe();
      room.createDocument('doc-1', { text: 'Hello', count: 0 });

      const handler = vi.fn();
      room.on('documentUpdated', handler);

      const change: SyncChange = {
        id: 'c2',
        documentId: 'doc-1',
        type: 'update',
        fields: { count: 10 },
        version: 2,
        updatedBy: 'remote-user',
        timestamp: Date.now() + 100,
        optimistic: false,
        isReplay: false,
      };
      ctx._fireMessage('changes', change);

      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('should emit documentDeleted for a remote delete change', () => {
      room._subscribe();
      room.createDocument('doc-1', { text: 'Hello' });

      const handler = vi.fn();
      room.on('documentDeleted', handler);

      const change: SyncChange = {
        id: 'c3',
        documentId: 'doc-1',
        type: 'delete',
        version: 2,
        updatedBy: 'remote-user',
        timestamp: Date.now() + 100,
        optimistic: false,
        isReplay: false,
      };
      ctx._fireMessage('changes', change);

      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('should emit synced for any accepted remote change', () => {
      room._subscribe();
      const handler = vi.fn();
      room.on('synced', handler);

      const change: SyncChange = {
        id: 'c4',
        documentId: 'new-doc',
        type: 'create',
        fields: { x: 1 },
        version: 1,
        updatedBy: 'remote-user',
        timestamp: Date.now(),
        optimistic: false,
        isReplay: false,
      };
      ctx._fireMessage('changes', change);

      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('should ignore changes from the local user (echo suppression)', () => {
      room._subscribe();
      const handler = vi.fn();
      room.on('documentCreated', handler);

      const change: SyncChange = {
        id: 'c5',
        documentId: 'doc-local',
        type: 'create',
        fields: { text: 'My own change' },
        version: 1,
        updatedBy: 'local-user-id', // same as options.userId
        timestamp: Date.now(),
        optimistic: true,
        isReplay: false,
      };
      ctx._fireMessage('changes', change);

      expect(handler).not.toHaveBeenCalled();
    });

    it('should emit conflict when versions clash', () => {
      room._subscribe();
      room.createDocument('doc-1', { text: 'Local' });
      // update locally to version 2
      room.updateDocument('doc-1', { text: 'Local v2' });

      const conflictHandler = vi.fn();
      room.on('conflict', conflictHandler);

      // Remote also at version 2, same timestamp tie-break
      const change: SyncChange = {
        id: 'c6',
        documentId: 'doc-1',
        type: 'update',
        fields: { text: 'Remote v2' },
        version: 2,
        updatedBy: 'remote-user',
        timestamp: Date.now() + 1000, // remote is newer → remote wins
        optimistic: false,
        isReplay: false,
      };
      ctx._fireMessage('changes', change);

      expect(conflictHandler).toHaveBeenCalledTimes(1);
      const conflict = conflictHandler.mock.calls[0][0];
      expect(conflict.documentId).toBe('doc-1');
      expect(conflict.resolved).toBeDefined();
    });
  });

  // ============ Presence events ============

  describe('presence events', () => {
    it('should emit collaboratorJoined on _handlePresenceJoin', () => {
      room._subscribe();
      const handler = vi.fn();
      room.on('collaboratorJoined', handler);

      room._handlePresenceJoin('actor-remote', { userId: 'remote-user', username: 'Bob' });

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'remote-user', username: 'Bob', isLocal: false }),
      );
    });

    it('should emit collaboratorLeft on _handlePresenceLeave', () => {
      room._subscribe();
      const joinHandler = vi.fn();
      const leaveHandler = vi.fn();
      room.on('collaboratorJoined', joinHandler);
      room.on('collaboratorLeft', leaveHandler);

      room._handlePresenceJoin('actor-remote', { userId: 'remote-user' });
      room._handlePresenceLeave('actor-remote');

      expect(leaveHandler).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'remote-user' }),
      );
    });

    it('should not emit for self', () => {
      room._subscribe();
      const handler = vi.fn();
      room.on('collaboratorJoined', handler);

      room._handlePresenceJoin('local-actor', { userId: 'local-user-id' });

      expect(handler).not.toHaveBeenCalled();
    });

    it('should not emit collaboratorLeft for unknown actor', () => {
      room._subscribe();
      const handler = vi.fn();
      room.on('collaboratorLeft', handler);

      room._handlePresenceLeave('unknown-actor');

      expect(handler).not.toHaveBeenCalled();
    });
  });

  // ============ _cleanup ============

  describe('_cleanup', () => {
    it('should unsubscribe from changes topic', () => {
      room._subscribe();
      room._cleanup();

      expect(ctx.unsubscribe).toHaveBeenCalledWith('changes');
      expect(ctx.off).toHaveBeenCalledWith('changes');
    });

    it('should remove all event listeners', () => {
      room._subscribe();
      room.on('documentCreated', vi.fn());
      room._cleanup();

      expect(room.listenerCount('documentCreated')).toBe(0);
    });

    it('should clear all documents', () => {
      room._subscribe();
      room.createDocument('doc-1', { text: 'Hello' });
      room._cleanup();

      expect(room.getAllDocuments()).toEqual([]);
    });
  });
});
