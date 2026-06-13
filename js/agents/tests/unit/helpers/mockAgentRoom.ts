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

export function createMockAgentRoom(agents: Array<{ capabilities: string[]; protocol?: number }> = [{ capabilities: ["*"] }]) {
  const emitter = new MockRoomEmitter();
  const published: Array<{ method: string; data: unknown; options?: unknown }> = [];

  const connectedAgents = agents.map((a, i) => ({
    actorId: `actor-${i}`,
    name: `agent-${i}`,
    role: "agent",
    capabilities: a.capabilities,
    connectedAt: 0,
    protocol: a.protocol ?? 2,
  }));

  const room = {
    name: "test-room",
    agentId: "test-agent",
    on: emitter.on.bind(emitter),
    off: emitter.off.bind(emitter),
    // Presence-based service discovery (used by Handoff.dispatch)
    getConnectedAgents: () => connectedAgents,
    findAgents: (capability: string) =>
      connectedAgents.filter((a) => a.capabilities.includes("*") || a.capabilities.includes(capability)),
    getAvailableCapabilities: () => [...new Set(connectedAgents.flatMap((a) => a.capabilities))],
    hasCapability: (capability: string) =>
      connectedAgents.some((a) => a.capabilities.includes("*") || a.capabilities.includes(capability)),
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
