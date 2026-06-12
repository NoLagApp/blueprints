import { describe, it, expect, vi, beforeEach } from "vitest";
import { AgentRoom } from "../../src/AgentRoom";

function createMockRoomContext() {
  const listeners = new Map<string, Array<(data: any) => void>>();
  return {
    on: vi.fn((topic: string, handler: (data: any) => void) => {
      if (!listeners.has(topic)) listeners.set(topic, []);
      listeners.get(topic)!.push(handler);
    }),
    emit: vi.fn(),
    subscribe: vi.fn(),
    setPresence: vi.fn(),
    fetchPresence: vi.fn().mockResolvedValue([]),
    // Helper to simulate incoming messages
    _trigger(topic: string, data: any) {
      for (const h of listeners.get(topic) ?? []) h(data);
    },
  };
}

function createMockClient() {
  return { on: vi.fn(), off: vi.fn() };
}

const AGENT_ID = "agent-under-test";

describe("AgentRoom", () => {
  let ctx: ReturnType<typeof createMockRoomContext>;
  let room: AgentRoom;
  const log = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    ctx = createMockRoomContext();
    room = new AgentRoom("test-room", ctx, createMockClient(), log, AGENT_ID);
  });

  // --- Subscription semantics (load balancing + directed replies) ---

  it("subscribes work-distribution topics with connection-default load balancing", () => {
    // tasks + tools must NOT force loadBalance off — pools share these one-of-N
    expect(ctx.subscribe).toHaveBeenCalledWith("tasks");
    expect(ctx.subscribe).toHaveBeenCalledWith("tools");
  });

  it("subscribes results with own-agentId filter and loadBalance disabled", () => {
    expect(ctx.subscribe).toHaveBeenCalledWith("results", {
      loadBalance: false,
      filters: [AGENT_ID],
    });
  });

  it("subscribes broadcast topics with loadBalance disabled", () => {
    for (const topic of ["state", "events", "inbox", "approval"]) {
      expect(ctx.subscribe).toHaveBeenCalledWith(topic, { loadBalance: false });
    }
  });

  // --- Simple topic wiring ---

  it("emits 'task' when tasks topic receives data", () => {
    const handler = vi.fn();
    room.on("task", handler);
    const data = { type: "task", taskId: "t1", capability: "review" };
    ctx._trigger("tasks", data);
    expect(handler).toHaveBeenCalledWith(data);
  });

  it("emits 'result' when results topic receives data", () => {
    const handler = vi.fn();
    room.on("result", handler);
    const data = { type: "result", taskId: "t1" };
    ctx._trigger("results", data);
    expect(handler).toHaveBeenCalledWith(data);
  });

  it("emits 'stateChange' when state topic receives data", () => {
    const handler = vi.fn();
    room.on("stateChange", handler);
    const data = { type: "state", key: "status" };
    ctx._trigger("state", data);
    expect(handler).toHaveBeenCalledWith(data);
  });

  it("emits 'event' when events topic receives data", () => {
    const handler = vi.fn();
    room.on("event", handler);
    const data = { type: "event", category: "progress" };
    ctx._trigger("events", data);
    expect(handler).toHaveBeenCalledWith(data);
  });

  it("emits 'inbox' when inbox topic receives data", () => {
    const handler = vi.fn();
    room.on("inbox", handler);
    const data = { messageId: "m1", to: "agent-1" };
    ctx._trigger("inbox", data);
    expect(handler).toHaveBeenCalledWith(data);
  });

  // --- Multiplexed: approval ---

  it("emits 'approvalRequest' for approval_request type", () => {
    const reqHandler = vi.fn();
    const resHandler = vi.fn();
    room.on("approvalRequest", reqHandler);
    room.on("approvalResponse", resHandler);
    const data = { type: "approval_request", requestId: "r1" };
    ctx._trigger("approval", data);
    expect(reqHandler).toHaveBeenCalledWith(data);
    expect(resHandler).not.toHaveBeenCalled();
  });

  it("emits 'approvalResponse' for approval_response type", () => {
    const reqHandler = vi.fn();
    const resHandler = vi.fn();
    room.on("approvalRequest", reqHandler);
    room.on("approvalResponse", resHandler);
    const data = { type: "approval_response", requestId: "r1", decision: "approved" };
    ctx._trigger("approval", data);
    expect(resHandler).toHaveBeenCalledWith(data);
    expect(reqHandler).not.toHaveBeenCalled();
  });

  // --- Multiplexed: tools requests + directed responses ---

  it("emits 'toolRequest' for tool_request type on tools topic", () => {
    const reqHandler = vi.fn();
    const resHandler = vi.fn();
    room.on("toolRequest", reqHandler);
    room.on("toolResponse", resHandler);
    const data = { type: "tool_request", toolName: "search" };
    ctx._trigger("tools", data);
    expect(reqHandler).toHaveBeenCalledWith(data);
    expect(resHandler).not.toHaveBeenCalled();
  });

  it("emits 'toolResponse' for tool_response arriving on results topic (directed reply)", () => {
    const resultHandler = vi.fn();
    const resHandler = vi.fn();
    room.on("result", resultHandler);
    room.on("toolResponse", resHandler);
    const data = { type: "tool_response", result: 42, replyTo: AGENT_ID };
    ctx._trigger("results", data);
    expect(resHandler).toHaveBeenCalledWith(data);
    expect(resultHandler).not.toHaveBeenCalled();
  });

  it("still emits 'toolResponse' for legacy tool_response on tools topic", () => {
    const reqHandler = vi.fn();
    const resHandler = vi.fn();
    room.on("toolRequest", reqHandler);
    room.on("toolResponse", resHandler);
    const data = { type: "tool_response", result: 42 };
    ctx._trigger("tools", data);
    expect(resHandler).toHaveBeenCalledWith(data);
    expect(reqHandler).not.toHaveBeenCalled();
  });

  // --- Publish methods ---

  it("publishTask calls roomContext.emit with tasks topic", () => {
    const envelope = { type: "task" as const, taskId: "t1", correlationId: "c1", capability: "x", priority: "medium" as const, payload: {}, createdAt: Date.now() };
    room.publishTask(envelope as any);
    expect(ctx.emit).toHaveBeenCalledWith("tasks", expect.objectContaining({ taskId: "t1" }));
  });

  it("publishState calls roomContext.emit with retain option", () => {
    const data = { key: "status", value: "active" };
    room.publishState(data);
    expect(ctx.emit).toHaveBeenCalledWith("state", expect.objectContaining(data), { retain: true });
  });

  it("publishApproval calls roomContext.emit with retain option", () => {
    const data = { type: "approval_request", action: "deploy" };
    room.publishApproval(data);
    expect(ctx.emit).toHaveBeenCalledWith("approval", data, { retain: true });
  });

  it("publishEvent calls roomContext.emit without retain", () => {
    const data = { type: "event", category: "log" };
    room.publishEvent(data);
    expect(ctx.emit).toHaveBeenCalledWith("events", expect.objectContaining(data));
  });

  it("publishTools sends tool requests on the tools topic", () => {
    const data = { type: "tool_request", toolName: "search" };
    room.publishTools(data);
    expect(ctx.emit).toHaveBeenCalledWith("tools", data);
  });

  it("publishTools directs tool responses to the requester via results filter", () => {
    const data = { type: "tool_response", result: 42, replyTo: "requester-1" };
    room.publishTools(data);
    expect(ctx.emit).toHaveBeenCalledWith("results", data, { filter: "requester-1" });
  });

  it("publishTools falls back to tools topic for responses without replyTo (legacy)", () => {
    const data = { type: "tool_response", result: 42 };
    room.publishTools(data);
    expect(ctx.emit).toHaveBeenCalledWith("tools", data);
  });

  it("publishResult directs results to the dispatcher via filter when replyTo is set", () => {
    const envelope = { type: "result" as const, taskId: "t1", correlationId: "c1", status: "success" as const, payload: {}, completedAt: Date.now(), replyTo: "dispatcher-1" };
    room.publishResult(envelope as any);
    expect(ctx.emit).toHaveBeenCalledWith("results", expect.objectContaining({ taskId: "t1" }), { filter: "dispatcher-1" });
  });

  it("publishResult publishes unfiltered when replyTo is missing (legacy)", () => {
    const envelope = { type: "result" as const, taskId: "t1", correlationId: "c1", status: "success" as const, payload: {}, completedAt: Date.now() };
    room.publishResult(envelope as any);
    expect(ctx.emit).toHaveBeenCalledWith("results", expect.objectContaining({ taskId: "t1" }));
  });

  it("exposes the underlying room context", () => {
    expect(room.context).toBe(ctx);
  });

  // --- Multiple listeners ---

  it("multiple listeners on same event both fire", () => {
    const handler1 = vi.fn();
    const handler2 = vi.fn();
    room.on("task", handler1);
    room.on("task", handler2);
    const data = { type: "task", taskId: "t2", capability: "review" };
    ctx._trigger("tasks", data);
    expect(handler1).toHaveBeenCalledWith(data);
    expect(handler2).toHaveBeenCalledWith(data);
  });

  // --- removeAllListeners ---

  it("removeAllListeners clears all EventEmitter handlers", () => {
    const taskHandler = vi.fn();
    const resultHandler = vi.fn();
    room.on("task", taskHandler);
    room.on("result", resultHandler);
    room.removeAllListeners();
    ctx._trigger("tasks", { type: "task" });
    ctx._trigger("results", { type: "result" });
    expect(taskHandler).not.toHaveBeenCalled();
    expect(resultHandler).not.toHaveBeenCalled();
  });

  // --- Logging ---

  it("log is called with 'publish' string on publishTask", () => {
    const envelope = { type: "task" as const, taskId: "t1", correlationId: "c1", capability: "x", priority: "medium" as const, payload: {}, createdAt: Date.now() };
    room.publishTask(envelope as any);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("publish"));
  });

  it("log is called with 'received' string when tasks topic fires", () => {
    ctx._trigger("tasks", { type: "task", taskId: "t1" });
    expect(log).toHaveBeenCalledWith(expect.stringContaining("received"));
  });

  // --- publishInbox without retain ---

  it("publishInbox calls roomContext.emit without retain", () => {
    const data = { messageId: "m1", to: "agent-1", body: "hello" };
    room.publishInbox(data);
    expect(ctx.emit).toHaveBeenCalledWith("inbox", data);
  });

  // --- Approval multiplexing: unknown type defaults to approvalRequest ---

  it("approval topic with unknown type defaults to approvalRequest", () => {
    const reqHandler = vi.fn();
    const resHandler = vi.fn();
    room.on("approvalRequest", reqHandler);
    room.on("approvalResponse", resHandler);
    const data = { type: "unknown", requestId: "r99" };
    ctx._trigger("approval", data);
    expect(reqHandler).toHaveBeenCalledWith(data);
    expect(resHandler).not.toHaveBeenCalled();
  });

  // --- Tools multiplexing: missing type defaults to toolRequest ---

  it("tools topic with missing type defaults to toolRequest", () => {
    const reqHandler = vi.fn();
    const resHandler = vi.fn();
    room.on("toolRequest", reqHandler);
    room.on("toolResponse", resHandler);
    const data = { toolName: "search" };
    ctx._trigger("tools", data);
    expect(reqHandler).toHaveBeenCalledWith(data);
    expect(resHandler).not.toHaveBeenCalled();
  });
});
