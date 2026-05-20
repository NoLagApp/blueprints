import { EventEmitter } from "../../../src/EventEmitter";
import type { AgentRoomEvents } from "../../../src/types";

class MockRoomEmitter extends EventEmitter<AgentRoomEvents> {
  /** Expose emit publicly for test simulation */
  public simulate<K extends keyof AgentRoomEvents>(
    event: K,
    ...args: AgentRoomEvents[K]
  ): void {
    this.emit(event, ...args);
  }
}

export function createMockAgentRoom() {
  const emitter = new MockRoomEmitter();
  const published: Array<{ method: string; data: unknown; options?: unknown }> = [];

  const room = {
    name: "test-room",
    on: emitter.on.bind(emitter),
    off: emitter.off.bind(emitter),
    publishTask: (d: unknown) => published.push({ method: "publishTask", data: d }),
    publishResult: (d: unknown) => published.push({ method: "publishResult", data: d }),
    publishState: (d: unknown) => published.push({ method: "publishState", data: d }),
    publishEvent: (d: unknown) => published.push({ method: "publishEvent", data: d }),
    publishInbox: (d: unknown) => published.push({ method: "publishInbox", data: d }),
    publishTools: (d: unknown) => published.push({ method: "publishTools", data: d }),
    publishApproval: (d: unknown) => published.push({ method: "publishApproval", data: d }),
    simulate: <K extends keyof AgentRoomEvents>(
      event: K,
      ...args: AgentRoomEvents[K]
    ) => emitter.simulate(event, ...args),
    getPublished: () => published,
    clearPublished: () => (published.length = 0),
  };

  return room as any;
}
