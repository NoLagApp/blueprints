import { describe, it, expect, beforeEach } from 'vitest';
import { WorkerManager } from '../../src/WorkerManager';
import type { QueueWorker } from '../../src/types';

function makeWorker(overrides: Partial<QueueWorker> = {}): QueueWorker {
  return {
    workerId: 'worker-' + Math.random().toString(36).slice(2, 6),
    actorTokenId: 'actor-' + Math.random().toString(36).slice(2, 6),
    role: 'worker',
    activeJobs: 0,
    concurrency: 2,
    joinedAt: Date.now(),
    isLocal: false,
    ...overrides,
  };
}

describe('WorkerManager', () => {
  let manager: WorkerManager;

  beforeEach(() => {
    manager = new WorkerManager();
  });

  // ============ addWorker ============

  describe('addWorker', () => {
    it('should add a worker', () => {
      const w = makeWorker({ workerId: 'w1' });
      manager.addWorker(w);

      expect(manager.getWorker('w1')).toBeDefined();
      expect(manager.getWorker('w1')!.workerId).toBe('w1');
    });

    it('should replace an existing worker on re-add', () => {
      manager.addWorker(makeWorker({ workerId: 'w1', activeJobs: 0 }));
      manager.addWorker(makeWorker({ workerId: 'w1', activeJobs: 1 }));

      expect(manager.getAll().length).toBe(1);
      expect(manager.getWorker('w1')!.activeJobs).toBe(1);
    });
  });

  // ============ removeWorker ============

  describe('removeWorker', () => {
    it('should remove a worker and return it', () => {
      const w = makeWorker({ workerId: 'w1' });
      manager.addWorker(w);

      const removed = manager.removeWorker('w1');
      expect(removed).not.toBeNull();
      expect(removed!.workerId).toBe('w1');
      expect(manager.getWorker('w1')).toBeUndefined();
    });

    it('should return null for unknown worker ID', () => {
      expect(manager.removeWorker('nonexistent')).toBeNull();
    });
  });

  // ============ getWorker ============

  describe('getWorker', () => {
    it('should return the worker by ID', () => {
      manager.addWorker(makeWorker({ workerId: 'w1', role: 'producer' }));
      expect(manager.getWorker('w1')!.role).toBe('producer');
    });

    it('should return undefined for missing worker', () => {
      expect(manager.getWorker('nope')).toBeUndefined();
    });
  });

  // ============ getAll ============

  describe('getAll', () => {
    it('should return all workers', () => {
      manager.addWorker(makeWorker({ workerId: 'w1' }));
      manager.addWorker(makeWorker({ workerId: 'w2' }));
      manager.addWorker(makeWorker({ workerId: 'w3' }));

      const all = manager.getAll();
      expect(all.length).toBe(3);
      expect(all.map(w => w.workerId).sort()).toEqual(['w1', 'w2', 'w3']);
    });

    it('should return empty array when no workers', () => {
      expect(manager.getAll()).toEqual([]);
    });
  });

  // ============ incrementActiveJobs ============

  describe('incrementActiveJobs', () => {
    it('should increment activeJobs', () => {
      manager.addWorker(makeWorker({ workerId: 'w1', activeJobs: 0 }));

      const updated = manager.incrementActiveJobs('w1');
      expect(updated).not.toBeNull();
      expect(updated!.activeJobs).toBe(1);
      expect(manager.getWorker('w1')!.activeJobs).toBe(1);
    });

    it('should increment multiple times', () => {
      manager.addWorker(makeWorker({ workerId: 'w1', activeJobs: 0 }));
      manager.incrementActiveJobs('w1');
      manager.incrementActiveJobs('w1');

      expect(manager.getWorker('w1')!.activeJobs).toBe(2);
    });

    it('should return null for unknown worker', () => {
      expect(manager.incrementActiveJobs('nope')).toBeNull();
    });
  });

  // ============ decrementActiveJobs ============

  describe('decrementActiveJobs', () => {
    it('should decrement activeJobs', () => {
      manager.addWorker(makeWorker({ workerId: 'w1', activeJobs: 2 }));

      const updated = manager.decrementActiveJobs('w1');
      expect(updated!.activeJobs).toBe(1);
    });

    it('should not go below 0 (floor)', () => {
      manager.addWorker(makeWorker({ workerId: 'w1', activeJobs: 0 }));

      const updated = manager.decrementActiveJobs('w1');
      expect(updated!.activeJobs).toBe(0);
    });

    it('should return null for unknown worker', () => {
      expect(manager.decrementActiveJobs('nope')).toBeNull();
    });
  });

  // ============ canAcceptWork ============

  describe('canAcceptWork', () => {
    it('should return true when activeJobs < concurrency', () => {
      manager.addWorker(makeWorker({ workerId: 'w1', activeJobs: 1, concurrency: 2 }));
      expect(manager.canAcceptWork('w1')).toBe(true);
    });

    it('should return false when activeJobs === concurrency', () => {
      manager.addWorker(makeWorker({ workerId: 'w1', activeJobs: 2, concurrency: 2 }));
      expect(manager.canAcceptWork('w1')).toBe(false);
    });

    it('should return false when activeJobs > concurrency', () => {
      manager.addWorker(makeWorker({ workerId: 'w1', activeJobs: 3, concurrency: 2 }));
      expect(manager.canAcceptWork('w1')).toBe(false);
    });

    it('should return false for unknown worker', () => {
      expect(manager.canAcceptWork('nope')).toBe(false);
    });

    it('should reflect incremented active jobs', () => {
      manager.addWorker(makeWorker({ workerId: 'w1', activeJobs: 0, concurrency: 1 }));
      expect(manager.canAcceptWork('w1')).toBe(true);

      manager.incrementActiveJobs('w1');
      expect(manager.canAcceptWork('w1')).toBe(false);
    });

    it('should reflect decremented active jobs', () => {
      manager.addWorker(makeWorker({ workerId: 'w1', activeJobs: 1, concurrency: 1 }));
      expect(manager.canAcceptWork('w1')).toBe(false);

      manager.decrementActiveJobs('w1');
      expect(manager.canAcceptWork('w1')).toBe(true);
    });
  });

  // ============ clear ============

  describe('clear', () => {
    it('should remove all workers', () => {
      manager.addWorker(makeWorker({ workerId: 'w1' }));
      manager.addWorker(makeWorker({ workerId: 'w2' }));

      manager.clear();

      expect(manager.getAll().length).toBe(0);
      expect(manager.getWorker('w1')).toBeUndefined();
    });
  });
});
