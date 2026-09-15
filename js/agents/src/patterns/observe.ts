import type { AgentRoom } from "../AgentRoom";
import type { EventEnvelope, FilterValue } from "../types";
import { createEventEnvelope } from "../envelope";

/**
 * Observe pattern — emit and listen to observability events.
 *
 * Agents emit structured events; observers/dashboards subscribe to the stream.
 * Events have severity, category, and emittedBy for filtering.
 *
 * `on(handler, filter)` discards non-matching events after they arrive, which
 * is fine for a quiet room and wasteful for a loud one. `setFilters` moves the
 * same selection to the broker, so an observer is only sent the categories it
 * asked for. Emit with a matching `filter` for that to work — see `emit`.
 */
export class Observe {
  private _room: AgentRoom;
  private _emittedBy: string;

  constructor(room: AgentRoom, emittedBy: string) {
    this._room = room;
    this._emittedBy = emittedBy;
  }

  /**
   * Emit an observability event.
   *
   * Pass `{ filter: category }` to route it server-side, so observers that
   * called `setFilters` receive only the categories they subscribed to.
   * Observers with no filters still receive it either way, so tagging is safe
   * to adopt without coordinating with them.
   */
  emit(
    category: string,
    payload: Record<string, unknown>,
    severity: EventEnvelope["severity"] = "info",
    opts?: { filter?: string; filters?: string[] },
  ): void {
    const envelope = createEventEnvelope(category, this._emittedBy, payload, severity);
    this._room.publishEvent(envelope as unknown as Record<string, unknown>, opts);
  }

  /**
   * Replace the observer's server-side event filters.
   *
   * Scoped to the events topic, so it never disturbs the room's other
   * subscriptions — notably `inbox`, whose messages are published unfiltered
   * and would stop arriving if this were applied room-wide.
   *
   * An empty array restores the wildcard subscription, which receives every
   * event on the room.
   */
  setFilters(values: FilterValue[]): void {
    this._room.setFilters(values, { topic: "events" });
  }

  /**
   * Listen for events, optionally filtered by category or severity.
   */
  on(
    handler: (envelope: EventEnvelope) => void,
    filter?: { category?: string; severity?: EventEnvelope["severity"] },
  ): void {
    this._room.on("event", (envelope) => {
      if (filter?.category && envelope.category !== filter.category) return;
      if (filter?.severity && envelope.severity !== filter.severity) return;
      handler(envelope);
    });
  }
}
