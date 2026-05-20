import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockAgentRoom } from "../helpers/mockAgentRoom";
import { Observe } from "../../../src/patterns/observe";
import type { EventEnvelope } from "../../../src/types";

describe("Observe pattern", () => {
  let room: ReturnType<typeof createMockAgentRoom>;
  let observe: Observe;

  beforeEach(() => {
    room = createMockAgentRoom();
    observe = new Observe(room, "agent-1");
  });

  // --- emit ---

  it("publishes an event envelope on emit", () => {
    observe.emit("task-started", { taskId: "t1" });
    const published = room.getPublished();
    expect(published).toHaveLength(1);
    expect(published[0].method).toBe("publishEvent");
    const event = published[0].data as EventEnvelope;
    expect(event.type).toBe("event");
    expect(event.category).toBe("task-started");
    expect(event.emittedBy).toBe("agent-1");
    expect(event.severity).toBe("info");
    expect(event.payload).toEqual({ taskId: "t1" });
  });

  it("uses provided severity", () => {
    observe.emit("error-occurred", { msg: "fail" }, "error");
    const event = room.getPublished()[0].data as EventEnvelope;
    expect(event.severity).toBe("error");
  });

  it("supports all severity levels", () => {
    const severities: EventEnvelope["severity"][] = ["debug", "info", "warning", "error", "critical"];
    for (const sev of severities) {
      room.clearPublished();
      observe.emit("test", {}, sev);
      const event = room.getPublished()[0].data as EventEnvelope;
      expect(event.severity).toBe(sev);
    }
  });

  // --- on ---

  it("receives all events without filter", () => {
    const handler = vi.fn();
    observe.on(handler);

    const event: EventEnvelope = {
      type: "event",
      eventId: "e1",
      severity: "info",
      category: "progress",
      emittedBy: "agent-2",
      payload: { pct: 50 },
      timestamp: Date.now(),
    };
    room.simulate("event", event);

    expect(handler).toHaveBeenCalledWith(event);
  });

  it("filters by category", () => {
    const handler = vi.fn();
    observe.on(handler, { category: "progress" });

    room.simulate("event", {
      type: "event",
      eventId: "e1",
      severity: "info",
      category: "progress",
      emittedBy: "agent-2",
      payload: {},
      timestamp: Date.now(),
    } as EventEnvelope);

    room.simulate("event", {
      type: "event",
      eventId: "e2",
      severity: "info",
      category: "error",
      emittedBy: "agent-2",
      payload: {},
      timestamp: Date.now(),
    } as EventEnvelope);

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("filters by severity", () => {
    const handler = vi.fn();
    observe.on(handler, { severity: "error" });

    room.simulate("event", {
      type: "event",
      eventId: "e1",
      severity: "info",
      category: "x",
      emittedBy: "agent-2",
      payload: {},
      timestamp: Date.now(),
    } as EventEnvelope);

    room.simulate("event", {
      type: "event",
      eventId: "e2",
      severity: "error",
      category: "x",
      emittedBy: "agent-2",
      payload: {},
      timestamp: Date.now(),
    } as EventEnvelope);

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("filters by both category and severity", () => {
    const handler = vi.fn();
    observe.on(handler, { category: "db", severity: "error" });

    room.simulate("event", {
      type: "event", eventId: "e1", severity: "error", category: "db",
      emittedBy: "a", payload: {}, timestamp: Date.now(),
    } as EventEnvelope);
    room.simulate("event", {
      type: "event", eventId: "e2", severity: "info", category: "db",
      emittedBy: "a", payload: {}, timestamp: Date.now(),
    } as EventEnvelope);
    room.simulate("event", {
      type: "event", eventId: "e3", severity: "error", category: "net",
      emittedBy: "a", payload: {}, timestamp: Date.now(),
    } as EventEnvelope);

    expect(handler).toHaveBeenCalledTimes(1);
  });

  // --- edge cases ---

  it("multiple on handlers with different filters both called when event matches both", () => {
    const handler1 = vi.fn();
    const handler2 = vi.fn();
    observe.on(handler1, { category: "db" });
    observe.on(handler2, { severity: "error" });

    room.simulate("event", {
      type: "event",
      eventId: "e1",
      severity: "error",
      category: "db",
      emittedBy: "agent-2",
      payload: {},
      timestamp: Date.now(),
    } as EventEnvelope);

    expect(handler1).toHaveBeenCalledTimes(1);
    expect(handler2).toHaveBeenCalledTimes(1);
  });

  it("emit generates unique event IDs for each emitted event", () => {
    observe.emit("event-a", { x: 1 });
    observe.emit("event-b", { x: 2 });
    const published = room.getPublished();
    const id1 = (published[0].data as EventEnvelope).eventId;
    const id2 = (published[1].data as EventEnvelope).eventId;
    expect(id1).toBeDefined();
    expect(id2).toBeDefined();
    expect(id1).not.toBe(id2);
  });

  it("emittedBy is set to the agentId provided at construction", () => {
    const monitor = new Observe(room, "monitor-1");
    monitor.emit("health-check", { status: "ok" });
    const event = room.getPublished()[0].data as EventEnvelope;
    expect(event.emittedBy).toBe("monitor-1");
  });
});
