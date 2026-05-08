import type { QueueWorker, QueuePresenceData } from './types';

/**
 * Maps actorTokenId ↔ QueueWorker, filtering self.
 */
export class PresenceManager {
  private _workers = new Map<string, QueueWorker>();
  private _actorToWorkerId = new Map<string, string>();
  private _localActorId: string;

  constructor(localActorId: string) {
    this._localActorId = localActorId;
  }

  /**
   * Add or update a worker from presence data.
   * Returns the QueueWorker if it's a remote worker, null if it's self.
   */
  addFromPresence(actorTokenId: string, presence: QueuePresenceData, joinedAt?: number): QueueWorker | null {
    const isLocal = actorTokenId === this._localActorId;

    // Skip self
    if (isLocal) return null;

    const existing = this._actorToWorkerId.get(actorTokenId);
    const workerId = presence.workerId || existing || actorTokenId;

    const worker: QueueWorker = {
      workerId,
      actorTokenId,
      role: presence.role,
      activeJobs: presence.activeJobs ?? 0,
      concurrency: presence.concurrency ?? 1,
      metadata: presence.metadata,
      joinedAt: joinedAt || Date.now(),
      isLocal: false,
    };

    this._workers.set(workerId, worker);
    this._actorToWorkerId.set(actorTokenId, workerId);

    return worker;
  }

  /**
   * Remove a worker by actorTokenId.
   * Returns the removed worker, or null if not found / is self.
   */
  removeByActorId(actorTokenId: string): QueueWorker | null {
    if (actorTokenId === this._localActorId) return null;

    const workerId = this._actorToWorkerId.get(actorTokenId);
    if (!workerId) return null;

    const worker = this._workers.get(workerId) ?? null;
    this._workers.delete(workerId);
    this._actorToWorkerId.delete(actorTokenId);

    return worker;
  }

  /**
   * Get a worker by workerId.
   */
  getWorker(workerId: string): QueueWorker | undefined {
    return this._workers.get(workerId);
  }

  /**
   * Get a worker by actorTokenId.
   */
  getWorkerByActorId(actorTokenId: string): QueueWorker | undefined {
    const workerId = this._actorToWorkerId.get(actorTokenId);
    return workerId ? this._workers.get(workerId) : undefined;
  }

  /**
   * Get all remote workers.
   */
  getAll(): QueueWorker[] {
    return Array.from(this._workers.values());
  }

  /**
   * Get the workers Map (readonly view).
   */
  get workers(): Map<string, QueueWorker> {
    return this._workers;
  }

  /**
   * Clear all tracked workers.
   */
  clear(): void {
    this._workers.clear();
    this._actorToWorkerId.clear();
  }
}
