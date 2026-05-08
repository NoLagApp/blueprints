/**
 * Manages typing indicator state for both local (send) and remote (receive) sides.
 *
 * Send-side: debounced — calling startTyping() sends a signal, then auto-stops
 * after a configurable timeout unless startTyping() is called again.
 *
 * Receive-side: per-user timeouts — if no typing signal arrives within the
 * timeout window, the user is considered to have stopped typing.
 */
export class TypingManager {
  private _timeout: number;

  // Send-side
  private _localTimer: ReturnType<typeof setTimeout> | null = null;
  private _localTyping = false;

  // Receive-side: userId → timeout
  private _remoteTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private _typingUserIds = new Set<string>();

  // Callbacks
  private _onSend: ((typing: boolean) => void) | null = null;
  private _onChange: (() => void) | null = null;

  constructor(timeout: number) {
    this._timeout = timeout;
  }

  /**
   * Set the callback invoked when a typing signal needs to be sent.
   */
  onSend(cb: (typing: boolean) => void): void {
    this._onSend = cb;
  }

  /**
   * Set the callback invoked when the set of typing users changes.
   */
  onChange(cb: () => void): void {
    this._onChange = cb;
  }

  /**
   * Called by the local user when they are typing.
   * Sends typing=true if not already sent, and (re)starts the auto-stop timer.
   */
  startTyping(): void {
    if (!this._localTyping) {
      this._localTyping = true;
      this._onSend?.(true);
    }

    // Reset auto-stop timer
    if (this._localTimer) clearTimeout(this._localTimer);
    this._localTimer = setTimeout(() => {
      this.stopTyping();
    }, this._timeout);
  }

  /**
   * Called by the local user to explicitly stop typing.
   */
  stopTyping(): void {
    if (!this._localTyping) return;

    this._localTyping = false;
    if (this._localTimer) {
      clearTimeout(this._localTimer);
      this._localTimer = null;
    }
    this._onSend?.(false);
  }

  /**
   * Handle a remote typing signal.
   */
  handleRemote(userId: string, typing: boolean): void {
    // Clear existing timer for this user
    const existing = this._remoteTimers.get(userId);
    if (existing) clearTimeout(existing);

    if (typing) {
      this._typingUserIds.add(userId);

      // Auto-expire if no follow-up
      this._remoteTimers.set(
        userId,
        setTimeout(() => {
          this._typingUserIds.delete(userId);
          this._remoteTimers.delete(userId);
          this._onChange?.();
        }, this._timeout + 1000), // slight grace period
      );
    } else {
      this._typingUserIds.delete(userId);
      this._remoteTimers.delete(userId);
    }

    this._onChange?.();
  }

  /**
   * Get the set of currently-typing remote user IDs.
   */
  getTypingUserIds(): Set<string> {
    return this._typingUserIds;
  }

  /**
   * Whether the local user is currently typing.
   */
  get isLocalTyping(): boolean {
    return this._localTyping;
  }

  /**
   * Clean up all timers.
   */
  dispose(): void {
    if (this._localTimer) clearTimeout(this._localTimer);
    for (const timer of this._remoteTimers.values()) {
      clearTimeout(timer);
    }
    this._remoteTimers.clear();
    this._typingUserIds.clear();
    this._localTyping = false;
    this._onSend = null;
    this._onChange = null;
  }
}
