import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QueueRoom } from '../../src/QueueRoom';
import type { ResolvedQueueOptions, QueuePresenceData } from '../../src/types';
import type { RoomContext, MessageHandler } from '@nolag/js-sdk';

// Mock RoomContext
function createMockRoomContext(): RoomContext & {
  _handlers: Map<string, MessageHandler>;
  _fireMessage: (topic: string, data: unknown) => void;
} {
  const handlers = new Map<string, MessageHandler>();
  const ctx: any = {
    prefix: 'queue/image-processing',
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

function createOptions(): ResolvedQueueOptions {
  return {
    workerId: 'local-worker-id',
    role: 'worker',
    concurrency: 2,
    appName: 'queue',
    maxJobCache: 1000,
    debug: false,
    reconnect: true,
    queues: [],
  };
}

const noop = () => {};
const LOCAL_WORKER_ID = 'local-worker-id';

describe('QueueRoom', () => {
  let room: QueueRoom;
  let ctx: ReturnType<typeof createMockRoomContext>;

  beforeEach(() => {
    ctx = createMockRoomContext();
    room = new QueueRoom('image-processing', ctx, LOCAL_WORKER_ID, createOptions(), noop);
    room._setLocalActorId('local-actor-123');
  });

  // ============ _subscribe ============

  describe('_subscribe', () => {
    it('should subscribe to the jobs topic', () => {
      room._subscribe();
      expect(ctx.subscribe).toHaveBeenCalledWith('jobs');
    });

    it('should subscribe to the _progress topic', () => {
      room._subscribe();
      expect(ctx.subscribe).toHaveBeenCalledWith('_progress');
    });

    it('should register message handlers for both topics', () => {
      room._subscribe();
      expect(ctx.on).toHaveBeenCalledWith('jobs', expect.any(Function));
      expect(ctx.on).toHaveBeenCalledWith('_progress', expect.any(Function));
    });
  });

  // ============ addJob ============

  describe('addJob', () => {
    it('should create a job with correct defaults', () => {
      room._subscribe();
      const job = room.addJob({ type: 'resize-image' });

      expect(job.type).toBe('resize-image');
      expect(job.status).toBe('pending');
      expect(job.priority).toBe('normal');
      expect(job.progress).toBe(0);
      expect(job.attempts).toBe(0);
      expect(job.maxAttempts).toBe(3);
      expect(job.createdBy).toBe(LOCAL_WORKER_ID);
      expect(job.isReplay).toBe(false);
      expect(job.id).toBeDefined();
    });

    it('should accept priority and maxAttempts overrides', () => {
      room._subscribe();
      const job = room.addJob({ type: 'send-email', priority: 'high', maxAttempts: 5 });

      expect(job.priority).toBe('high');
      expect(job.maxAttempts).toBe(5);
    });

    it('should emit a jobAdded event', () => {
      room._subscribe();
      const handler = vi.fn();
      room.on('jobAdded', handler);

      const job = room.addJob({ type: 'resize-image' });

      expect(handler).toHaveBeenCalledWith(expect.objectContaining({ id: job.id }));
    });

    it('should publish to the jobs topic via room context', () => {
      room._subscribe();
      const job = room.addJob({ type: 'resize-image' });

      expect(ctx.emit).toHaveBeenCalledWith(
        'jobs',
        expect.objectContaining({ event: 'jobAdded', job: expect.objectContaining({ id: job.id }) }),
        { echo: true },
      );
    });

    it('should store the job in the job store', () => {
      room._subscribe();
      const job = room.addJob({ type: 'resize-image' });

      expect(room.getJob(job.id)).toBeDefined();
    });

    it('should increment pendingCount', () => {
      room._subscribe();
      expect(room.pendingCount).toBe(0);
      room.addJob({ type: 'resize-image' });
      expect(room.pendingCount).toBe(1);
    });
  });

  // ============ claimJob ============

  describe('claimJob', () => {
    it('should transition job to claimed status', () => {
      room._subscribe();
      const job = room.addJob({ type: 'resize-image' });

      const claimed = room.claimJob(job.id);
      expect(claimed).not.toBeNull();
      expect(claimed!.status).toBe('claimed');
      expect(claimed!.claimedBy).toBe(LOCAL_WORKER_ID);
    });

    it('should emit a jobClaimed event', () => {
      room._subscribe();
      const job = room.addJob({ type: 'resize-image' });
      const handler = vi.fn();
      room.on('jobClaimed', handler);

      room.claimJob(job.id);

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({ id: job.id, status: 'claimed' }),
      );
    });

    it('should return null for unknown job ID', () => {
      room._subscribe();
      expect(room.claimJob('nonexistent')).toBeNull();
    });

    it('should return null when job is not in pending status', () => {
      room._subscribe();
      const job = room.addJob({ type: 'resize-image' });
      room.claimJob(job.id); // now claimed

      expect(room.claimJob(job.id)).toBeNull(); // can't claim again
    });
  });

  // ============ reportProgress ============

  describe('reportProgress', () => {
    it('should update job progress', () => {
      room._subscribe();
      const job = room.addJob({ type: 'resize-image' });
      room.claimJob(job.id);

      room.reportProgress(job.id, 50);

      expect(room.getJob(job.id)!.progress).toBe(50);
    });

    it('should emit a jobProgress event', () => {
      room._subscribe();
      const job = room.addJob({ type: 'resize-image' });
      const handler = vi.fn();
      room.on('jobProgress', handler);

      room.reportProgress(job.id, 75);

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          jobId: job.id,
          progress: 75,
          workerId: LOCAL_WORKER_ID,
        }),
      );
    });

    it('should publish to _progress topic', () => {
      room._subscribe();
      const job = room.addJob({ type: 'resize-image' });

      room.reportProgress(job.id, 30);

      expect(ctx.emit).toHaveBeenCalledWith(
        '_progress',
        expect.objectContaining({ jobId: job.id, progress: 30 }),
        { echo: true },
      );
    });
  });

  // ============ completeJob ============

  describe('completeJob', () => {
    it('should mark a claimed job as completed', () => {
      room._subscribe();
      const job = room.addJob({ type: 'resize-image' });
      room.claimJob(job.id);

      const completed = room.completeJob(job.id, { output: 'thumbnail.jpg' });

      expect(completed).not.toBeNull();
      expect(completed!.status).toBe('completed');
      expect(completed!.result).toEqual({ output: 'thumbnail.jpg' });
      expect(completed!.completedAt).toBeDefined();
    });

    it('should emit a jobCompleted event', () => {
      room._subscribe();
      const job = room.addJob({ type: 'resize-image' });
      room.claimJob(job.id);
      const handler = vi.fn();
      room.on('jobCompleted', handler);

      room.completeJob(job.id);

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({ id: job.id, status: 'completed' }),
      );
    });

    it('should return null for unknown job ID', () => {
      room._subscribe();
      expect(room.completeJob('nonexistent')).toBeNull();
    });
  });

  // ============ failJob ============

  describe('failJob', () => {
    it('should mark a claimed job as failed', () => {
      room._subscribe();
      const job = room.addJob({ type: 'resize-image' });
      room.claimJob(job.id);

      const failed = room.failJob(job.id, 'Out of memory');

      expect(failed).not.toBeNull();
      expect(failed!.status).toBe('failed');
      expect(failed!.error).toBe('Out of memory');
      expect(failed!.attempts).toBe(1);
    });

    it('should emit a jobFailed event', () => {
      room._subscribe();
      const job = room.addJob({ type: 'resize-image' });
      room.claimJob(job.id);
      const handler = vi.fn();
      room.on('jobFailed', handler);

      room.failJob(job.id, 'error');

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({ id: job.id, status: 'failed' }),
      );
    });

    it('should auto-retry when attempts < maxAttempts', () => {
      room._subscribe();
      const job = room.addJob({ type: 'resize-image', maxAttempts: 3 });
      room.claimJob(job.id);
      const retryHandler = vi.fn();
      room.on('jobRetrying', retryHandler);

      room.failJob(job.id, 'transient error');

      expect(retryHandler).toHaveBeenCalledWith(
        expect.objectContaining({ id: job.id, status: 'pending' }),
      );
    });

    it('should not retry when attempts >= maxAttempts', () => {
      room._subscribe();
      const job = room.addJob({ type: 'resize-image', maxAttempts: 1 });
      room.claimJob(job.id);
      const retryHandler = vi.fn();
      room.on('jobRetrying', retryHandler);

      room.failJob(job.id, 'permanent error');

      expect(retryHandler).not.toHaveBeenCalled();
    });

    it('should return null for unknown job ID', () => {
      room._subscribe();
      expect(room.failJob('nonexistent')).toBeNull();
    });
  });

  // ============ getJob / getJobs ============

  describe('getJob / getJobs', () => {
    it('should return a job by ID', () => {
      room._subscribe();
      const job = room.addJob({ type: 'resize-image' });

      expect(room.getJob(job.id)).toBeDefined();
      expect(room.getJob(job.id)!.id).toBe(job.id);
    });

    it('should return undefined for unknown ID', () => {
      expect(room.getJob('nope')).toBeUndefined();
    });

    it('should return all jobs via getJobs', () => {
      room._subscribe();
      room.addJob({ type: 'resize-image' });
      room.addJob({ type: 'send-email' });

      expect(room.getJobs().length).toBe(2);
    });

    it('should filter jobs by status', () => {
      room._subscribe();
      const j1 = room.addJob({ type: 'resize-image' });
      room.addJob({ type: 'send-email' });
      room.claimJob(j1.id);

      expect(room.getJobs({ status: 'pending' }).length).toBe(1);
      expect(room.getJobs({ status: 'claimed' }).length).toBe(1);
    });
  });

  // ============ pendingCount / activeCount ============

  describe('pendingCount / activeCount', () => {
    it('should count pending jobs', () => {
      room._subscribe();
      room.addJob({ type: 'a' });
      room.addJob({ type: 'b' });
      expect(room.pendingCount).toBe(2);
    });

    it('should count active jobs', () => {
      room._subscribe();
      expect(room.activeCount).toBe(0);
    });
  });

  // ============ Incoming messages ============

  describe('incoming job messages', () => {
    it('should handle incoming jobAdded message', () => {
      room._subscribe();
      const handler = vi.fn();
      room.on('jobAdded', handler);

      const now = Date.now();
      ctx._fireMessage('jobs', {
        event: 'jobAdded',
        job: {
          id: 'remote-j1',
          type: 'resize',
          status: 'pending',
          priority: 'normal',
          progress: 0,
          attempts: 0,
          maxAttempts: 3,
          createdBy: 'remote-worker',
          createdAt: now,
          updatedAt: now,
          isReplay: false,
        },
      });

      expect(handler).toHaveBeenCalledWith(expect.objectContaining({ id: 'remote-j1' }));
      expect(room.getJob('remote-j1')).toBeDefined();
    });

    it('should not duplicate jobs received twice (dedup)', () => {
      room._subscribe();

      const now = Date.now();
      const msg = {
        event: 'jobAdded',
        job: {
          id: 'remote-j1',
          type: 'resize',
          status: 'pending',
          priority: 'normal',
          progress: 0,
          attempts: 0,
          maxAttempts: 3,
          createdBy: 'remote-worker',
          createdAt: now,
          updatedAt: now,
          isReplay: false,
        },
      };

      ctx._fireMessage('jobs', msg);
      ctx._fireMessage('jobs', msg);

      expect(room.getJobs().length).toBe(1);
    });

    it('should handle incoming progress message', () => {
      room._subscribe();
      const job = room.addJob({ type: 'resize-image' });
      const handler = vi.fn();
      room.on('jobProgress', handler);

      ctx._fireMessage('_progress', {
        jobId: job.id,
        progress: 66,
        workerId: 'remote-worker',
        timestamp: Date.now(),
      });

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({ jobId: job.id, progress: 66 }),
      );
    });
  });

  // ============ Presence events ============

  describe('presence events', () => {
    it('should emit workerJoined on _handlePresenceJoin', () => {
      room._subscribe();
      const handler = vi.fn();
      room.on('workerJoined', handler);

      const presence: QueuePresenceData = {
        workerId: 'remote-w1',
        role: 'worker',
        activeJobs: 0,
        concurrency: 2,
      };

      room._handlePresenceJoin('actor-remote', presence);

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({ workerId: 'remote-w1', role: 'worker' }),
      );
    });

    it('should emit workerLeft on _handlePresenceLeave', () => {
      room._subscribe();
      const joinHandler = vi.fn();
      const leaveHandler = vi.fn();
      room.on('workerJoined', joinHandler);
      room.on('workerLeft', leaveHandler);

      const presence: QueuePresenceData = {
        workerId: 'remote-w1',
        role: 'worker',
        activeJobs: 0,
        concurrency: 2,
      };

      room._handlePresenceJoin('actor-remote', presence);
      room._handlePresenceLeave('actor-remote');

      expect(leaveHandler).toHaveBeenCalledWith(
        expect.objectContaining({ workerId: 'remote-w1' }),
      );
    });

    it('should not emit for self (local actor)', () => {
      room._subscribe();
      const handler = vi.fn();
      room.on('workerJoined', handler);

      const presence: QueuePresenceData = {
        workerId: 'local-worker-id',
        role: 'worker',
        activeJobs: 0,
        concurrency: 2,
      };

      room._handlePresenceJoin('local-actor-123', presence);

      expect(handler).not.toHaveBeenCalled();
    });

    it('should not emit workerLeft for unknown actor', () => {
      room._subscribe();
      const handler = vi.fn();
      room.on('workerLeft', handler);

      room._handlePresenceLeave('unknown-actor');

      expect(handler).not.toHaveBeenCalled();
    });
  });

  // ============ _cleanup ============

  describe('_cleanup', () => {
    it('should unsubscribe from both topics', () => {
      room._subscribe();
      room._cleanup();

      expect(ctx.unsubscribe).toHaveBeenCalledWith('jobs');
      expect(ctx.unsubscribe).toHaveBeenCalledWith('_progress');
    });

    it('should remove off handlers for both topics', () => {
      room._subscribe();
      room._cleanup();

      expect(ctx.off).toHaveBeenCalledWith('jobs');
      expect(ctx.off).toHaveBeenCalledWith('_progress');
    });

    it('should remove all event listeners', () => {
      room._subscribe();
      room.on('jobAdded', vi.fn());
      room._cleanup();

      expect(room.listenerCount('jobAdded')).toBe(0);
    });
  });
});
