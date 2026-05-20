import type { AgentRoom } from "../AgentRoom";
import type { EventEnvelope } from "../types";
import { createEventEnvelope } from "../envelope";

/**
 * Observe pattern — emit and listen to observability events.
 *
 * Agents emit structured events; observers/dashboards subscribe to the stream.
 * Events have severity, category, and emittedBy for filtering.
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
   */
  emit(
    category: string,
    payload: Record<string, unknown>,
    severity: EventEnvelope["severity"] = "info",
  ): void {
    const envelope = createEventEnvelope(category, this._emittedBy, payload, severity);
    this._room.publishEvent(envelope as unknown as Record<string, unknown>);
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
