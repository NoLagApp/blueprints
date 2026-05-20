import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockAgentRoom } from "../helpers/mockAgentRoom";
import { Blackboard } from "../../../src/patterns/blackboard";
import type { StateEnvelope } from "../../../src/types";

describe("Blackboard pattern", () => {
  let room: ReturnType<typeof createMockAgentRoom>;
  let board: Blackboard;

  beforeEach(() => {
    room = createMockAgentRoom();
    board = new Blackboard(room, "agent-1");
  });

  // --- set ---

  it("publishes a state envelope on set", () => {
    board.set("status", "active");
    const published = room.getPublished();
    expect(published).toHaveLength(1);
    expect(published[0].method).toBe("publishState");
    const state = published[0].data as StateEnvelope;
    expect(state.type).toBe("state");
    expect(state.key).toBe("status");
    expect(state.value).toBe("active");
    expect(state.version).toBe(1);
    expect(state.updatedBy).toBe("agent-1");
  });

  it("increments version on successive sets", () => {
    board.set("status", "active");
    board.set("status", "idle");
    const states = room.getPublished().map((p) => p.data as StateEnvelope);
    expect(states[0].version).toBe(1);
    expect(states[1].version).toBe(2);
  });

  // --- get ---

  it("returns undefined for unknown keys", () => {
    expect(board.get("nonexistent")).toBeUndefined();
  });

  it("returns the set value", () => {
    board.set("count", 42);
    expect(board.get("count")).toBe(42);
  });

  // --- getEnvelope ---

  it("returns full envelope for a key", () => {
    board.set("name", "test");
    const envelope = board.getEnvelope("name");
    expect(envelope).toBeDefined();
    expect(envelope!.key).toBe("name");
    expect(envelope!.value).toBe("test");
    expect(envelope!.version).toBe(1);
  });

  // --- getAll ---

  it("returns all state entries", () => {
    board.set("a", 1);
    board.set("b", 2);
    const all = board.getAll();
    expect(all.size).toBe(2);
    expect(all.get("a")?.value).toBe(1);
    expect(all.get("b")?.value).toBe(2);
  });

  // --- remote updates (stateChange) ---

  it("updates local state on remote stateChange", () => {
    const remoteState: StateEnvelope = {
      type: "state",
      key: "status",
      value: "busy",
      version: 5,
      updatedBy: "agent-2",
      updatedAt: Date.now(),
    };
    room.simulate("stateChange", remoteState);

    expect(board.get("status")).toBe("busy");
    expect(board.getEnvelope("status")?.version).toBe(5);
  });

  it("remote update increments from remote version on next local set", () => {
    room.simulate("stateChange", {
      type: "state",
      key: "count",
      value: 10,
      version: 3,
      updatedBy: "agent-2",
      updatedAt: Date.now(),
    } as StateEnvelope);

    board.set("count", 11);
    const state = room.getPublished()[0].data as StateEnvelope;
    expect(state.version).toBe(4);
  });

  // --- onChange ---

  it("calls onChange handler for matching key", () => {
    const handler = vi.fn();
    board.onChange("status", handler);

    room.simulate("stateChange", {
      type: "state",
      key: "status",
      value: "done",
      version: 1,
      updatedBy: "agent-2",
      updatedAt: Date.now(),
    } as StateEnvelope);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0].value).toBe("done");
  });

  it("does not call onChange handler for non-matching key", () => {
    const handler = vi.fn();
    board.onChange("status", handler);

    room.simulate("stateChange", {
      type: "state",
      key: "other",
      value: "x",
      version: 1,
      updatedBy: "agent-2",
      updatedAt: Date.now(),
    } as StateEnvelope);

    expect(handler).not.toHaveBeenCalled();
  });

  // --- edge cases ---

  it("set with complex object values", () => {
    const nested = { nested: { deep: [1, 2, 3] } };
    board.set("config", nested);
    expect(board.get("config")).toEqual(nested);
  });

  it("getEnvelope returns undefined for unset keys", () => {
    expect(board.getEnvelope("nonexistent")).toBeUndefined();
  });

  it("multiple onChange handlers on same key all receive the update", () => {
    const handler1 = vi.fn();
    const handler2 = vi.fn();
    board.onChange("status", handler1);
    board.onChange("status", handler2);

    const stateChange: StateEnvelope = {
      type: "state",
      key: "status",
      value: "running",
      version: 1,
      updatedBy: "agent-2",
      updatedAt: Date.now(),
    };
    room.simulate("stateChange", stateChange);

    expect(handler1).toHaveBeenCalledTimes(1);
    expect(handler1.mock.calls[0][0].value).toBe("running");
    expect(handler2).toHaveBeenCalledTimes(1);
    expect(handler2.mock.calls[0][0].value).toBe("running");
  });
});
