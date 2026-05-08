import { describe, it, expect, beforeEach } from 'vitest';
import { DocumentStore } from '../../src/DocumentStore';
import type { SyncChange } from '../../src/types';

const USER_A = 'user-alice';
const USER_B = 'user-bob';

describe('DocumentStore', () => {
  let store: DocumentStore;

  beforeEach(() => {
    store = new DocumentStore();
  });

  // ============ create ============

  describe('create', () => {
    it('should create a document with version 1', () => {
      const doc = store.create('doc-1', { text: 'Hello' }, USER_A);

      expect(doc.id).toBe('doc-1');
      expect(doc.version).toBe(1);
      expect(doc.data).toEqual({ text: 'Hello' });
      expect(doc.updatedBy).toBe(USER_A);
      expect(doc.deleted).toBe(false);
    });

    it('should set createdAt and updatedAt timestamps', () => {
      const before = Date.now();
      const doc = store.create('doc-1', {}, USER_A);
      const after = Date.now();

      expect(doc.createdAt).toBeGreaterThanOrEqual(before);
      expect(doc.createdAt).toBeLessThanOrEqual(after);
      expect(doc.updatedAt).toBe(doc.createdAt);
    });

    it('should isolate data from the original object', () => {
      const data = { text: 'Original' };
      const doc = store.create('doc-1', data, USER_A);
      data.text = 'Mutated';

      expect(doc.data.text).toBe('Original');
    });

    it('should overwrite an existing document with the same id', () => {
      store.create('doc-1', { text: 'First' }, USER_A);
      const doc = store.create('doc-1', { text: 'Second' }, USER_B);

      expect(doc.version).toBe(1);
      expect(doc.data.text).toBe('Second');
      expect(store.size).toBe(1);
    });
  });

  // ============ update ============

  describe('update', () => {
    it('should increment version and merge fields', () => {
      store.create('doc-1', { text: 'Hello', count: 0 }, USER_A);
      const doc = store.update('doc-1', { count: 1 }, USER_B);

      expect(doc).not.toBeNull();
      expect(doc!.version).toBe(2);
      expect(doc!.data.text).toBe('Hello');
      expect(doc!.data.count).toBe(1);
      expect(doc!.updatedBy).toBe(USER_B);
    });

    it('should return null for a non-existent document', () => {
      const result = store.update('nonexistent', { text: 'Hi' }, USER_A);
      expect(result).toBeNull();
    });

    it('should return null for a deleted document', () => {
      store.create('doc-1', { text: 'Hello' }, USER_A);
      store.delete('doc-1', USER_A);
      const result = store.update('doc-1', { text: 'Updated' }, USER_A);
      expect(result).toBeNull();
    });

    it('should update updatedAt on each call', async () => {
      store.create('doc-1', {}, USER_A);
      const before = Date.now();
      const doc = store.update('doc-1', { x: 1 }, USER_A);
      const after = Date.now();

      expect(doc!.updatedAt).toBeGreaterThanOrEqual(before);
      expect(doc!.updatedAt).toBeLessThanOrEqual(after);
    });
  });

  // ============ delete ============

  describe('delete', () => {
    it('should mark document as deleted and increment version', () => {
      store.create('doc-1', { text: 'Hello' }, USER_A);
      const doc = store.delete('doc-1', USER_B);

      expect(doc).not.toBeNull();
      expect(doc!.deleted).toBe(true);
      expect(doc!.version).toBe(2);
      expect(doc!.updatedBy).toBe(USER_B);
    });

    it('should return null for a non-existent document', () => {
      const result = store.delete('nonexistent', USER_A);
      expect(result).toBeNull();
    });

    it('should be idempotent — deleting an already-deleted document increments version again', () => {
      store.create('doc-1', {}, USER_A);
      store.delete('doc-1', USER_A);
      const doc = store.delete('doc-1', USER_B);

      expect(doc).not.toBeNull();
      expect(doc!.version).toBe(3);
      expect(doc!.deleted).toBe(true);
    });
  });

  // ============ get ============

  describe('get', () => {
    it('should return a document by id', () => {
      store.create('doc-1', { text: 'Hello' }, USER_A);
      const doc = store.get('doc-1');
      expect(doc).toBeDefined();
      expect(doc!.id).toBe('doc-1');
    });

    it('should return undefined for unknown id', () => {
      expect(store.get('nonexistent')).toBeUndefined();
    });

    it('should return soft-deleted documents', () => {
      store.create('doc-1', {}, USER_A);
      store.delete('doc-1', USER_A);
      const doc = store.get('doc-1');
      expect(doc).toBeDefined();
      expect(doc!.deleted).toBe(true);
    });
  });

  // ============ getAll ============

  describe('getAll', () => {
    it('should return all non-deleted documents', () => {
      store.create('doc-1', {}, USER_A);
      store.create('doc-2', {}, USER_A);
      store.create('doc-3', {}, USER_A);
      store.delete('doc-2', USER_A);

      const all = store.getAll();
      expect(all.length).toBe(2);
      expect(all.map(d => d.id).sort()).toEqual(['doc-1', 'doc-3']);
    });

    it('should return empty array when no documents', () => {
      expect(store.getAll()).toEqual([]);
    });
  });

  // ============ applyRemoteChange ============

  describe('applyRemoteChange', () => {
    it('should create a document from a create change', () => {
      const change: SyncChange = {
        id: 'change-1',
        documentId: 'doc-1',
        type: 'create',
        fields: { text: 'From remote' },
        version: 1,
        updatedBy: USER_B,
        timestamp: Date.now(),
        optimistic: false,
        isReplay: false,
      };

      const doc = store.applyRemoteChange(change);
      expect(doc).not.toBeNull();
      expect(doc!.id).toBe('doc-1');
      expect(doc!.version).toBe(1);
      expect(doc!.data.text).toBe('From remote');
      expect(doc!.updatedBy).toBe(USER_B);
    });

    it('should update a document from an update change', () => {
      store.create('doc-1', { text: 'Hello', count: 0 }, USER_A);

      const change: SyncChange = {
        id: 'change-2',
        documentId: 'doc-1',
        type: 'update',
        fields: { count: 5 },
        version: 2,
        updatedBy: USER_B,
        timestamp: Date.now(),
        optimistic: false,
        isReplay: false,
      };

      const doc = store.applyRemoteChange(change);
      expect(doc).not.toBeNull();
      expect(doc!.version).toBe(2);
      expect(doc!.data.text).toBe('Hello');
      expect(doc!.data.count).toBe(5);
    });

    it('should soft-delete a document from a delete change', () => {
      store.create('doc-1', { text: 'Hello' }, USER_A);

      const change: SyncChange = {
        id: 'change-3',
        documentId: 'doc-1',
        type: 'delete',
        version: 2,
        updatedBy: USER_B,
        timestamp: Date.now(),
        optimistic: false,
        isReplay: false,
      };

      const doc = store.applyRemoteChange(change);
      expect(doc).not.toBeNull();
      expect(doc!.deleted).toBe(true);
      expect(doc!.version).toBe(2);
    });

    it('should return null for update on non-existent document', () => {
      const change: SyncChange = {
        id: 'change-4',
        documentId: 'nonexistent',
        type: 'update',
        fields: { text: 'Hi' },
        version: 2,
        updatedBy: USER_B,
        timestamp: Date.now(),
        optimistic: false,
        isReplay: false,
      };

      expect(store.applyRemoteChange(change)).toBeNull();
    });

    it('should return null for delete on non-existent document', () => {
      const change: SyncChange = {
        id: 'change-5',
        documentId: 'nonexistent',
        type: 'delete',
        version: 1,
        updatedBy: USER_B,
        timestamp: Date.now(),
        optimistic: false,
        isReplay: false,
      };

      expect(store.applyRemoteChange(change)).toBeNull();
    });
  });

  // ============ getVersion ============

  describe('getVersion', () => {
    it('should return the current version', () => {
      store.create('doc-1', {}, USER_A);
      expect(store.getVersion('doc-1')).toBe(1);

      store.update('doc-1', { x: 1 }, USER_A);
      expect(store.getVersion('doc-1')).toBe(2);
    });

    it('should return 0 for unknown documents', () => {
      expect(store.getVersion('nonexistent')).toBe(0);
    });
  });

  // ============ has / size / clear ============

  describe('has', () => {
    it('should return true for existing documents', () => {
      store.create('doc-1', {}, USER_A);
      expect(store.has('doc-1')).toBe(true);
    });

    it('should return true for soft-deleted documents', () => {
      store.create('doc-1', {}, USER_A);
      store.delete('doc-1', USER_A);
      expect(store.has('doc-1')).toBe(true);
    });

    it('should return false for unknown documents', () => {
      expect(store.has('nonexistent')).toBe(false);
    });
  });

  describe('size', () => {
    it('should count all documents including deleted', () => {
      store.create('doc-1', {}, USER_A);
      store.create('doc-2', {}, USER_A);
      store.delete('doc-1', USER_A);

      expect(store.size).toBe(2);
    });
  });

  describe('clear', () => {
    it('should remove all documents', () => {
      store.create('doc-1', {}, USER_A);
      store.create('doc-2', {}, USER_A);
      store.clear();

      expect(store.size).toBe(0);
      expect(store.getAll()).toEqual([]);
    });
  });
});
