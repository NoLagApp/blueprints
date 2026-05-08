import type { CursorPosition, UserStatus } from './types';

/**
 * AwarenessManager — cursor tracking and idle detection per user.
 *
 * Tracks cursor positions for all connected users and manages per-user
 * idle timers that fire a callback when a user has been inactive.
 */
export class AwarenessManager {
  private _cursors = new Map<string, CursorPosition>();
  private _statuses = new Map<string, UserStatus>();
  private _idleTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private _localUserId: string;

  constructor(localUserId: string) {
    this._localUserId = localUserId;
  }

  /**
   * Update the cursor position for a user and reset their idle timer.
   */
  updateCursor(userId: string, position: CursorPosition): void {
    this._cursors.set(userId, position);

    // Reset idle timer if one is running for this user
    if (this._idleTimers.has(userId)) {
      const timer = this._idleTimers.get(userId)!;
      clearTimeout(timer);
      this._idleTimers.delete(userId);
    }
  }

  /**
   * Get the last known cursor position for a user.
   */
  getCursor(userId: string): CursorPosition | undefined {
    return this._cursors.get(userId);
  }

  /**
   * Get all cursor positions except the local user's.
   */
  getCursors(): CursorPosition[] {
    return Array.from(this._cursors.values()).filter(
      (c) => c.userId !== this._localUserId,
    );
  }

  /**
   * Set the activity status for a user.
   */
  setStatus(userId: string, status: UserStatus): void {
    this._statuses.set(userId, status);
  }

  /**
   * Get the current activity status for a user (defaults to 'active').
   */
  getStatus(userId: string): UserStatus {
    return this._statuses.get(userId) ?? 'active';
  }

  /**
   * Start an idle timer for a user. If the timer fires, onIdle is called
   * and the user's status is set to 'idle'. Calling updateCursor resets it.
   */
  startIdleTracking(userId: string, timeout: number, onIdle: () => void): void {
    // Cancel any existing timer
    this.stopIdleTracking(userId);

    const timer = setTimeout(() => {
      this._idleTimers.delete(userId);
      this._statuses.set(userId, 'idle');
      onIdle();
    }, timeout);

    this._idleTimers.set(userId, timer);
  }

  /**
   * Cancel the idle timer for a user without firing the callback.
   */
  stopIdleTracking(userId: string): void {
    const timer = this._idleTimers.get(userId);
    if (timer !== undefined) {
      clearTimeout(timer);
      this._idleTimers.delete(userId);
    }
  }

  /**
   * Remove all cursor data for a user.
   */
  removeCursor(userId: string): void {
    this._cursors.delete(userId);
    this._statuses.delete(userId);
    this.stopIdleTracking(userId);
  }

  /**
   * Dispose — clear all timers and state.
   */
  dispose(): void {
    for (const timer of this._idleTimers.values()) {
      clearTimeout(timer);
    }
    this._idleTimers.clear();
    this._cursors.clear();
    this._statuses.clear();
  }
}
