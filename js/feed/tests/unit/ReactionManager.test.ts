import { describe, it, expect } from 'vitest';
import { ReactionManager } from '../../src/ReactionManager';

describe('ReactionManager', () => {
  it('should track likes', () => {
    const mgr = new ReactionManager();
    const result = mgr.like('p1', 'u1');
    expect(result.likeCount).toBe(1);
    expect(result.isNew).toBe(true);
  });

  it('should deduplicate likes', () => {
    const mgr = new ReactionManager();
    mgr.like('p1', 'u1');
    const result = mgr.like('p1', 'u1');
    expect(result.likeCount).toBe(1);
    expect(result.isNew).toBe(false);
  });

  it('should unlike', () => {
    const mgr = new ReactionManager();
    mgr.like('p1', 'u1');
    const result = mgr.unlike('p1', 'u1');
    expect(result.likeCount).toBe(0);
    expect(result.wasLiked).toBe(true);
  });

  it('should check isLikedBy', () => {
    const mgr = new ReactionManager();
    expect(mgr.isLikedBy('p1', 'u1')).toBe(false);
    mgr.like('p1', 'u1');
    expect(mgr.isLikedBy('p1', 'u1')).toBe(true);
  });
});
