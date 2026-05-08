import type { FeedPost } from './types';

/**
 * Bounded, deduplicated post cache ordered by timestamp.
 */
export class PostStore {
  private _posts: FeedPost[] = [];
  private _ids = new Set<string>();
  private _maxSize: number;

  constructor(maxSize: number) {
    this._maxSize = maxSize;
  }

  /**
   * Add a post. Returns true if the post was new (not a duplicate).
   */
  add(post: FeedPost): boolean {
    if (this._ids.has(post.id)) {
      return false;
    }

    this._ids.add(post.id);
    this._posts.push(post);

    // Keep sorted by timestamp (newest last)
    if (
      this._posts.length > 1 &&
      post.timestamp < this._posts[this._posts.length - 2].timestamp
    ) {
      this._posts.sort((a, b) => a.timestamp - b.timestamp);
    }

    // Trim if over capacity (remove oldest)
    while (this._posts.length > this._maxSize) {
      const removed = this._posts.shift()!;
      this._ids.delete(removed.id);
    }

    return true;
  }

  /**
   * Get a post by ID.
   */
  get(id: string): FeedPost | undefined {
    return this._posts.find((p) => p.id === id);
  }

  /**
   * Get all posts in timestamp order (oldest first).
   */
  getAll(): FeedPost[] {
    return [...this._posts];
  }

  /**
   * Update the like count (and likedByMe flag) for a post in-place.
   */
  updateLikeCount(postId: string, count: number, likedByMe: boolean): void {
    const post = this._posts.find((p) => p.id === postId);
    if (post) {
      post.likeCount = count;
      post.likedByMe = likedByMe;
    }
  }

  /**
   * Increment the comment count for a post in-place.
   */
  incrementCommentCount(postId: string): void {
    const post = this._posts.find((p) => p.id === postId);
    if (post) {
      post.commentCount++;
    }
  }

  /**
   * Check if a post ID exists.
   */
  has(id: string): boolean {
    return this._ids.has(id);
  }

  /**
   * Get post count.
   */
  get size(): number {
    return this._posts.length;
  }

  /**
   * Clear all posts.
   */
  clear(): void {
    this._posts = [];
    this._ids.clear();
  }
}
