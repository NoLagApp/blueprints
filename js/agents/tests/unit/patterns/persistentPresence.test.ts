import { describe, it, expect } from "vitest";
import { createMockAgentRoom } from "../helpers/mockAgentRoom";
import { Handoff } from "../../../src/patterns/handoff";

// Persistent Presence E2E (js agents consumer): the Handoff gate proceeds-and-
// wakes for an offline persistent agent by default, and requireOnline restores
// strict behaviour. Mirrors the kraken full_loop / SDK status tests.
describe("Persistent Presence — Handoff gate", () => {
  it("proceeds-and-wakes: dispatch to an OFFLINE persistent agent does not throw", async () => {
    const room = createMockAgentRoom([{ capabilities: ["soil_analysis"], status: "offline" }]);
    const h = new Handoff(room);
    await h.dispatch("soil_analysis", { sample: 1 });
    const published = room.getPublished();
    expect(published).toHaveLength(1);
    expect(published[0].method).toBe("publishTask");
  });

  it("requireOnline: throws when only an OFFLINE agent is capable", async () => {
    const room = createMockAgentRoom([{ capabilities: ["soil_analysis"], status: "offline" }]);
    const h = new Handoff(room);
    await expect(
      h.dispatch("soil_analysis", { sample: 1 }, { requireOnline: true }),
    ).rejects.toThrow(/online agent/);
    expect(room.getPublished()).toHaveLength(0);
  });

  it("requireOnline: proceeds when an ONLINE agent is capable", async () => {
    const room = createMockAgentRoom([{ capabilities: ["soil_analysis"], status: "online" }]);
    const h = new Handoff(room);
    await h.dispatch("soil_analysis", { sample: 1 }, { requireOnline: true });
    expect(room.getPublished()).toHaveLength(1);
  });

  it("default gate still throws when NO capable agent exists at all", async () => {
    const room = createMockAgentRoom([{ capabilities: ["other"], status: "online" }]);
    const h = new Handoff(room);
    await expect(h.dispatch("soil_analysis", { sample: 1 })).rejects.toThrow(/capability/);
    expect(room.getPublished()).toHaveLength(0);
  });
});
