import { describe, it, expect } from 'vitest';
import { PostStore } from '../../src/PostStore';
import type { FeedPost } from '../../src/types';

function makePost(overrides: Partial<FeedPost> = {}): FeedPost {
  return { id: Math.random().toString(36).slice(2), userId: 'u1', username: 'Alice', content: 'Hello', likeCount: 0, commentCount: 0, likedByMe: false, timestamp: Date.now(), status: 'delivered', isReplay: false, ...overrides };
}

describe('PostStore', () => {
  it('should add and return in order', () => {
    const store = new PostStore(100);
    store.add(makePost({ id: '1', timestamp: 1000 }));
    store.add(makePost({ id: '2', timestamp: 2000 }));
    expect(store.getAll().map(p => p.id)).toEqual(['1', '2']);
  });

  it('should deduplicate', () => {
    const store = new PostStore(100);
    expect(store.add(makePost({ id: 'dup' }))).toBe(true);
    expect(store.add(makePost({ id: 'dup' }))).toBe(false);
  });

  it('should enforce max size', () => {
    const store = new PostStore(2);
    store.add(makePost({ id: '1', timestamp: 1000 }));
    store.add(makePost({ id: '2', timestamp: 2000 }));
    store.add(makePost({ id: '3', timestamp: 3000 }));
    expect(store.size).toBe(2);
    expect(store.has('1')).toBe(false);
  });

  it('should update like count', () => {
    const store = new PostStore(100);
    store.add(makePost({ id: '1' }));
    store.updateLikeCount('1', 5, true);
    expect(store.get('1')?.likeCount).toBe(5);
    expect(store.get('1')?.likedByMe).toBe(true);
  });

  it('should increment comment count', () => {
    const store = new PostStore(100);
    store.add(makePost({ id: '1' }));
    store.incrementCommentCount('1');
    expect(store.get('1')?.commentCount).toBe(1);
  });
});
