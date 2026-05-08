import type { QueueWorker } from './types';

/**
 * Tracks all known queue workers (local and remote).
 */
export class WorkerManager {
  private _workers = new Map<string, QueueWorker>();

  /**
   * Add or replace a worker entry.
   */
  addWorker(worker: QueueWorker): void {
    this._workers.set(worker.workerId, worker);
  }

  /**
   * Remove a worker by workerId.
   * Returns the removed worker, or null if not found.
   */
  removeWorker(workerId: string): QueueWorker | null {
    const worker = this._workers.get(workerId) ?? null;
    this._workers.delete(workerId);
    return worker;
  }

  /**
   * Get a worker by workerId.
   */
  getWorker(workerId: string): QueueWorker | undefined {
    return this._workers.get(workerId);
  }

  /**
   * Get all tracked workers.
   */
  getAll(): QueueWorker[] {
    return Array.from(this._workers.values());
  }

  /**
   * Increment the active job count for a worker.
   * Returns the updated worker or null if not found.
   */
  incrementActiveJobs(workerId: string): QueueWorker | null {
    const worker = this._workers.get(workerId);
    if (!worker) return null;

    const updated: QueueWorker = { ...worker, activeJobs: worker.activeJobs + 1 };
    this._workers.set(workerId, updated);
    return updated;
  }

  /**
   * Decrement the active job count for a worker (floor 0).
   * Returns the updated worker or null if not found.
   */
  decrementActiveJobs(workerId: string): QueueWorker | null {
    const worker = this._workers.get(workerId);
    if (!worker) return null;

    const updated: QueueWorker = {
      ...worker,
      activeJobs: Math.max(0, worker.activeJobs - 1),
    };
    this._workers.set(workerId, updated);
    return updated;
  }

  /**
   * Check whether a worker can accept more work (activeJobs < concurrency).
   */
  canAcceptWork(workerId: string): boolean {
    const worker = this._workers.get(workerId);
    if (!worker) return false;
    return worker.activeJobs < worker.concurrency;
  }

  /**
   * Clear all tracked workers.
   */
  clear(): void {
    this._workers.clear();
  }
}
