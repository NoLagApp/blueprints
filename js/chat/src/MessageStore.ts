import type { ChatMessage } from './types';

/**
 * Bounded, deduplicated message cache ordered by timestamp.
 */
export class MessageStore {
  private _messages: ChatMessage[] = [];
  private _ids = new Set<string>();
  private _maxSize: number;

  constructor(maxSize: number) {
    this._maxSize = maxSize;
  }

  /**
   * Add a message. Returns true if the message was new (not a duplicate).
   */
  add(message: ChatMessage): boolean {
    if (this._ids.has(message.id)) {
      return false;
    }

    this._ids.add(message.id);
    this._messages.push(message);

    // Keep sorted by timestamp
    if (
      this._messages.length > 1 &&
      message.timestamp < this._messages[this._messages.length - 2].timestamp
    ) {
      this._messages.sort((a, b) => a.timestamp - b.timestamp);
    }

    // Trim if over capacity
    while (this._messages.length > this._maxSize) {
      const removed = this._messages.shift()!;
      this._ids.delete(removed.id);
    }

    return true;
  }

  /**
   * Get all messages in timestamp order.
   */
  getAll(): ChatMessage[] {
    return [...this._messages];
  }

  /**
   * Get message count.
   */
  get size(): number {
    return this._messages.length;
  }

  /**
   * Check if a message ID exists.
   */
  has(id: string): boolean {
    return this._ids.has(id);
  }

  /**
   * Clear all messages.
   */
  clear(): void {
    this._messages = [];
    this._ids.clear();
  }
}
