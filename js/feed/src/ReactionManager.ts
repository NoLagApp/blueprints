/**
 * Tracks like/unlike state per post with per-user deduplication.
 *
 * Internal: Map<postId, Set<userId>>
 */
export class ReactionManager {
  private _likes = new Map<string, Set<string>>();

  /**
   * Record a like from userId on postId.
   * Returns the updated likeCount and whether this was a new like.
   */
  like(postId: string, userId: string): { postId: string; likeCount: number; isNew: boolean } {
    if (!this._likes.has(postId)) {
      this._likes.set(postId, new Set());
    }
    const likers = this._likes.get(postId)!;
    const isNew = !likers.has(userId);
    likers.add(userId);
    return { postId, likeCount: likers.size, isNew };
  }

  /**
   * Record an unlike from userId on postId.
   * Returns the updated likeCount and whether the like was removed.
   */
  unlike(postId: string, userId: string): { postId: string; likeCount: number; wasLiked: boolean } {
    const likers = this._likes.get(postId);
    if (!likers) {
      return { postId, likeCount: 0, wasLiked: false };
    }
    const wasLiked = likers.has(userId);
    likers.delete(userId);
    return { postId, likeCount: likers.size, wasLiked };
  }

  /**
   * Check if a userId has liked a postId.
   */
  isLikedBy(postId: string, userId: string): boolean {
    return this._likes.get(postId)?.has(userId) ?? false;
  }

  /**
   * Get the total like count for a post.
   */
  getLikeCount(postId: string): number {
    return this._likes.get(postId)?.size ?? 0;
  }

  /**
   * Clear all reaction state.
   */
  clear(): void {
    this._likes.clear();
  }
}
