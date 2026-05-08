import { describe, it, expect, vi } from 'vitest';
import { ReactionManager } from '../../src/ReactionManager';

describe('ReactionManager', () => {
  it('should aggregate reactions into bursts', () => {
    vi.useFakeTimers();
    const mgr = new ReactionManager(1000);
    const handler = vi.fn();
    mgr.onBurst(handler);

    mgr.sendReaction('👍');
    mgr.sendReaction('👍');
    mgr.handleRemoteReaction('❤️');

    vi.advanceTimersByTime(1001);

    expect(handler).toHaveBeenCalledTimes(2);
    const thumbsBurst = handler.mock.calls.find((c: any) => c[0].emoji === '👍');
    expect(thumbsBurst[0].count).toBe(2);

    vi.useRealTimers();
  });

  it('should dispose cleanly', () => {
    const mgr = new ReactionManager(1000);
    mgr.sendReaction('👍');
    mgr.dispose();
    // No error on dispose
  });
});
