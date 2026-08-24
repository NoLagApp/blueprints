/**
 * Tiny typed event emitter — framework-agnostic base for NoLagAgents and AgentRoom.
 *
 * EventMap is a record of event name -> tuple of handler arguments.
 * e.g. { task: [TaskEnvelope]; result: [ResultEnvelope] }
 */
export class EventEmitter<
  EventMap extends { [K in keyof EventMap]: unknown[] },
> {
  private _handlers = new Map<
    keyof EventMap,
    Set<(...args: any[]) => void>
  >();

  on<K extends keyof EventMap>(
    event: K,
    handler: (...args: EventMap[K]) => void,
  ): this {
    if (!this._handlers.has(event)) {
      this._handlers.set(event, new Set());
    }
    this._handlers.get(event)!.add(handler);
    return this;
  }

  off<K extends keyof EventMap>(
    event: K,
    handler?: (...args: EventMap[K]) => void,
  ): this {
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

  protected emit<K extends keyof EventMap>(
    event: K,
    ...args: EventMap[K]
  ): void {
    const handlers = this._handlers.get(event);
    if (!handlers) return;
    for (const handler of handlers) {
      try {
        // Async handlers don't throw — they return rejected promises, which
        // the catch below never sees. Left unattached, one bad envelope from
        // the wire becomes an unhandled rejection and (Node ≥15) TERMINATES
        // THE HOST PROCESS. An event emitter fed by network input must never
        // hand a remote peer that power, so rejections are contained here
        // exactly like sync throws.
        const result = handler(...args) as unknown;
        if (
          result &&
          typeof (result as PromiseLike<unknown>).then === "function"
        ) {
          (result as PromiseLike<unknown>).then(undefined, (e: unknown) => {
            console.error(`Error in async ${String(event)} handler:`, e);
          });
        }
      } catch (e) {
        console.error(`Error in ${String(event)} handler:`, e);
      }
    }
  }

  listenerCount<K extends keyof EventMap>(event: K): number {
    return this._handlers.get(event)?.size ?? 0;
  }
}
