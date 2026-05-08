import type { CollabOperation } from './types';

/**
 * Ordered, deduplicated operation log bounded by maxOperationCache.
 *
 * Operations are stored sorted by timestamp ascending. Duplicate IDs are
 * silently ignored. When the cache exceeds its limit the oldest entries
 * are evicted.
 */
export class OperationStore {
  private _ops: CollabOperation[] = [];
  private _ids = new Set<string>();
  private _maxSize: number;

  constructor(maxSize: number) {
    this._maxSize = maxSize;
  }

  /**
   * Add an operation to the store.
   * Returns true if the operation was added, false if it was a duplicate.
   */
  add(op: CollabOperation): boolean {
    if (this._ids.has(op.id)) return false;

    this._ids.add(op.id);
    this._ops.push(op);

    // Keep sorted by timestamp ascending
    this._ops.sort((a, b) => a.timestamp - b.timestamp);

    // Evict oldest entries when over capacity
    while (this._ops.length > this._maxSize) {
      const evicted = this._ops.shift();
      if (evicted) this._ids.delete(evicted.id);
    }

    return true;
  }

  /**
   * Get all stored operations in timestamp order.
   */
  getAll(): CollabOperation[] {
    return [...this._ops];
  }

  /**
   * Get all operations sent by a specific user.
   */
  getByUser(userId: string): CollabOperation[] {
    return this._ops.filter((op) => op.userId === userId);
  }

  /**
   * Check whether an operation ID is already stored.
   */
  has(id: string): boolean {
    return this._ids.has(id);
  }

  /**
   * Number of operations currently stored.
   */
  get size(): number {
    return this._ops.length;
  }

  /**
   * Clear all stored operations.
   */
  clear(): void {
    this._ops = [];
    this._ids.clear();
  }
}
