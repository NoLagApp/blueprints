import type { RoomContext } from '@nolag/js-sdk';
import { EventEmitter } from './EventEmitter';
import { JobStore } from './JobStore';
import { WorkerManager } from './WorkerManager';
import { PresenceManager } from './PresenceManager';
import { generateId } from './utils';
import { TOPIC_JOBS, TOPIC_PROGRESS, DEFAULT_MAX_ATTEMPTS } from './constants';
import type {
  QueueRoomEvents,
  Job,
  JobProgress,
  AddJobOptions,
  JobFilter,
  QueueWorker,
  QueuePresenceData,
  ResolvedQueueOptions,
} from './types';

/**
 * QueueRoom — a single named queue with job lifecycle, progress tracking, and worker presence.
 *
 * Created via `NoLagQueue.joinQueue(name)`. Do not instantiate directly.
 */
export class QueueRoom extends EventEmitter<QueueRoomEvents> {
  /** Queue (room) name */
  readonly name: string;

  private _roomContext: RoomContext;
  private _localWorkerId: string;
  private _options: ResolvedQueueOptions;
  private _jobStore: JobStore;
  private _workerManager: WorkerManager;
  private _presenceManager: PresenceManager;
  private _log: (...args: unknown[]) => void;

  /** @internal */
  constructor(
    name: string,
    roomContext: RoomContext,
    localWorkerId: string,
    options: ResolvedQueueOptions,
    log: (...args: unknown[]) => void,
  ) {
    super();
    this.name = name;
    this._roomContext = roomContext;
    this._localWorkerId = localWorkerId;
    this._options = options;
    this._log = log;

    this._jobStore = new JobStore(options.maxJobCache);
    this._workerManager = new WorkerManager();
    this._presenceManager = new PresenceManager(''); // local actor set after connect
  }

  /** @internal Set the local actor ID once connected */
  _setLocalActorId(actorId: string): void {
    this._presenceManager = new PresenceManager(actorId);
  }

  // ============ Producer Methods ============

  /**
   * Add a new job to the queue. Only producers should call this.
   */
  addJob(opts: AddJobOptions): Job {
    const now = Date.now();
    const job: Job = {
      id: generateId(),
      type: opts.type,
      payload: opts.payload,
      priority: opts.priority ?? 'normal',
      status: 'pending',
      progress: 0,
      attempts: 0,
      maxAttempts: opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
      createdBy: this._localWorkerId,
      createdAt: now,
      updatedAt: now,
      isReplay: false,
    };

    this._jobStore.add(job);
    this._log('Job added:', job.id, job.type);

    this._roomContext.emit(TOPIC_JOBS, { event: 'jobAdded', job }, { echo: true });
    this.emit('jobAdded', job);

    return job;
  }

  // ============ Worker Methods ============

  /**
   * Claim a pending job. Only workers should call this.
   */
  claimJob(jobId: string): Job | null {
    const updated = this._jobStore.updateStatus(jobId, 'claimed', {
      claimedBy: this._localWorkerId,
    });
    if (!updated) return null;

    this._log('Job claimed:', jobId, 'by', this._localWorkerId);

    this._roomContext.emit(TOPIC_JOBS, { event: 'jobClaimed', job: updated }, { echo: true });
    this.emit('jobClaimed', updated);

    return updated;
  }

  /**
   * Report progress on an active job (0–100).
   */
  reportProgress(jobId: string, progress: number): void {
    const job = this._jobStore.updateProgress(jobId, progress);
    if (!job) return;

    const progressEvent: JobProgress = {
      jobId,
      progress: job.progress,
      workerId: this._localWorkerId,
      timestamp: Date.now(),
    };

    this._log('Job progress:', jobId, job.progress + '%');

    this._roomContext.emit(TOPIC_PROGRESS, progressEvent, { echo: true });
    this.emit('jobProgress', progressEvent);
  }

  /**
   * Mark a claimed/active job as completed with an optional result.
   */
  completeJob(jobId: string, result?: unknown): Job | null {
    // Transition claimed → active → completed in one step for simplicity
    let updated = this._jobStore.updateStatus(jobId, 'active');
    if (!updated) {
      // Already active — go straight to completed
      updated = this._jobStore.get(jobId) ?? null;
    }
    if (!updated) return null;

    const completed = this._jobStore.updateStatus(jobId, 'completed', { result });
    if (!completed) return null;

    this._log('Job completed:', jobId);

    this._roomContext.emit(TOPIC_JOBS, { event: 'jobCompleted', job: completed }, { echo: true });
    this.emit('jobCompleted', completed);

    return completed;
  }

  /**
   * Mark an active job as failed with an optional error message.
   * Automatically retries if attempts < maxAttempts.
   */
  failJob(jobId: string, error?: string): Job | null {
    const job = this._jobStore.get(jobId);
    if (!job) return null;

    // Move to active if still claimed
    if (job.status === 'claimed') {
      this._jobStore.updateStatus(jobId, 'active');
    }

    const nextAttempts = job.attempts + 1;
    const failed = this._jobStore.updateStatus(jobId, 'failed', {
      error,
      attempts: nextAttempts,
    });
    if (!failed) return null;

    this._log('Job failed:', jobId, 'attempts:', nextAttempts, '/', failed.maxAttempts);

    this._roomContext.emit(TOPIC_JOBS, { event: 'jobFailed', job: failed }, { echo: true });
    this.emit('jobFailed', failed);

    // Auto-retry if under maxAttempts
    if (nextAttempts < failed.maxAttempts) {
      const retried = this._jobStore.updateStatus(jobId, 'pending');
      if (retried) {
        this._log('Job retrying:', jobId, 'attempt', nextAttempts + 1);
        this._roomContext.emit(TOPIC_JOBS, { event: 'jobRetrying', job: retried }, { echo: true });
        this.emit('jobRetrying', retried);
      }
    }

    return failed;
  }

  // ============ Monitor / Query Methods ============

  /**
   * Get a single job by ID.
   */
  getJob(id: string): Job | undefined {
    return this._jobStore.get(id);
  }

  /**
   * Get all jobs, optionally filtered.
   */
  getJobs(filter?: JobFilter): Job[] {
    return this._jobStore.getAll(filter);
  }

  /**
   * Number of pending jobs.
   */
  get pendingCount(): number {
    return this._jobStore.pendingCount;
  }

  /**
   * Number of active jobs.
   */
  get activeCount(): number {
    return this._jobStore.activeCount;
  }

  /**
   * All workers currently in this queue room.
   */
  get workers(): Map<string, QueueWorker> {
    return this._presenceManager.workers;
  }

  /**
   * Get all workers in this queue room.
   */
  getWorkers(): QueueWorker[] {
    return this._presenceManager.getAll();
  }

  // ============ Internal (called by NoLagQueue) ============

  /** @internal Subscribe to jobs and progress topics, attach listeners */
  _subscribe(): void {
    this._log('Room subscribe:', this.name);

    // Workers use load balancing so each job event is delivered to only ONE worker
    // (round-robin across all workers in the same group). Producers and monitors
    // receive all messages so they can track full queue state.
    if (this._options.role === 'worker') {
      const group = this._options.loadBalanceGroup ?? `queue-workers-${this.name}`;
      this._log('Subscribing with load balance, group:', group);
      this._roomContext.subscribe(TOPIC_JOBS, { loadBalance: true, loadBalanceGroup: group });
    } else {
      this._roomContext.subscribe(TOPIC_JOBS);
    }
    this._roomContext.subscribe(TOPIC_PROGRESS);

    this._roomContext.on(TOPIC_JOBS, (data: unknown) => {
      this._handleJobMessage(data);
    });

    this._roomContext.on(TOPIC_PROGRESS, (data: unknown) => {
      this._handleProgressMessage(data);
    });
  }

  /** @internal Set presence and fetch room members */
  _activate(): void {
    this._log('Room activate:', this.name);
    this._setPresence();

    this._roomContext.fetchPresence().then((actors) => {
      this._log('Room presence fetched:', this.name, actors.length, 'actors');
      for (const actor of actors) {
        if (actor.presence) {
          const worker = this._presenceManager.addFromPresence(
            actor.actorTokenId,
            actor.presence as QueuePresenceData,
            actor.joinedAt,
          );
          if (worker) {
            this._workerManager.addWorker(worker);
            this.emit('workerJoined', worker);
          }
        }
      }
    }).catch((err) => {
      this._log('Failed to fetch room presence:', err);
    });
  }

  /** @internal Re-set presence after reconnect */
  _updateLocalPresence(): void {
    this._setPresence();
  }

  /** @internal Handle a presence:join event */
  _handlePresenceJoin(actorTokenId: string, presenceData: QueuePresenceData): void {
    const worker = this._presenceManager.addFromPresence(actorTokenId, presenceData);
    if (worker) {
      this._log('Worker joined queue:', this.name, worker.workerId);
      this._workerManager.addWorker(worker);
      this.emit('workerJoined', worker);
    }
  }

  /** @internal Handle a presence:leave event */
  _handlePresenceLeave(actorTokenId: string): void {
    const worker = this._presenceManager.removeByActorId(actorTokenId);
    if (worker) {
      this._log('Worker left queue:', this.name, worker.workerId);
      this._workerManager.removeWorker(worker.workerId);
      this.emit('workerLeft', worker);
    }
  }

  /** @internal Handle a presence:update event */
  _handlePresenceUpdate(actorTokenId: string, presenceData: QueuePresenceData): void {
    const worker = this._presenceManager.addFromPresence(actorTokenId, presenceData);
    if (worker) {
      this._workerManager.addWorker(worker);
    }
  }

  /** @internal Unsubscribe and clean up */
  _cleanup(): void {
    this._log('Room cleanup:', this.name);

    this._roomContext.unsubscribe(TOPIC_JOBS);
    this._roomContext.unsubscribe(TOPIC_PROGRESS);
    this._roomContext.off(TOPIC_JOBS);
    this._roomContext.off(TOPIC_PROGRESS);

    this._jobStore.clear();
    this._workerManager.clear();
    this._presenceManager.clear();
    this.removeAllListeners();
  }

  // ============ Private ============

  private _handleJobMessage(data: unknown): void {
    const msg = data as { event: string; job: Job };
    if (!msg?.event || !msg?.job) return;

    const { event, job } = msg;

    this._log('Job message:', event, job.id);

    switch (event) {
      case 'jobAdded':
        if (this._jobStore.add(job)) {
          this.emit('jobAdded', job);
        }
        break;

      case 'jobClaimed': {
        const existing = this._jobStore.get(job.id);
        if (existing) {
          this._jobStore.updateStatus(job.id, 'claimed', { claimedBy: job.claimedBy });
          const updated = this._jobStore.get(job.id)!;
          this.emit('jobClaimed', updated);
        }
        break;
      }

      case 'jobCompleted': {
        const existing = this._jobStore.get(job.id);
        if (existing) {
          // Sync final state directly since remote already processed transitions
          const synced: Job = { ...existing, ...job };
          this._jobStore.add(synced);
          this.emit('jobCompleted', synced);
        }
        break;
      }

      case 'jobFailed': {
        const existing = this._jobStore.get(job.id);
        if (existing) {
          const synced: Job = { ...existing, ...job };
          this._jobStore.add(synced);
          this.emit('jobFailed', synced);
        }
        break;
      }

      case 'jobRetrying': {
        const existing = this._jobStore.get(job.id);
        if (existing) {
          const synced: Job = { ...existing, ...job };
          this._jobStore.add(synced);
          this.emit('jobRetrying', synced);
        }
        break;
      }
    }
  }

  private _handleProgressMessage(data: unknown): void {
    const progress = data as JobProgress;
    if (!progress?.jobId) return;

    this._jobStore.updateProgress(progress.jobId, progress.progress);
    this._log('Job progress update:', progress.jobId, progress.progress + '%');
    this.emit('jobProgress', progress);
  }

  private _setPresence(): void {
    const presenceData: QueuePresenceData = {
      workerId: this._localWorkerId,
      role: this._options.role,
      activeJobs: 0,
      concurrency: this._options.concurrency,
      metadata: this._options.metadata,
    };
    this._roomContext.setPresence(presenceData);
  }
}
