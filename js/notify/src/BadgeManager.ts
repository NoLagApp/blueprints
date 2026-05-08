import type { BadgeCounts } from './types';

/**
 * Aggregates unread notification counts across channels.
 */
export class BadgeManager {
  private _counts = new Map<string, number>();

  /**
   * Update the unread count for a channel.
   */
  update(channel: string, unreadCount: number): void {
    this._counts.set(channel, unreadCount);
  }

  /**
   * Get the unread count for a specific channel.
   */
  get(channel: string): number {
    return this._counts.get(channel) ?? 0;
  }

  /**
   * Get all badge counts — total and per-channel breakdown.
   */
  getAll(): BadgeCounts {
    const byChannel: Record<string, number> = {};
    let total = 0;

    for (const [channel, count] of this._counts) {
      byChannel[channel] = count;
      total += count;
    }

    return { total, byChannel };
  }

  /**
   * Clear all counts.
   */
  clear(): void {
    this._counts.clear();
  }
}
