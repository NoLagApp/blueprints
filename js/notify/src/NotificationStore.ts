import type { Notification } from './types';

/**
 * Bounded, deduplicated notification cache ordered by timestamp,
 * with read/unread tracking.
 */
export class NotificationStore {
  private _notifications: Notification[] = [];
  private _ids = new Set<string>();
  private _maxSize: number;

  constructor(maxSize: number) {
    this._maxSize = maxSize;
  }

  /**
   * Add a notification. Returns true if the notification was new (not a duplicate).
   */
  add(notification: Notification): boolean {
    if (this._ids.has(notification.id)) {
      return false;
    }

    this._ids.add(notification.id);
    this._notifications.push(notification);

    // Keep sorted by timestamp
    if (
      this._notifications.length > 1 &&
      notification.timestamp < this._notifications[this._notifications.length - 2].timestamp
    ) {
      this._notifications.sort((a, b) => a.timestamp - b.timestamp);
    }

    // Trim if over capacity
    while (this._notifications.length > this._maxSize) {
      const removed = this._notifications.shift()!;
      this._ids.delete(removed.id);
    }

    return true;
  }

  /**
   * Mark a notification as read by id.
   * Returns true if the notification was found.
   */
  markRead(id: string): boolean {
    const notification = this._notifications.find((n) => n.id === id);
    if (!notification) return false;
    notification.read = true;
    return true;
  }

  /**
   * Mark all notifications as read.
   */
  markAllRead(): void {
    for (const notification of this._notifications) {
      notification.read = true;
    }
  }

  /**
   * Get all notifications in timestamp order.
   */
  getAll(): Notification[] {
    return [...this._notifications];
  }

  /**
   * Get all unread notifications.
   */
  getUnread(): Notification[] {
    return this._notifications.filter((n) => !n.read);
  }

  /**
   * Get the number of unread notifications.
   */
  get unreadCount(): number {
    return this._notifications.filter((n) => !n.read).length;
  }

  /**
   * Get notification count.
   */
  get size(): number {
    return this._notifications.length;
  }

  /**
   * Check if a notification ID exists.
   */
  has(id: string): boolean {
    return this._ids.has(id);
  }

  /**
   * Clear all notifications.
   */
  clear(): void {
    this._notifications = [];
    this._ids.clear();
  }
}
