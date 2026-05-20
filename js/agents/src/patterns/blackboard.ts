import type { AgentRoom } from "../AgentRoom";
import type { StateEnvelope } from "../types";
import { createStateEnvelope } from "../envelope";

/**
 * Blackboard pattern — shared state across agents.
 *
 * Agents read and write key-value pairs visible to all room participants.
 * Uses retained messages so state is available on join.
 */
export class Blackboard {
  private _room: AgentRoom;
  private _agentId: string;
  private _state = new Map<string, StateEnvelope>();

  constructor(room: AgentRoom, agentId: string) {
    this._room = room;
    this._agentId = agentId;

    this._room.on("stateChange", (envelope) => {
      this._state.set(envelope.key, envelope);
    });
  }

  /**
   * Set a shared state value.
   */
  set(key: string, value: unknown): void {
    const existing = this._state.get(key);
    const version = existing ? existing.version + 1 : 1;
    const envelope = createStateEnvelope(key, value, version, this._agentId);
    this._state.set(key, envelope);
    this._room.publishState(envelope as unknown as Record<string, unknown>);
  }

  /**
   * Get a shared state value.
   */
  get(key: string): unknown | undefined {
    return this._state.get(key)?.value;
  }

  /**
   * Get the full state envelope for a key.
   */
  getEnvelope(key: string): StateEnvelope | undefined {
    return this._state.get(key);
  }

  /**
   * Get all state entries.
   */
  getAll(): ReadonlyMap<string, StateEnvelope> {
    return this._state;
  }

  /**
   * Register a handler for state changes on a specific key.
   */
  onChange(
    key: string,
    handler: (envelope: StateEnvelope) => void,
  ): void {
    this._room.on("stateChange", (envelope) => {
      if (envelope.key === key) {
        handler(envelope);
      }
    });
  }
}
