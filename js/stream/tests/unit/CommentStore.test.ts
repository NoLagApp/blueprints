import { describe, it, expect } from 'vitest';
import { CommentStore } from '../../src/CommentStore';
import type { StreamComment } from '../../src/types';

function makeComment(overrides: Partial<StreamComment> = {}): StreamComment {
  return { id: Math.random().toString(36).slice(2), viewerId: 'v1', username: 'Alice', text: 'Hello', timestamp: Date.now(), status: 'delivered', isReplay: false, ...overrides };
}

describe('CommentStore', () => {
  it('should add and return in order', () => {
    const store = new CommentStore(100);
    store.add(makeComment({ id: '1', timestamp: 1000 }));
    store.add(makeComment({ id: '2', timestamp: 2000 }));
    expect(store.getAll().map(c => c.id)).toEqual(['1', '2']);
  });

  it('should deduplicate', () => {
    const store = new CommentStore(100);
    expect(store.add(makeComment({ id: 'dup' }))).toBe(true);
    expect(store.add(makeComment({ id: 'dup' }))).toBe(false);
  });

  it('should enforce max size', () => {
    const store = new CommentStore(2);
    store.add(makeComment({ id: '1', timestamp: 1000 }));
    store.add(makeComment({ id: '2', timestamp: 2000 }));
    store.add(makeComment({ id: '3', timestamp: 3000 }));
    expect(store.size).toBe(2);
    expect(store.has('1')).toBe(false);
  });

  it('should clear', () => {
    const store = new CommentStore(100);
    store.add(makeComment({ id: '1' }));
    store.clear();
    expect(store.size).toBe(0);
  });
});
