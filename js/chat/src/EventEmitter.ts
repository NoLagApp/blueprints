/**
 * Tiny typed event emitter — framework-agnostic base for NoLagChat and ChatRoom.
 *
 * EventMap is a record of event name → tuple of handler arguments.
 * e.g. { message: [ChatMessage]; typing: [{ users: ChatUser[] }] }
 */
export class EventEmitter<EventMap extends { [K in keyof EventMap]: unknown[] }> {
  private _handlers = new Map<keyof EventMap, Set<(...args: any[]) => void>>();

  /**
   * Register an event handler.
   */
  on<K extends keyof EventMap>(event: K, handler: (...args: EventMap[K]) => void): this {
    if (!this._handlers.has(event)) {
      this._handlers.set(event, new Set());
    }
    this._handlers.get(event)!.add(handler);
    return this;
  }

  /**
   * Remove a specific handler, or all handlers for an event.
   */
  off<K extends keyof EventMap>(event: K, handler?: (...args: EventMap[K]) => void): this {
    if (handler) {
      this._handlers.get(event)?.delete(handler);
    } else {
      this._handlers.delete(event);
    }
    return this;
  }

  /**
   * Remove all handlers for all events.
   */
  removeAllListeners(): this {
    this._handlers.clear();
    return this;
  }

  /**
   * Emit an event to all registered handlers.
   */
  protected emit<K extends keyof EventMap>(event: K, ...args: EventMap[K]): void {
    const handlers = this._handlers.get(event);
    if (!handlers) return;
    for (const handler of handlers) {
      try {
        handler(...args);
      } catch (e) {
        console.error(`Error in ${String(event)} handler:`, e);
      }
    }
  }

  /**
   * Returns the number of handlers registered for an event.
   */
  listenerCount<K extends keyof EventMap>(event: K): number {
    return this._handlers.get(event)?.size ?? 0;
  }
}
