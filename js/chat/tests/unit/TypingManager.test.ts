import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TypingManager } from '../../src/TypingManager';

describe('TypingManager', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('send side (local typing)', () => {
    it('should send typing=true on startTyping', () => {
      const tm = new TypingManager(3000);
      const sendSpy = vi.fn();
      tm.onSend(sendSpy);

      tm.startTyping();

      expect(sendSpy).toHaveBeenCalledWith(true);
      expect(tm.isLocalTyping).toBe(true);
      tm.dispose();
    });

    it('should not re-send typing=true if already typing', () => {
      const tm = new TypingManager(3000);
      const sendSpy = vi.fn();
      tm.onSend(sendSpy);

      tm.startTyping();
      tm.startTyping();
      tm.startTyping();

      expect(sendSpy).toHaveBeenCalledTimes(1);
      tm.dispose();
    });

    it('should auto-stop after timeout', () => {
      const tm = new TypingManager(3000);
      const sendSpy = vi.fn();
      tm.onSend(sendSpy);

      tm.startTyping();
      vi.advanceTimersByTime(3000);

      expect(sendSpy).toHaveBeenCalledTimes(2);
      expect(sendSpy).toHaveBeenLastCalledWith(false);
      expect(tm.isLocalTyping).toBe(false);
      tm.dispose();
    });

    it('should reset auto-stop timer on repeated startTyping', () => {
      const tm = new TypingManager(3000);
      const sendSpy = vi.fn();
      tm.onSend(sendSpy);

      tm.startTyping();
      vi.advanceTimersByTime(2000);
      tm.startTyping(); // resets timer
      vi.advanceTimersByTime(2000);

      // Should still be typing (only 2s since last startTyping)
      expect(tm.isLocalTyping).toBe(true);

      vi.advanceTimersByTime(1000);
      // Now 3s since last startTyping → auto-stop
      expect(tm.isLocalTyping).toBe(false);
      tm.dispose();
    });

    it('should send typing=false on explicit stopTyping', () => {
      const tm = new TypingManager(3000);
      const sendSpy = vi.fn();
      tm.onSend(sendSpy);

      tm.startTyping();
      tm.stopTyping();

      expect(sendSpy).toHaveBeenCalledWith(false);
      expect(tm.isLocalTyping).toBe(false);
      tm.dispose();
    });

    it('should not send typing=false if not typing', () => {
      const tm = new TypingManager(3000);
      const sendSpy = vi.fn();
      tm.onSend(sendSpy);

      tm.stopTyping();
      expect(sendSpy).not.toHaveBeenCalled();
      tm.dispose();
    });
  });

  describe('receive side (remote typing)', () => {
    it('should track remote typing users', () => {
      const tm = new TypingManager(3000);
      const changeSpy = vi.fn();
      tm.onChange(changeSpy);

      tm.handleRemote('user-a', true);

      expect(tm.getTypingUserIds().has('user-a')).toBe(true);
      expect(changeSpy).toHaveBeenCalledTimes(1);
      tm.dispose();
    });

    it('should remove user on typing=false', () => {
      const tm = new TypingManager(3000);

      tm.handleRemote('user-a', true);
      tm.handleRemote('user-a', false);

      expect(tm.getTypingUserIds().has('user-a')).toBe(false);
      tm.dispose();
    });

    it('should auto-expire remote typing after timeout + grace', () => {
      const tm = new TypingManager(3000);

      tm.handleRemote('user-a', true);
      expect(tm.getTypingUserIds().has('user-a')).toBe(true);

      vi.advanceTimersByTime(4000); // timeout (3000) + grace (1000)

      expect(tm.getTypingUserIds().has('user-a')).toBe(false);
      tm.dispose();
    });

    it('should track multiple users', () => {
      const tm = new TypingManager(3000);

      tm.handleRemote('user-a', true);
      tm.handleRemote('user-b', true);

      expect(tm.getTypingUserIds().size).toBe(2);

      tm.handleRemote('user-a', false);
      expect(tm.getTypingUserIds().size).toBe(1);
      expect(tm.getTypingUserIds().has('user-b')).toBe(true);
      tm.dispose();
    });
  });

  describe('dispose', () => {
    it('should clean up all state and timers', () => {
      const tm = new TypingManager(3000);
      const sendSpy = vi.fn();
      const changeSpy = vi.fn();
      tm.onSend(sendSpy);
      tm.onChange(changeSpy);

      tm.startTyping();
      tm.handleRemote('user-a', true);
      tm.dispose();

      expect(tm.isLocalTyping).toBe(false);
      expect(tm.getTypingUserIds().size).toBe(0);

      // Advancing timers should not trigger callbacks
      sendSpy.mockClear();
      changeSpy.mockClear();
      vi.advanceTimersByTime(10000);
      expect(sendSpy).not.toHaveBeenCalled();
      expect(changeSpy).not.toHaveBeenCalled();
    });
  });
});
