/**
 * @nolag/queue — Public types
 */

import type { NoLagSocket } from '@nolag/js-sdk';

// ============ Roles & Enums ============

export type WorkerRole = 'producer' | 'worker' | 'monitor';

export type JobStatus = 'pending' | 'claimed' | 'active' | 'completed' | 'failed';

export type JobPriority = 'low' | 'normal' | 'high' | 'critical';

// ============ Options ============

export interface NoLagQueueOptions {
  /**
   * The core NoLag client to attach to (owned by the app, not the wrapper).
   * REQUIRED. The wrapper never connects or disconnects the socket.
   */
  client: NoLagSocket;
  /** Stable worker ID for this client (default: auto-generated) */
  workerId?: string;
  /** Role this client plays in the queue (default: 'monitor') */
  role?: WorkerRole;
  /** Maximum number of jobs to process concurrently (default: 1) */
  concurrency?: number;
  /** Custom metadata attached to worker presence */
  metadata?: Record<string, unknown>;
  /** NoLag app name (default: 'queue') */
  appName?: string;
  /** Maximum number of jobs to cache in memory (default: 1000) */
  maxJobCache?: number;
  /** Enable debug logging (default: false) */
  debug?: boolean;
  /** Queue names this client should participate in */
  queues?: string[];
  /**
   * Load balance group name for workers. This is a SUBSCRIBE-level option,
   * not a connection option — it flows into each queue's job-topic subscribe.
   * Workers in the same group receive jobs round-robin (only ONE worker gets each job).
   * Default: 'queue-workers-{queueName}' — all workers on the same queue share jobs automatically.
   * Set a custom group to partition workers (e.g., by region or capability).
   */
  loadBalanceGroup?: string;
}

/** Resolved options with defaults applied */
export interface ResolvedQueueOptions {
  workerId: string;
  role: WorkerRole;
  concurrency: number;
  metadata?: Record<string, unknown>;
  appName: string;
  maxJobCache: number;
  debug: boolean;
  queues: string[];
  loadBalanceGroup?: string;
}

// ============ Job ============

export interface Job {
  /** Unique job ID */
  id: string;
  /** Job type / handler name */
  type: string;
  /** Arbitrary job payload */
  payload?: Record<string, unknown>;
  /** Scheduling priority */
  priority: JobPriority;
  /** Current lifecycle status */
  status: JobStatus;
  /** Progress percentage 0–100 */
  progress: number;
  /** Result data on completion */
  result?: unknown;
  /** Error message on failure */
  error?: string;
  /** Number of times this job has been attempted */
  attempts: number;
  /** Maximum number of attempts allowed */
  maxAttempts: number;
  /** Worker ID that claimed this job */
  claimedBy?: string;
  /** Worker ID that created this job */
  createdBy: string;
  /** Timestamp when the job was created */
  createdAt: number;
  /** Timestamp when the job was last updated */
  updatedAt: number;
  /** Timestamp when the job completed or failed */
  completedAt?: number;
  /**
   * The filter this job was routed with, if any. Every later lifecycle event
   * for the job (claimed, progress, completed, failed, retrying) is published
   * with the same value so it reaches the same workers and monitors.
   */
  filter?: string;
  /** Whether this job was replayed from history */
  isReplay: boolean;
}

// ============ Add Job Options ============

export interface AddJobOptions {
  /** Job type / handler name */
  type: string;
  /** Arbitrary job payload */
  payload?: Record<string, unknown>;
  /** Scheduling priority (default: 'normal') */
  priority?: JobPriority;
  /** Maximum number of attempts (default: DEFAULT_MAX_ATTEMPTS) */
  maxAttempts?: number;
  /**
   * Route this job to workers filtering on this value — the capability-routing
   * case, e.g. `'gpu'` so only GPU workers see it. Load balancing still applies
   * within the matching workers, so exactly one of them claims it.
   *
   * Workers subscribed without filters receive every job regardless.
   */
  filter?: string;
  /**
   * AND composite filter — reaches only workers filtering on all of these
   * values together, e.g. `['gpu', 'eu-west']`. Ignored when `filter` is set.
   */
  filters?: string[];
}

/** Options for `NoLagQueue.joinQueue()`. */
export interface JoinQueueOptions {
  /**
   * Only receive jobs published with one of these filter values — declare the
   * capabilities this worker has. Combines with load balancing: the job goes
   * to exactly one worker among those matching the filter.
   *
   * Omit (or pass an empty array) to receive every job on the queue.
   */
  filters?: FilterValue[];
}

// ============ Job Progress ============

export interface JobProgress {
  /** ID of the job being updated */
  jobId: string;
  /** Progress percentage 0–100 */
  progress: number;
  /** Worker ID reporting the progress */
  workerId: string;
  /** Timestamp of the update */
  timestamp: number;
}

// ============ Worker ============

export interface QueueWorker {
  /** Stable worker ID */
  workerId: string;
  /** NoLag internal actor token ID */
  actorTokenId: string;
  /** Role this worker plays */
  role: WorkerRole;
  /** Number of jobs currently being processed */
  activeJobs: number;
  /** Maximum concurrent jobs */
  concurrency: number;
  /** Custom metadata */
  metadata?: Record<string, unknown>;
  /** Timestamp when the worker joined */
  joinedAt: number;
  /** Whether this is the local worker */
  isLocal: boolean;
}

// ============ Presence ============

/** Shape of data stored in NoLag presence for queue workers */
export interface QueuePresenceData {
  [key: string]: unknown;
  workerId: string;
  role: WorkerRole;
  activeJobs: number;
  concurrency: number;
  metadata?: Record<string, unknown>;
}

// ============ Event Maps ============

export interface QueueClientEvents {
  connected: [];
  disconnected: [reason: string];
  reconnecting: [];
  reconnected: [];
  error: [error: Error];
  workerOnline: [worker: QueueWorker];
  workerOffline: [worker: QueueWorker];
}

export interface QueueRoomEvents {
  jobAdded: [job: Job];
  jobClaimed: [job: Job];
  jobProgress: [progress: JobProgress];
  jobCompleted: [job: Job];
  jobFailed: [job: Job];
  jobRetrying: [job: Job];
  workerJoined: [worker: QueueWorker];
  workerLeft: [worker: QueueWorker];
  replayStart: [];
  replayEnd: [count: number];
}


// ============ Filters ============

/**
 * A single subscription filter value.
 *
 * A plain string is an OR term: `['alice', 'bob']` matches either. A nested
 * array is an AND group: `[['alice', 'admin']]` matches only what was
 * published tagged with both.
 */
export type FilterValue = string | string[];
