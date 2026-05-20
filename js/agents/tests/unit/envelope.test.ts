import { describe, it, expect } from "vitest";
import {
  createTaskEnvelope,
  createResultEnvelope,
  createStateEnvelope,
  createEventEnvelope,
  createApprovalRequest,
  createApprovalResponse,
  createToolRequest,
  createToolResponse,
} from "../../src/envelope";

describe("envelope helpers", () => {
  it("creates a task envelope with defaults", () => {
    const task = createTaskEnvelope("draft-contract", { client: "acme" });
    expect(task.type).toBe("task");
    expect(task.taskId).toBeDefined();
    expect(task.correlationId).toBeDefined();
    expect(task.capability).toBe("draft-contract");
    expect(task.payload).toEqual({ client: "acme" });
    expect(task.priority).toBe("medium");
    expect(typeof task.createdAt).toBe("number");
  });

  it("creates a task envelope with options", () => {
    const task = createTaskEnvelope("review", { doc: "123" }, {
      tags: ["priority:high"],
      priority: "high",
      timeout: 5000,
      metadata: { source: "test" },
      createdBy: "agent-1",
    });
    expect(task.tags).toEqual(["priority:high"]);
    expect(task.priority).toBe("high");
    expect(task.timeout).toBe(5000);
    expect(task.metadata).toEqual({ source: "test" });
    expect(task.createdBy).toBe("agent-1");
  });

  it("creates a result envelope", () => {
    const result = createResultEnvelope("task-1", "corr-1", "success", { ok: true });
    expect(result.type).toBe("result");
    expect(result.taskId).toBe("task-1");
    expect(result.correlationId).toBe("corr-1");
    expect(result.status).toBe("success");
    expect(typeof result.completedAt).toBe("number");
  });

  it("creates a result envelope with error", () => {
    const result = createResultEnvelope("task-1", "corr-1", "error", {}, { code: "FAIL", message: "bad" });
    expect(result.error).toEqual({ code: "FAIL", message: "bad" });
  });

  it("creates a state envelope", () => {
    const state = createStateEnvelope("workflow-status", "active", 1, "agent-1");
    expect(state.type).toBe("state");
    expect(state.key).toBe("workflow-status");
    expect(state.value).toBe("active");
    expect(state.version).toBe(1);
    expect(state.updatedBy).toBe("agent-1");
    expect(typeof state.updatedAt).toBe("number");
  });

  it("creates an event envelope", () => {
    const event = createEventEnvelope("task-started", "agent-1", { taskId: "t1" }, "info");
    expect(event.type).toBe("event");
    expect(event.category).toBe("task-started");
    expect(event.emittedBy).toBe("agent-1");
    expect(event.severity).toBe("info");
    expect(typeof event.timestamp).toBe("number");
  });

  it("creates an approval request", () => {
    const approval = createApprovalRequest(
      "deploy",
      { version: "1.2.0", description: "Deploy to production" },
      "agent-1",
      { urgency: "high" },
    );
    expect(approval.type).toBe("approval_request");
    expect(approval.action).toBe("deploy");
    expect(approval.requestedBy).toBe("agent-1");
    expect(approval.urgency).toBe("high");
    expect(typeof approval.requestedAt).toBe("number");
  });

  it("creates an approval response", () => {
    const response = createApprovalResponse("req-1", "corr-1", "approved", "human-1", "looks good");
    expect(response.type).toBe("approval_response");
    expect(response.requestId).toBe("req-1");
    expect(response.decision).toBe("approved");
    expect(response.respondedBy).toBe("human-1");
    expect(response.reason).toBe("looks good");
    expect(typeof response.respondedAt).toBe("number");
  });

  it("creates a tool request", () => {
    const tool = createToolRequest("search", { query: "test" }, "agent-1");
    expect(tool.type).toBe("tool_request");
    expect(tool.toolName).toBe("search");
    expect(tool.arguments).toEqual({ query: "test" });
    expect(tool.requestedBy).toBe("agent-1");
    expect(typeof tool.requestedAt).toBe("number");
  });

  it("creates a tool response", () => {
    const response = createToolResponse("req-1", "corr-1", "success", { data: "result" });
    expect(response.type).toBe("tool_response");
    expect(response.status).toBe("success");
    expect(response.result).toEqual({ data: "result" });
    expect(typeof response.respondedAt).toBe("number");
  });

  it("creates a tool response with error", () => {
    const response = createToolResponse("req-1", "corr-1", "error", null, { code: "NOT_FOUND", message: "nope" });
    expect(response.status).toBe("error");
    expect(response.error).toEqual({ code: "NOT_FOUND", message: "nope" });
  });

  it("createTaskEnvelope with replyTo option", () => {
    const task = createTaskEnvelope("summarize", { text: "hello" }, { replyTo: "inbox-1" });
    expect(task.replyTo).toBe("inbox-1");
  });

  it("createTaskEnvelope with metadata option", () => {
    const task = createTaskEnvelope("summarize", { text: "hello" }, { metadata: { source: "test", priority: 1 } });
    expect(task.metadata).toEqual({ source: "test", priority: 1 });
  });

  it("createTaskEnvelope with createdBy option", () => {
    const task = createTaskEnvelope("summarize", { text: "hello" }, { createdBy: "orchestrator-1" });
    expect(task.createdBy).toBe("orchestrator-1");
  });

  it("createApprovalRequest with expiresAt option", () => {
    const expiresAt = Date.now() + 60000;
    const approval = createApprovalRequest("deploy", { version: "2.0.0" }, "agent-1", { expiresAt });
    expect(approval.expiresAt).toBe(expiresAt);
  });

  it("createToolRequest with replyTo option", () => {
    const tool = createToolRequest("search", { query: "test" }, "agent-1", { replyTo: "inbox-2" });
    expect(tool.replyTo).toBe("inbox-2");
  });

  it("createToolResponse with respondedBy option", () => {
    const response = createToolResponse("req-1", "corr-1", "success", { data: "ok" }, undefined, "provider-1");
    expect(response.respondedBy).toBe("provider-1");
  });

  it("all task timestamps are numbers", () => {
    const task = createTaskEnvelope("ping", {});
    expect(typeof task.createdAt).toBe("number");
  });

  it("all result timestamps are numbers", () => {
    const result = createResultEnvelope("task-1", "corr-1", "success", {});
    expect(typeof result.completedAt).toBe("number");
  });

  it("all state timestamps are numbers", () => {
    const state = createStateEnvelope("key-1", "value-1", 1, "agent-1");
    expect(typeof state.updatedAt).toBe("number");
  });

  it("all IDs are non-empty strings", () => {
    const task = createTaskEnvelope("ping", {});
    expect(typeof task.taskId).toBe("string");
    expect(task.taskId.length).toBeGreaterThan(0);
    expect(typeof task.correlationId).toBe("string");
    expect(task.correlationId.length).toBeGreaterThan(0);
  });
});
