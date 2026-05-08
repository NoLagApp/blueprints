import type { ReactionBurst } from './types';

/**
 * Aggregates reactions into time-windowed bursts.
 *
 * Reactions received within the same window (local or remote) are grouped
 * by emoji. When the window expires, the burst is emitted via the onBurst
 * callback and the window resets.
 */
export class ReactionManager {
  private _window: number;

  // emoji -> count within current window
  private _pending = new Map<string, number>();
  private _windowStart = 0;
  private _timer: ReturnType<typeof setTimeout> | null = null;

  private _onBurst: ((burst: ReactionBurst) => void) | null = null;

  constructor(windowMs: number) {
    this._window = windowMs;
  }

  /**
   * Set the callback invoked when a reaction burst is ready.
   */
  onBurst(cb: (burst: ReactionBurst) => void): void {
    this._onBurst = cb;
  }

  /**
   * Record a local reaction (sent by the local viewer).
   */
  sendReaction(emoji: string): void {
    this._record(emoji);
  }

  /**
   * Handle a reaction received from a remote viewer.
   */
  handleRemoteReaction(emoji: string): void {
    this._record(emoji);
  }

  /**
   * Clean up timers.
   */
  dispose(): void {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    this._pending.clear();
    this._onBurst = null;
  }

  // ============ Private ============

  private _record(emoji: string): void {
    if (this._pending.size === 0) {
      // Start a new window
      this._windowStart = Date.now();
      this._timer = setTimeout(() => this._flush(), this._window);
    }

    const current = this._pending.get(emoji) ?? 0;
    this._pending.set(emoji, current + 1);
  }

  private _flush(): void {
    if (this._pending.size === 0) return;

    const windowEnd = Date.now();

    for (const [emoji, count] of this._pending) {
      const burst: ReactionBurst = {
        emoji,
        count,
        windowStart: this._windowStart,
        windowEnd,
      };
      try {
        this._onBurst?.(burst);
      } catch (e) {
        console.error('[ReactionManager] Error in onBurst callback:', e);
      }
    }

    this._pending.clear();
    this._timer = null;
    this._windowStart = 0;
  }
}
