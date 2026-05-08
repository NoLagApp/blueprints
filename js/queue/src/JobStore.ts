import type { Job, JobStatus, JobPriority } from './types';

/** Valid state transitions for job lifecycle */
const VALID_TRANSITIONS: Partial<Record<JobStatus, JobStatus[]>> = {
  pending: ['claimed'],
  claimed: ['active'],
  active: ['completed', 'failed'],
  failed: ['pending'], // retry path
};

export interface JobFilter {
  status?: JobStatus;
  type?: string;
  priority?: JobPriority;
}

/**
 * In-memory job store with deduplication, filtering, and state-transition validation.
 */
export class JobStore {
  private _jobs = new Map<string, Job>();
  private _maxSize: number;

  constructor(maxSize: number) {
    this._maxSize = maxSize;
  }

  /**
   * Add a job to the store.
   * Returns true if added, false if already present (dedup).
   */
  add(job: Job): boolean {
    if (this._jobs.has(job.id)) return false;

    // Evict oldest entry if at capacity
    if (this._jobs.size >= this._maxSize) {
      const firstKey = this._jobs.keys().next().value;
      if (firstKey !== undefined) {
        this._jobs.delete(firstKey);
      }
    }

    this._jobs.set(job.id, job);
    return true;
  }

  /**
   * Get a job by ID.
   */
  get(id: string): Job | undefined {
    return this._jobs.get(id);
  }

  /**
   * Get all jobs, optionally filtered.
   */
  getAll(filter?: JobFilter): Job[] {
    const jobs = Array.from(this._jobs.values());
    if (!filter) return jobs;

    return jobs.filter((job) => {
      if (filter.status !== undefined && job.status !== filter.status) return false;
      if (filter.type !== undefined && job.type !== filter.type) return false;
      if (filter.priority !== undefined && job.priority !== filter.priority) return false;
      return true;
    });
  }

  /**
   * Transition a job to a new status with optional data update.
   * Validates the state transition. Returns updated job or null if invalid.
   */
  updateStatus(
    id: string,
    status: JobStatus,
    data?: Partial<Pick<Job, 'result' | 'error' | 'claimedBy' | 'attempts'>>,
  ): Job | null {
    const job = this._jobs.get(id);
    if (!job) return null;

    const allowed = VALID_TRANSITIONS[job.status];
    if (!allowed || !allowed.includes(status)) return null;

    const now = Date.now();
    const updated: Job = {
      ...job,
      status,
      updatedAt: now,
      ...data,
    };

    if (status === 'completed' || status === 'failed') {
      updated.completedAt = now;
    }

    this._jobs.set(id, updated);
    return updated;
  }

  /**
   * Update the progress percentage (0–100) for a job.
   * Returns the updated job or null if not found.
   */
  updateProgress(id: string, progress: number): Job | null {
    const job = this._jobs.get(id);
    if (!job) return null;

    const clamped = Math.min(100, Math.max(0, progress));
    const updated: Job = { ...job, progress: clamped, updatedAt: Date.now() };
    this._jobs.set(id, updated);
    return updated;
  }

  /**
   * Number of jobs currently in 'pending' status.
   */
  get pendingCount(): number {
    let count = 0;
    for (const job of this._jobs.values()) {
      if (job.status === 'pending') count++;
    }
    return count;
  }

  /**
   * Number of jobs currently in 'active' status.
   */
  get activeCount(): number {
    let count = 0;
    for (const job of this._jobs.values()) {
      if (job.status === 'active') count++;
    }
    return count;
  }

  /**
   * Check if a job with the given ID exists.
   */
  has(id: string): boolean {
    return this._jobs.has(id);
  }

  /**
   * Total number of jobs in the store.
   */
  get size(): number {
    return this._jobs.size;
  }

  /**
   * Clear all jobs from the store.
   */
  clear(): void {
    this._jobs.clear();
  }
}
