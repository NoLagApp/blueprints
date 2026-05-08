import { describe, it, expect, beforeEach } from 'vitest';
import { JobStore } from '../../src/JobStore';
import type { Job } from '../../src/types';

function makeJob(overrides: Partial<Job> = {}): Job {
  const now = Date.now();
  return {
    id: 'job-' + Math.random().toString(36).slice(2, 8),
    type: 'test-job',
    payload: { key: 'value' },
    priority: 'normal',
    status: 'pending',
    progress: 0,
    attempts: 0,
    maxAttempts: 3,
    createdBy: 'worker-1',
    createdAt: now,
    updatedAt: now,
    isReplay: false,
    ...overrides,
  };
}

describe('JobStore', () => {
  let store: JobStore;

  beforeEach(() => {
    store = new JobStore(1000);
  });

  // ============ add ============

  describe('add', () => {
    it('should add a job and return true', () => {
      const job = makeJob({ id: 'j1' });
      expect(store.add(job)).toBe(true);
      expect(store.has('j1')).toBe(true);
    });

    it('should return false for duplicate job IDs (dedup)', () => {
      const job = makeJob({ id: 'j1' });
      expect(store.add(job)).toBe(true);
      expect(store.add(job)).toBe(false);
      expect(store.size).toBe(1);
    });

    it('should evict oldest entry when at capacity', () => {
      const small = new JobStore(2);
      const j1 = makeJob({ id: 'j1' });
      const j2 = makeJob({ id: 'j2' });
      const j3 = makeJob({ id: 'j3' });

      small.add(j1);
      small.add(j2);
      small.add(j3);

      expect(small.size).toBe(2);
      expect(small.has('j1')).toBe(false);
      expect(small.has('j2')).toBe(true);
      expect(small.has('j3')).toBe(true);
    });
  });

  // ============ get ============

  describe('get', () => {
    it('should retrieve a job by ID', () => {
      const job = makeJob({ id: 'j1', type: 'resize' });
      store.add(job);

      const retrieved = store.get('j1');
      expect(retrieved).toBeDefined();
      expect(retrieved!.type).toBe('resize');
    });

    it('should return undefined for unknown IDs', () => {
      expect(store.get('nonexistent')).toBeUndefined();
    });
  });

  // ============ getAll ============

  describe('getAll', () => {
    beforeEach(() => {
      store.add(makeJob({ id: 'j1', type: 'resize', priority: 'high', status: 'pending' }));
      store.add(makeJob({ id: 'j2', type: 'email', priority: 'normal', status: 'pending' }));
      store.add(makeJob({ id: 'j3', type: 'resize', priority: 'low', status: 'active' }));
    });

    it('should return all jobs when no filter', () => {
      expect(store.getAll().length).toBe(3);
    });

    it('should filter by status', () => {
      const pending = store.getAll({ status: 'pending' });
      expect(pending.length).toBe(2);
      expect(pending.every(j => j.status === 'pending')).toBe(true);
    });

    it('should filter by type', () => {
      const resize = store.getAll({ type: 'resize' });
      expect(resize.length).toBe(2);
      expect(resize.every(j => j.type === 'resize')).toBe(true);
    });

    it('should filter by priority', () => {
      const high = store.getAll({ priority: 'high' });
      expect(high.length).toBe(1);
      expect(high[0].id).toBe('j1');
    });

    it('should combine multiple filters', () => {
      const result = store.getAll({ type: 'resize', status: 'pending' });
      expect(result.length).toBe(1);
      expect(result[0].id).toBe('j1');
    });

    it('should return empty array when no jobs match filter', () => {
      expect(store.getAll({ status: 'completed' })).toEqual([]);
    });
  });

  // ============ updateStatus ============

  describe('updateStatus', () => {
    it('should transition pending → claimed', () => {
      const job = makeJob({ id: 'j1', status: 'pending' });
      store.add(job);

      const updated = store.updateStatus('j1', 'claimed', { claimedBy: 'worker-1' });
      expect(updated).not.toBeNull();
      expect(updated!.status).toBe('claimed');
      expect(updated!.claimedBy).toBe('worker-1');
    });

    it('should transition claimed → active', () => {
      const job = makeJob({ id: 'j1', status: 'claimed' });
      store.add(job);

      const updated = store.updateStatus('j1', 'active');
      expect(updated!.status).toBe('active');
    });

    it('should transition active → completed', () => {
      const job = makeJob({ id: 'j1', status: 'active' });
      store.add(job);

      const updated = store.updateStatus('j1', 'completed', { result: { out: 'done' } });
      expect(updated!.status).toBe('completed');
      expect(updated!.result).toEqual({ out: 'done' });
      expect(updated!.completedAt).toBeDefined();
    });

    it('should transition active → failed', () => {
      const job = makeJob({ id: 'j1', status: 'active' });
      store.add(job);

      const updated = store.updateStatus('j1', 'failed', { error: 'Something went wrong' });
      expect(updated!.status).toBe('failed');
      expect(updated!.error).toBe('Something went wrong');
      expect(updated!.completedAt).toBeDefined();
    });

    it('should transition failed → pending (retry)', () => {
      const job = makeJob({ id: 'j1', status: 'failed' });
      store.add(job);

      const updated = store.updateStatus('j1', 'pending');
      expect(updated!.status).toBe('pending');
    });

    it('should reject invalid transitions (pending → active)', () => {
      const job = makeJob({ id: 'j1', status: 'pending' });
      store.add(job);

      const result = store.updateStatus('j1', 'active');
      expect(result).toBeNull();
      expect(store.get('j1')!.status).toBe('pending');
    });

    it('should reject invalid transitions (pending → completed)', () => {
      const job = makeJob({ id: 'j1', status: 'pending' });
      store.add(job);

      expect(store.updateStatus('j1', 'completed')).toBeNull();
    });

    it('should reject invalid transitions (claimed → pending)', () => {
      const job = makeJob({ id: 'j1', status: 'claimed' });
      store.add(job);

      expect(store.updateStatus('j1', 'pending')).toBeNull();
    });

    it('should return null for unknown job IDs', () => {
      expect(store.updateStatus('nonexistent', 'claimed')).toBeNull();
    });

    it('should update updatedAt timestamp on transition', () => {
      const before = Date.now();
      const job = makeJob({ id: 'j1', status: 'pending', updatedAt: before - 100 });
      store.add(job);

      const updated = store.updateStatus('j1', 'claimed');
      expect(updated!.updatedAt).toBeGreaterThanOrEqual(before);
    });
  });

  // ============ updateProgress ============

  describe('updateProgress', () => {
    it('should update progress percentage', () => {
      const job = makeJob({ id: 'j1' });
      store.add(job);

      const updated = store.updateProgress('j1', 42);
      expect(updated!.progress).toBe(42);
    });

    it('should clamp progress to 0–100', () => {
      const job = makeJob({ id: 'j1' });
      store.add(job);

      expect(store.updateProgress('j1', -10)!.progress).toBe(0);
      expect(store.updateProgress('j1', 150)!.progress).toBe(100);
    });

    it('should return null for unknown job IDs', () => {
      expect(store.updateProgress('nonexistent', 50)).toBeNull();
    });

    it('should update updatedAt timestamp', () => {
      const before = Date.now();
      const job = makeJob({ id: 'j1', updatedAt: before - 100 });
      store.add(job);

      const updated = store.updateProgress('j1', 50);
      expect(updated!.updatedAt).toBeGreaterThanOrEqual(before);
    });
  });

  // ============ pendingCount / activeCount ============

  describe('pendingCount', () => {
    it('should count pending jobs', () => {
      store.add(makeJob({ id: 'j1', status: 'pending' }));
      store.add(makeJob({ id: 'j2', status: 'pending' }));
      store.add(makeJob({ id: 'j3', status: 'active' }));

      expect(store.pendingCount).toBe(2);
    });

    it('should return 0 when no pending jobs', () => {
      store.add(makeJob({ id: 'j1', status: 'active' }));
      expect(store.pendingCount).toBe(0);
    });
  });

  describe('activeCount', () => {
    it('should count active jobs', () => {
      store.add(makeJob({ id: 'j1', status: 'active' }));
      store.add(makeJob({ id: 'j2', status: 'active' }));
      store.add(makeJob({ id: 'j3', status: 'pending' }));

      expect(store.activeCount).toBe(2);
    });

    it('should return 0 when no active jobs', () => {
      store.add(makeJob({ id: 'j1', status: 'pending' }));
      expect(store.activeCount).toBe(0);
    });
  });

  // ============ has / size / clear ============

  describe('has', () => {
    it('should return true for existing jobs', () => {
      store.add(makeJob({ id: 'j1' }));
      expect(store.has('j1')).toBe(true);
    });

    it('should return false for missing jobs', () => {
      expect(store.has('nope')).toBe(false);
    });
  });

  describe('size', () => {
    it('should reflect the number of stored jobs', () => {
      expect(store.size).toBe(0);
      store.add(makeJob({ id: 'j1' }));
      store.add(makeJob({ id: 'j2' }));
      expect(store.size).toBe(2);
    });
  });

  describe('clear', () => {
    it('should remove all jobs', () => {
      store.add(makeJob({ id: 'j1' }));
      store.add(makeJob({ id: 'j2' }));

      store.clear();

      expect(store.size).toBe(0);
      expect(store.has('j1')).toBe(false);
    });
  });
});
