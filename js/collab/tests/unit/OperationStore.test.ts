import { describe, it, expect } from 'vitest';
import { OperationStore } from '../../src/OperationStore';
import type { CollabOperation } from '../../src/types';

function makeOp(overrides: Partial<CollabOperation> = {}): CollabOperation {
  return {
    id: 'op-' + Math.random().toString(36).slice(2, 8),
    type: 'insert',
    userId: 'user-1',
    username: 'Alice',
    timestamp: Date.now(),
    isReplay: false,
    ...overrides,
  };
}

describe('OperationStore', () => {
  describe('add', () => {
    it('should add an operation and return true', () => {
      const store = new OperationStore(100);
      const op = makeOp({ id: 'op-1' });
      expect(store.add(op)).toBe(true);
      expect(store.size).toBe(1);
    });

    it('should reject duplicate operation IDs and return false', () => {
      const store = new OperationStore(100);
      const op = makeOp({ id: 'op-dup' });
      expect(store.add(op)).toBe(true);
      expect(store.add(op)).toBe(false);
      expect(store.size).toBe(1);
    });

    it('should sort operations by timestamp ascending', () => {
      const store = new OperationStore(100);
      const now = Date.now();
      store.add(makeOp({ id: 'op-c', timestamp: now + 200 }));
      store.add(makeOp({ id: 'op-a', timestamp: now }));
      store.add(makeOp({ id: 'op-b', timestamp: now + 100 }));

      const all = store.getAll();
      expect(all[0].id).toBe('op-a');
      expect(all[1].id).toBe('op-b');
      expect(all[2].id).toBe('op-c');
    });

    it('should evict oldest operations when over capacity', () => {
      const store = new OperationStore(3);
      const now = Date.now();
      store.add(makeOp({ id: 'op-1', timestamp: now }));
      store.add(makeOp({ id: 'op-2', timestamp: now + 1 }));
      store.add(makeOp({ id: 'op-3', timestamp: now + 2 }));

      // Adding a 4th should evict the oldest (op-1)
      store.add(makeOp({ id: 'op-4', timestamp: now + 3 }));

      expect(store.size).toBe(3);
      expect(store.has('op-1')).toBe(false);
      expect(store.has('op-4')).toBe(true);
    });

    it('should evict the evicted op from the id set too', () => {
      const store = new OperationStore(2);
      const now = Date.now();
      const op1 = makeOp({ id: 'evict-me', timestamp: now });
      store.add(op1);
      store.add(makeOp({ id: 'keep-1', timestamp: now + 1 }));
      store.add(makeOp({ id: 'keep-2', timestamp: now + 2 }));

      // evict-me should be evicted; re-adding should succeed
      expect(store.has('evict-me')).toBe(false);
      expect(store.add(op1)).toBe(true);
    });
  });

  describe('getAll', () => {
    it('should return an empty array when empty', () => {
      const store = new OperationStore(100);
      expect(store.getAll()).toEqual([]);
    });

    it('should return a copy, not the internal array', () => {
      const store = new OperationStore(100);
      store.add(makeOp({ id: 'op-1' }));
      const all = store.getAll();
      all.push(makeOp({ id: 'injected' }));
      expect(store.size).toBe(1);
    });
  });

  describe('getByUser', () => {
    it('should return only operations from the specified user', () => {
      const store = new OperationStore(100);
      store.add(makeOp({ id: 'op-a1', userId: 'user-a' }));
      store.add(makeOp({ id: 'op-b1', userId: 'user-b' }));
      store.add(makeOp({ id: 'op-a2', userId: 'user-a' }));

      const userA = store.getByUser('user-a');
      expect(userA.length).toBe(2);
      expect(userA.every((op) => op.userId === 'user-a')).toBe(true);
    });

    it('should return an empty array when no ops match', () => {
      const store = new OperationStore(100);
      store.add(makeOp({ id: 'op-1', userId: 'user-a' }));
      expect(store.getByUser('user-z')).toEqual([]);
    });
  });

  describe('has', () => {
    it('should return true for a stored operation ID', () => {
      const store = new OperationStore(100);
      store.add(makeOp({ id: 'known' }));
      expect(store.has('known')).toBe(true);
    });

    it('should return false for an unknown operation ID', () => {
      const store = new OperationStore(100);
      expect(store.has('unknown')).toBe(false);
    });
  });

  describe('size', () => {
    it('should reflect the number of stored operations', () => {
      const store = new OperationStore(100);
      expect(store.size).toBe(0);
      store.add(makeOp({ id: 'a' }));
      store.add(makeOp({ id: 'b' }));
      expect(store.size).toBe(2);
    });
  });

  describe('clear', () => {
    it('should remove all operations', () => {
      const store = new OperationStore(100);
      store.add(makeOp({ id: 'op-1' }));
      store.add(makeOp({ id: 'op-2' }));
      store.clear();
      expect(store.size).toBe(0);
      expect(store.getAll()).toEqual([]);
    });

    it('should clear the id set so previously seen ops can be re-added', () => {
      const store = new OperationStore(100);
      const op = makeOp({ id: 'reusable' });
      store.add(op);
      store.clear();
      expect(store.add(op)).toBe(true);
      expect(store.size).toBe(1);
    });
  });
});
