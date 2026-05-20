import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockAgentRoom } from "../helpers/mockAgentRoom";
import { Approve } from "../../../src/patterns/approve";
import type { ApprovalRequestEnvelope, ApprovalResponseEnvelope } from "../../../src/types";

describe("Approve pattern", () => {
  let room: ReturnType<typeof createMockAgentRoom>;
  let approve: Approve;

  beforeEach(() => {
    room = createMockAgentRoom();
    approve = new Approve(room, "agent-1");
  });

  // --- request ---

  it("publishes an approval request", async () => {
    const promise = approve.request("deploy", { version: "1.0" }, { timeout: 5000 });

    const published = room.getPublished();
    expect(published).toHaveLength(1);
    expect(published[0].method).toBe("publishApproval");
    const req = published[0].data as ApprovalRequestEnvelope;
    expect(req.type).toBe("approval_request");
    expect(req.action).toBe("deploy");
    expect(req.context).toEqual({ version: "1.0" });
    expect(req.requestedBy).toBe("agent-1");
    expect(req.urgency).toBe("medium");

    // Resolve the promise to avoid hanging
    room.simulate("approvalResponse", {
      type: "approval_response",
      requestId: req.requestId,
      correlationId: req.correlationId,
      decision: "approved",
      respondedBy: "human-1",
      respondedAt: Date.now(),
    } as ApprovalResponseEnvelope);

    await promise;
  });

  it("sets custom urgency", async () => {
    const promise = approve.request("deploy", {}, { urgency: "critical", timeout: 5000 });
    const req = room.getPublished()[0].data as ApprovalRequestEnvelope;
    expect(req.urgency).toBe("critical");

    room.simulate("approvalResponse", {
      type: "approval_response",
      requestId: req.requestId,
      correlationId: req.correlationId,
      decision: "approved",
      respondedBy: "human-1",
      respondedAt: Date.now(),
    } as ApprovalResponseEnvelope);

    await promise;
  });

  it("resolves with approval response", async () => {
    const promise = approve.request("deploy", {});
    const req = room.getPublished()[0].data as ApprovalRequestEnvelope;

    const response: ApprovalResponseEnvelope = {
      type: "approval_response",
      requestId: req.requestId,
      correlationId: req.correlationId,
      decision: "approved",
      respondedBy: "human-1",
      reason: "lgtm",
      respondedAt: Date.now(),
    };
    room.simulate("approvalResponse", response);

    const result = await promise;
    expect(result.decision).toBe("approved");
    expect(result.reason).toBe("lgtm");
  });

  it("resolves with rejected decision", async () => {
    const promise = approve.request("deploy", {});
    const req = room.getPublished()[0].data as ApprovalRequestEnvelope;

    room.simulate("approvalResponse", {
      type: "approval_response",
      requestId: req.requestId,
      correlationId: req.correlationId,
      decision: "rejected",
      respondedBy: "human-1",
      reason: "not ready",
      respondedAt: Date.now(),
    } as ApprovalResponseEnvelope);

    const result = await promise;
    expect(result.decision).toBe("rejected");
  });

  it("resolves with deferred decision", async () => {
    const promise = approve.request("deploy", {});
    const req = room.getPublished()[0].data as ApprovalRequestEnvelope;

    room.simulate("approvalResponse", {
      type: "approval_response",
      requestId: req.requestId,
      correlationId: req.correlationId,
      decision: "deferred",
      respondedBy: "human-1",
      respondedAt: Date.now(),
    } as ApprovalResponseEnvelope);

    const result = await promise;
    expect(result.decision).toBe("deferred");
  });

  it("times out if no response is received", async () => {
    const promise = approve.request("deploy", {}, { timeout: 50 });
    await expect(promise).rejects.toThrow("timed out");
  });

  it("ignores responses with non-matching correlationId", async () => {
    const promise = approve.request("deploy", {}, { timeout: 100 });

    room.simulate("approvalResponse", {
      type: "approval_response",
      requestId: "wrong",
      correlationId: "wrong-id",
      decision: "approved",
      respondedBy: "human-1",
      respondedAt: Date.now(),
    } as ApprovalResponseEnvelope);

    await expect(promise).rejects.toThrow("timed out");
  });

  // --- onRequest ---

  it("receives approval requests and provides respond function", () => {
    const handler = vi.fn();
    approve.onRequest(handler);

    const request: ApprovalRequestEnvelope = {
      type: "approval_request",
      requestId: "r1",
      correlationId: "c1",
      action: "deploy",
      context: { version: "1.0" },
      urgency: "high",
      requestedBy: "agent-2",
      requestedAt: Date.now(),
    };
    room.simulate("approvalRequest", request);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0]).toEqual(request);
    expect(typeof handler.mock.calls[0][1]).toBe("function");
  });

  it("respond function publishes an approval response", () => {
    approve.onRequest((req, respond) => {
      respond("approved", "looks good");
    });

    room.simulate("approvalRequest", {
      type: "approval_request",
      requestId: "r1",
      correlationId: "c1",
      action: "deploy",
      context: {},
      urgency: "medium",
      requestedBy: "agent-2",
      requestedAt: Date.now(),
    } as ApprovalRequestEnvelope);

    const published = room.getPublished();
    expect(published).toHaveLength(1);
    expect(published[0].method).toBe("publishApproval");
    const response = published[0].data as ApprovalResponseEnvelope;
    expect(response.type).toBe("approval_response");
    expect(response.requestId).toBe("r1");
    expect(response.correlationId).toBe("c1");
    expect(response.decision).toBe("approved");
    expect(response.reason).toBe("looks good");
    expect(response.respondedBy).toBe("agent-1");
  });

  // --- correlation round-trip ---

  it("full round-trip: request -> onRequest -> respond -> resolve", async () => {
    // Agent-2 approves incoming requests
    const approver = new Approve(room, "agent-2");
    approver.onRequest((req, respond) => {
      respond("approved", "auto-approved");
    });

    // Agent-1 requests approval
    const promise = approve.request("deploy", { env: "prod" });
    const req = room.getPublished()[0].data as ApprovalRequestEnvelope;

    // Simulate the request being received by the approver
    room.simulate("approvalRequest", req);

    // The approver's response should be in published now
    const responseData = room.getPublished()[1].data as ApprovalResponseEnvelope;

    // Simulate the response being received by the requester
    room.simulate("approvalResponse", responseData);

    const result = await promise;
    expect(result.decision).toBe("approved");
    expect(result.reason).toBe("auto-approved");
  });

  // --- dispose ---

  it("cancels pending correlations on dispose", async () => {
    const promise = approve.request("deploy", {});
    approve.dispose();
    await expect(promise).rejects.toThrow("cancelled");
  });

  // --- edge cases ---

  it("request with expiresAt option sets expiresAt on the envelope", async () => {
    const expiresAt = Date.now() + 3600_000;
    const promise = approve.request("deploy", {}, { expiresAt, timeout: 5000 });
    const req = room.getPublished()[0].data as ApprovalRequestEnvelope;
    expect(req.expiresAt).toBe(expiresAt);

    room.simulate("approvalResponse", {
      type: "approval_response",
      requestId: req.requestId,
      correlationId: req.correlationId,
      decision: "approved",
      respondedBy: "human-1",
      respondedAt: Date.now(),
    } as ApprovalResponseEnvelope);

    await promise;
  });

  it("multiple concurrent requests both resolve independently", async () => {
    const p1 = approve.request("deploy", { env: "staging" });
    const p2 = approve.request("delete", { resource: "db" });

    const published = room.getPublished();
    const req1 = published[0].data as ApprovalRequestEnvelope;
    const req2 = published[1].data as ApprovalRequestEnvelope;

    room.simulate("approvalResponse", {
      type: "approval_response",
      requestId: req1.requestId,
      correlationId: req1.correlationId,
      decision: "approved",
      respondedBy: "human-1",
      respondedAt: Date.now(),
    } as ApprovalResponseEnvelope);

    room.simulate("approvalResponse", {
      type: "approval_response",
      requestId: req2.requestId,
      correlationId: req2.correlationId,
      decision: "rejected",
      respondedBy: "human-1",
      respondedAt: Date.now(),
    } as ApprovalResponseEnvelope);

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.decision).toBe("approved");
    expect(r2.decision).toBe("rejected");
  });

  it("onRequest receives requests from a different agent instance", () => {
    const approver = new Approve(room, "agent-2");
    const handler = vi.fn();
    approver.onRequest(handler);

    const request: ApprovalRequestEnvelope = {
      type: "approval_request",
      requestId: "r1",
      correlationId: "c1",
      action: "scale",
      context: { replicas: 3 },
      urgency: "high",
      requestedBy: "agent-1",
      requestedAt: Date.now(),
    };
    room.simulate("approvalRequest", request);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0].requestedBy).toBe("agent-1");
  });

  it("respond with all 3 decision types produces correct decision values", () => {
    const decisions: ApprovalResponseEnvelope["decision"][] = [];

    approve.onRequest((req, respond) => {
      if (req.action === "deploy") respond("approved");
      else if (req.action === "delete") respond("rejected");
      else respond("deferred");
    });

    const makeRequest = (action: string, id: string): ApprovalRequestEnvelope => ({
      type: "approval_request",
      requestId: id,
      correlationId: `c-${id}`,
      action,
      context: {},
      urgency: "medium",
      requestedBy: "agent-2",
      requestedAt: Date.now(),
    });

    room.simulate("approvalRequest", makeRequest("deploy", "r1"));
    room.simulate("approvalRequest", makeRequest("delete", "r2"));
    room.simulate("approvalRequest", makeRequest("pause", "r3"));

    const published = room.getPublished();
    expect(published).toHaveLength(3);
    expect((published[0].data as ApprovalResponseEnvelope).decision).toBe("approved");
    expect((published[1].data as ApprovalResponseEnvelope).decision).toBe("rejected");
    expect((published[2].data as ApprovalResponseEnvelope).decision).toBe("deferred");
  });

  it("new request after dispose still works (only pending correlations are cleared)", async () => {
    const pendingPromise = approve.request("deploy", {});
    approve.dispose();
    await expect(pendingPromise).rejects.toThrow("cancelled");

    // A new request after dispose should still publish and resolve
    const newPromise = approve.request("rollback", {});
    const req = room.getPublished()[1].data as ApprovalRequestEnvelope;
    expect(req.action).toBe("rollback");

    room.simulate("approvalResponse", {
      type: "approval_response",
      requestId: req.requestId,
      correlationId: req.correlationId,
      decision: "approved",
      respondedBy: "human-1",
      respondedAt: Date.now(),
    } as ApprovalResponseEnvelope);

    const result = await newPromise;
    expect(result.decision).toBe("approved");
  });
});
