import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockAgentRoom } from "../helpers/mockAgentRoom";
import { Tools } from "../../../src/patterns/tools";
import type { ToolRequestEnvelope, ToolResponseEnvelope } from "../../../src/types";

describe("Tools pattern", () => {
  let room: ReturnType<typeof createMockAgentRoom>;
  let tools: Tools;

  beforeEach(() => {
    room = createMockAgentRoom();
    tools = new Tools(room, "agent-1");
  });

  // --- register ---

  it("registers a tool handler", () => {
    tools.register("search", async () => ({ results: [] }));
    // No error = success; internal handlers map is populated
  });

  // --- invoke ---

  it("publishes a tool request on invoke", () => {
    const promise = tools.invoke("search", { query: "test" }, { timeout: 5000 });

    const published = room.getPublished();
    expect(published).toHaveLength(1);
    expect(published[0].method).toBe("publishTools");
    const req = published[0].data as ToolRequestEnvelope;
    expect(req.type).toBe("tool_request");
    expect(req.toolName).toBe("search");
    expect(req.arguments).toEqual({ query: "test" });
    expect(req.requestedBy).toBe("agent-1");

    // Resolve to avoid hanging
    room.simulate("toolResponse", {
      type: "tool_response",
      requestId: req.requestId,
      correlationId: req.correlationId,
      status: "success",
      result: [],
      respondedAt: Date.now(),
    } as ToolResponseEnvelope);

    return promise;
  });

  it("resolves with tool response", async () => {
    const promise = tools.invoke("search", { query: "test" });
    const req = room.getPublished()[0].data as ToolRequestEnvelope;

    const response: ToolResponseEnvelope = {
      type: "tool_response",
      requestId: req.requestId,
      correlationId: req.correlationId,
      status: "success",
      result: { data: [1, 2, 3] },
      respondedAt: Date.now(),
    };
    room.simulate("toolResponse", response);

    const result = await promise;
    expect(result.status).toBe("success");
    expect(result.result).toEqual({ data: [1, 2, 3] });
  });

  it("times out if no response is received", async () => {
    const promise = tools.invoke("search", {}, { timeout: 50 });
    await expect(promise).rejects.toThrow("timed out");
  });

  it("ignores responses with non-matching correlationId", async () => {
    const promise = tools.invoke("search", {}, { timeout: 100 });

    room.simulate("toolResponse", {
      type: "tool_response",
      requestId: "wrong",
      correlationId: "wrong-id",
      status: "success",
      result: null,
      respondedAt: Date.now(),
    } as ToolResponseEnvelope);

    await expect(promise).rejects.toThrow("timed out");
  });

  // --- request handling ---

  it("handles incoming tool requests for registered tools", async () => {
    tools.register("search", async (args) => ({ results: [args.query] }));

    const request: ToolRequestEnvelope = {
      type: "tool_request",
      requestId: "r1",
      correlationId: "c1",
      toolName: "search",
      arguments: { query: "hello" },
      requestedBy: "agent-2",
      requestedAt: Date.now(),
    };
    room.simulate("toolRequest", request);

    // Wait for async handler to complete
    await new Promise((r) => setTimeout(r, 10));

    const published = room.getPublished();
    expect(published).toHaveLength(1);
    expect(published[0].method).toBe("publishTools");
    const response = published[0].data as ToolResponseEnvelope;
    expect(response.type).toBe("tool_response");
    expect(response.requestId).toBe("r1");
    expect(response.correlationId).toBe("c1");
    expect(response.status).toBe("success");
    expect(response.result).toEqual({ results: ["hello"] });
    expect(response.respondedBy).toBe("agent-1");
  });

  it("handles sync tool handlers", async () => {
    tools.register("add", (args) => (args.a as number) + (args.b as number));

    room.simulate("toolRequest", {
      type: "tool_request",
      requestId: "r1",
      correlationId: "c1",
      toolName: "add",
      arguments: { a: 2, b: 3 },
      requestedBy: "agent-2",
      requestedAt: Date.now(),
    } as ToolRequestEnvelope);

    await new Promise((r) => setTimeout(r, 10));

    const response = room.getPublished()[0].data as ToolResponseEnvelope;
    expect(response.status).toBe("success");
    expect(response.result).toBe(5);
  });

  it("ignores requests for unregistered tools", async () => {
    room.simulate("toolRequest", {
      type: "tool_request",
      requestId: "r1",
      correlationId: "c1",
      toolName: "unknown",
      arguments: {},
      requestedBy: "agent-2",
      requestedAt: Date.now(),
    } as ToolRequestEnvelope);

    await new Promise((r) => setTimeout(r, 10));
    expect(room.getPublished()).toHaveLength(0);
  });

  it("returns error response when handler throws", async () => {
    tools.register("fail", async () => {
      throw new Error("something broke");
    });

    room.simulate("toolRequest", {
      type: "tool_request",
      requestId: "r1",
      correlationId: "c1",
      toolName: "fail",
      arguments: {},
      requestedBy: "agent-2",
      requestedAt: Date.now(),
    } as ToolRequestEnvelope);

    await new Promise((r) => setTimeout(r, 10));

    const response = room.getPublished()[0].data as ToolResponseEnvelope;
    expect(response.status).toBe("error");
    expect(response.result).toBeNull();
    expect(response.error).toEqual({ code: "TOOL_ERROR", message: "something broke" });
  });

  it("returns error response when handler throws non-Error", async () => {
    tools.register("fail", async () => {
      throw "string error";
    });

    room.simulate("toolRequest", {
      type: "tool_request",
      requestId: "r1",
      correlationId: "c1",
      toolName: "fail",
      arguments: {},
      requestedBy: "agent-2",
      requestedAt: Date.now(),
    } as ToolRequestEnvelope);

    await new Promise((r) => setTimeout(r, 10));

    const response = room.getPublished()[0].data as ToolResponseEnvelope;
    expect(response.error?.message).toBe("string error");
  });

  // --- full round-trip ---

  it("full round-trip: invoke -> handler -> response -> resolve", async () => {
    // Provider registers a tool
    const provider = new Tools(room, "provider-1");
    provider.register("multiply", (args) => (args.a as number) * (args.b as number));

    // Invoker calls the tool
    const promise = tools.invoke("multiply", { a: 3, b: 7 });
    const req = room.getPublished()[0].data as ToolRequestEnvelope;

    // Simulate request reaching the provider
    room.simulate("toolRequest", req);
    await new Promise((r) => setTimeout(r, 10));

    // Simulate response reaching the invoker
    const responseData = room.getPublished()[1].data as ToolResponseEnvelope;
    room.simulate("toolResponse", responseData);

    const result = await promise;
    expect(result.status).toBe("success");
    expect(result.result).toBe(21);
  });

  // --- dispose ---

  it("cancels pending correlations on dispose", async () => {
    const promise = tools.invoke("search", {});
    tools.dispose();
    await expect(promise).rejects.toThrow("cancelled");
  });

  it("clears handlers on dispose", async () => {
    tools.register("search", async () => ({}));
    tools.dispose();

    room.simulate("toolRequest", {
      type: "tool_request",
      requestId: "r1",
      correlationId: "c1",
      toolName: "search",
      arguments: {},
      requestedBy: "agent-2",
      requestedAt: Date.now(),
    } as ToolRequestEnvelope);

    await new Promise((r) => setTimeout(r, 10));
    expect(room.getPublished()).toHaveLength(0);
  });

  // --- edge cases ---

  it("register overwrites existing handler with new one", async () => {
    const handler1 = vi.fn(async () => ({ from: "handler1" }));
    const handler2 = vi.fn(async () => ({ from: "handler2" }));
    tools.register("search", handler1);
    tools.register("search", handler2);

    room.simulate("toolRequest", {
      type: "tool_request",
      requestId: "r1",
      correlationId: "c1",
      toolName: "search",
      arguments: {},
      requestedBy: "agent-2",
      requestedAt: Date.now(),
    } as ToolRequestEnvelope);

    await new Promise((r) => setTimeout(r, 10));

    expect(handler1).not.toHaveBeenCalled();
    expect(handler2).toHaveBeenCalledTimes(1);
    const response = room.getPublished()[0].data as ToolResponseEnvelope;
    expect(response.result).toEqual({ from: "handler2" });
  });

  it("invoke without timeout resolves when response arrives", async () => {
    const promise = tools.invoke("search", { query: "hello" });
    const req = room.getPublished()[0].data as ToolRequestEnvelope;

    room.simulate("toolResponse", {
      type: "tool_response",
      requestId: req.requestId,
      correlationId: req.correlationId,
      status: "success",
      result: { found: true },
      respondedAt: Date.now(),
    } as ToolResponseEnvelope);

    const result = await promise;
    expect(result.status).toBe("success");
    expect(result.result).toEqual({ found: true });
  });

  it("multiple concurrent invokes all resolve with correct results", async () => {
    const p1 = tools.invoke("tool-a", { n: 1 });
    const p2 = tools.invoke("tool-b", { n: 2 });
    const p3 = tools.invoke("tool-c", { n: 3 });

    const published = room.getPublished();
    const reqs = published.map((p) => p.data as ToolRequestEnvelope);

    const makeResponse = (req: ToolRequestEnvelope, value: number): ToolResponseEnvelope => ({
      type: "tool_response",
      requestId: req.requestId,
      correlationId: req.correlationId,
      status: "success",
      result: { value },
      respondedAt: Date.now(),
    });

    room.simulate("toolResponse", makeResponse(reqs[0], 100));
    room.simulate("toolResponse", makeResponse(reqs[1], 200));
    room.simulate("toolResponse", makeResponse(reqs[2], 300));

    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
    expect(r1.result).toEqual({ value: 100 });
    expect(r2.result).toEqual({ value: 200 });
    expect(r3.result).toEqual({ value: 300 });
  });

  it("handler receives exact arguments from the tool request", async () => {
    let receivedArgs: Record<string, unknown> = {};
    tools.register("compute", async (args) => {
      receivedArgs = args;
      return {};
    });

    room.simulate("toolRequest", {
      type: "tool_request",
      requestId: "r1",
      correlationId: "c1",
      toolName: "compute",
      arguments: { x: 1, y: 2 },
      requestedBy: "agent-2",
      requestedAt: Date.now(),
    } as ToolRequestEnvelope);

    await new Promise((r) => setTimeout(r, 10));
    expect(receivedArgs).toEqual({ x: 1, y: 2 });
  });

  it("dispose then re-register allows new handler to respond", async () => {
    tools.register("search", async () => ({ old: true }));
    tools.dispose();

    // Re-register after dispose
    tools.register("search", async () => ({ new: true }));

    room.simulate("toolRequest", {
      type: "tool_request",
      requestId: "r1",
      correlationId: "c1",
      toolName: "search",
      arguments: {},
      requestedBy: "agent-2",
      requestedAt: Date.now(),
    } as ToolRequestEnvelope);

    await new Promise((r) => setTimeout(r, 10));
    const response = room.getPublished()[0].data as ToolResponseEnvelope;
    expect(response.status).toBe("success");
    expect(response.result).toEqual({ new: true });
  });
});

describe("NO_HANDLER NACK and protocol gating (v0.3.0)", () => {
  let room: ReturnType<typeof createMockAgentRoom>;

  beforeEach(() => {
    room = createMockAgentRoom();
  });

  it("a tool server NACKs requests for tools it does not host", async () => {
    const server = new Tools(room, "server-1");
    server.register("known", () => 1);

    room.simulate("toolRequest", {
      type: "tool_request",
      requestId: "r9",
      correlationId: "c9",
      replyTo: "requester-9",
      toolName: "missing",
      arguments: {},
      requestedBy: "requester-9",
      requestedAt: Date.now(),
    } as ToolRequestEnvelope);
    await new Promise((r) => setTimeout(r, 10));

    const published = room.getPublished();
    expect(published).toHaveLength(1);
    const nack = published[0].data as ToolResponseEnvelope;
    expect(nack.status).toBe("error");
    expect(nack.error?.code).toBe("NO_HANDLER");
    expect(nack.error?.message).toContain("missing");
    expect(nack.replyTo).toBe("requester-9");
  });

  it("a pure requester (no handlers) stays silent on foreign requests", async () => {
    new Tools(room, "requester-only");
    room.simulate("toolRequest", {
      type: "tool_request",
      requestId: "r9",
      correlationId: "c9",
      toolName: "anything",
      arguments: {},
      requestedBy: "other",
      requestedAt: Date.now(),
    } as ToolRequestEnvelope);
    await new Promise((r) => setTimeout(r, 10));
    expect(room.getPublished()).toHaveLength(0);
  });

  it("invoke fails fast when ALL visible tool servers are pre-protocol-2", async () => {
    const oldServers = createMockAgentRoom([{ capabilities: [], protocol: 1 }]);
    oldServers.getConnectedAgents().forEach((a: any) => (a.role = "tool-server"));
    const tools = new Tools(oldServers, "requester");
    await expect(tools.invoke("calc", {}, { timeout: 50 })).rejects.toThrowError(
      /agents-protocol < 2/,
    );
  });

  it("invoke proceeds with allowLegacyResponders against old servers", async () => {
    const oldServers = createMockAgentRoom([{ capabilities: [], protocol: 1 }]);
    oldServers.getConnectedAgents().forEach((a: any) => (a.role = "tool-server"));
    const tools = new Tools(oldServers, "requester");
    await expect(
      tools.invoke("calc", {}, { timeout: 30, allowLegacyResponders: true }),
    ).rejects.toThrowError(/timed out/);
  });

  it("timeout errors name the tool, room, and likely causes", async () => {
    const tools = new Tools(room, "requester");
    try {
      await tools.invoke("calc", {}, { timeout: 30 });
      expect.unreachable();
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain("Tool 'calc' invocation");
      expect(msg).toContain("test-room");
      expect(msg).toContain("Likely causes");
    }
  });
});
