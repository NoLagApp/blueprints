import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AwarenessManager } from '../../src/AwarenessManager';
import type { CursorPosition } from '../../src/types';

const LOCAL_USER = 'local-user-id';

function makeCursor(userId: string, overrides: Partial<CursorPosition> = {}): CursorPosition {
  return {
    userId,
    username: userId,
    timestamp: Date.now(),
    x: 100,
    y: 200,
    ...overrides,
  };
}

describe('AwarenessManager', () => {
  let manager: AwarenessManager;

  beforeEach(() => {
    vi.useFakeTimers();
    manager = new AwarenessManager(LOCAL_USER);
  });

  afterEach(() => {
    manager.dispose();
    vi.useRealTimers();
  });

  describe('updateCursor', () => {
    it('should store a cursor position', () => {
      const cursor = makeCursor('user-a');
      manager.updateCursor('user-a', cursor);
      expect(manager.getCursor('user-a')).toEqual(cursor);
    });

    it('should overwrite an existing cursor for the same user', () => {
      manager.updateCursor('user-a', makeCursor('user-a', { x: 10 }));
      manager.updateCursor('user-a', makeCursor('user-a', { x: 99 }));
      expect(manager.getCursor('user-a')?.x).toBe(99);
    });

    it('should reset the idle timer when cursor is updated', () => {
      const onIdle = vi.fn();
      manager.startIdleTracking('user-a', 1000, onIdle);

      // Advance time to just before timeout
      vi.advanceTimersByTime(800);
      // Reset with cursor update
      manager.updateCursor('user-a', makeCursor('user-a'));
      // Advance past the original timeout
      vi.advanceTimersByTime(800);

      // onIdle should not have fired because cursor update reset the timer
      expect(onIdle).not.toHaveBeenCalled();
    });
  });

  describe('getCursor', () => {
    it('should return undefined for unknown user', () => {
      expect(manager.getCursor('nobody')).toBeUndefined();
    });
  });

  describe('getCursors', () => {
    it('should return all cursors except the local user', () => {
      manager.updateCursor(LOCAL_USER, makeCursor(LOCAL_USER));
      manager.updateCursor('user-a', makeCursor('user-a'));
      manager.updateCursor('user-b', makeCursor('user-b'));

      const cursors = manager.getCursors();
      expect(cursors.length).toBe(2);
      expect(cursors.every((c) => c.userId !== LOCAL_USER)).toBe(true);
    });

    it('should return an empty array when no remote cursors exist', () => {
      manager.updateCursor(LOCAL_USER, makeCursor(LOCAL_USER));
      expect(manager.getCursors()).toEqual([]);
    });
  });

  describe('setStatus / getStatus', () => {
    it('should default to "active" for unknown users', () => {
      expect(manager.getStatus('nobody')).toBe('active');
    });

    it('should store and retrieve a custom status', () => {
      manager.setStatus('user-a', 'idle');
      expect(manager.getStatus('user-a')).toBe('idle');
    });

    it('should allow updating status multiple times', () => {
      manager.setStatus('user-a', 'idle');
      manager.setStatus('user-a', 'viewing');
      expect(manager.getStatus('user-a')).toBe('viewing');
    });
  });

  describe('startIdleTracking', () => {
    it('should call onIdle after the timeout', () => {
      const onIdle = vi.fn();
      manager.startIdleTracking('user-a', 5000, onIdle);

      vi.advanceTimersByTime(5000);

      expect(onIdle).toHaveBeenCalledTimes(1);
    });

    it('should set status to "idle" when the timer fires', () => {
      manager.startIdleTracking('user-a', 1000, () => {});
      vi.advanceTimersByTime(1000);
      expect(manager.getStatus('user-a')).toBe('idle');
    });

    it('should not call onIdle before the timeout', () => {
      const onIdle = vi.fn();
      manager.startIdleTracking('user-a', 5000, onIdle);
      vi.advanceTimersByTime(4999);
      expect(onIdle).not.toHaveBeenCalled();
    });

    it('should replace an existing timer when called again', () => {
      const onIdle1 = vi.fn();
      const onIdle2 = vi.fn();

      manager.startIdleTracking('user-a', 5000, onIdle1);
      manager.startIdleTracking('user-a', 5000, onIdle2);

      vi.advanceTimersByTime(5000);

      expect(onIdle1).not.toHaveBeenCalled();
      expect(onIdle2).toHaveBeenCalledTimes(1);
    });
  });

  describe('stopIdleTracking', () => {
    it('should cancel the idle timer so onIdle never fires', () => {
      const onIdle = vi.fn();
      manager.startIdleTracking('user-a', 1000, onIdle);
      manager.stopIdleTracking('user-a');

      vi.advanceTimersByTime(2000);

      expect(onIdle).not.toHaveBeenCalled();
    });

    it('should be a no-op when no timer is running', () => {
      expect(() => manager.stopIdleTracking('nobody')).not.toThrow();
    });
  });

  describe('removeCursor', () => {
    it('should remove the cursor and status for a user', () => {
      manager.updateCursor('user-a', makeCursor('user-a'));
      manager.setStatus('user-a', 'viewing');
      manager.removeCursor('user-a');

      expect(manager.getCursor('user-a')).toBeUndefined();
      expect(manager.getStatus('user-a')).toBe('active'); // defaults back
    });

    it('should cancel any active idle timer for the removed user', () => {
      const onIdle = vi.fn();
      manager.startIdleTracking('user-a', 1000, onIdle);
      manager.removeCursor('user-a');

      vi.advanceTimersByTime(2000);

      expect(onIdle).not.toHaveBeenCalled();
    });
  });

  describe('dispose', () => {
    it('should clear all cursors and timers', () => {
      const onIdle = vi.fn();
      manager.updateCursor('user-a', makeCursor('user-a'));
      manager.startIdleTracking('user-a', 1000, onIdle);

      manager.dispose();

      // No cursors
      expect(manager.getCursors()).toEqual([]);
      // Timer should be cancelled
      vi.advanceTimersByTime(2000);
      expect(onIdle).not.toHaveBeenCalled();
    });
  });
});
