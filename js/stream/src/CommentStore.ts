import type { StreamComment } from './types';

/**
 * Bounded, deduplicated comment cache ordered by timestamp.
 */
export class CommentStore {
  private _comments: StreamComment[] = [];
  private _ids = new Set<string>();
  private _maxSize: number;

  constructor(maxSize: number) {
    this._maxSize = maxSize;
  }

  /**
   * Add a comment. Returns true if the comment was new (not a duplicate).
   */
  add(comment: StreamComment): boolean {
    if (this._ids.has(comment.id)) {
      return false;
    }

    this._ids.add(comment.id);
    this._comments.push(comment);

    // Keep sorted by timestamp
    if (
      this._comments.length > 1 &&
      comment.timestamp < this._comments[this._comments.length - 2].timestamp
    ) {
      this._comments.sort((a, b) => a.timestamp - b.timestamp);
    }

    // Trim if over capacity
    while (this._comments.length > this._maxSize) {
      const removed = this._comments.shift()!;
      this._ids.delete(removed.id);
    }

    return true;
  }

  /**
   * Get all comments in timestamp order.
   */
  getAll(): StreamComment[] {
    return [...this._comments];
  }

  /**
   * Get comment count.
   */
  get size(): number {
    return this._comments.length;
  }

  /**
   * Check if a comment ID exists.
   */
  has(id: string): boolean {
    return this._ids.has(id);
  }

  /**
   * Clear all comments.
   */
  clear(): void {
    this._comments = [];
    this._ids.clear();
  }
}
