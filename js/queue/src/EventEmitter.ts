/**
 * Tiny typed event emitter — framework-agnostic base for NoLag SDKs.
 *
 * EventMap is a record of event name → tuple of handler arguments.
 */
export class EventEmitter<EventMap extends { [K in keyof EventMap]: unknown[] }> {
  private _handlers = new Map<keyof EventMap, Set<(...args: any[]) => void>>();

  on<K extends keyof EventMap>(event: K, handler: (...args: EventMap[K]) => void): this {
    if (!this._handlers.has(event)) {
      this._handlers.set(event, new Set());
    }
    this._handlers.get(event)!.add(handler);
    return this;
  }

  off<K extends keyof EventMap>(event: K, handler?: (...args: EventMap[K]) => void): this {
    if (handler) {
      this._handlers.get(event)?.delete(handler);
    } else {
      this._handlers.delete(event);
    }
    return this;
  }

  removeAllListeners(): this {
    this._handlers.clear();
    return this;
  }

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

  listenerCount<K extends keyof EventMap>(event: K): number {
    return this._handlers.get(event)?.size ?? 0;
  }
}
