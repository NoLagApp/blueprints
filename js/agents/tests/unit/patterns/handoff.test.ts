import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockAgentRoom } from "../helpers/mockAgentRoom";
import { Handoff } from "../../../src/patterns/handoff";
import type { ResultEnvelope, TaskEnvelope } from "../../../src/types";

describe("Handoff pattern", () => {
  let room: ReturnType<typeof createMockAgentRoom>;
  let handoff: Handoff;

  beforeEach(() => {
    room = createMockAgentRoom();
    handoff = new Handoff(room);
  });

  // --- dispatch ---

  it("publishes a task envelope on dispatch", async () => {
    await handoff.dispatch("draft-contract", { client: "acme" });
    const published = room.getPublished();
    expect(published).toHaveLength(1);
    expect(published[0].method).toBe("publishTask");
    const task = published[0].data as TaskEnvelope;
    expect(task.type).toBe("task");
    expect(task.capability).toBe("draft-contract");
    expect(task.payload).toEqual({ client: "acme" });
  });

  it("sets default priority to medium", async () => {
    await handoff.dispatch("review", {});
    const task = room.getPublished()[0].data as TaskEnvelope;
    expect(task.priority).toBe("medium");
  });

  it("passes tags to the task envelope", async () => {
    await handoff.dispatch("review", {}, { tags: ["capability:legal"] });
    const task = room.getPublished()[0].data as TaskEnvelope;
    expect(task.tags).toEqual(["capability:legal"]);
  });

  it("passes priority to the task envelope", async () => {
    await handoff.dispatch("review", {}, { priority: "critical" });
    const task = room.getPublished()[0].data as TaskEnvelope;
    expect(task.priority).toBe("critical");
  });

  it("returns void when waitForResult is not set", async () => {
    const result = await handoff.dispatch("task", {});
    expect(result).toBeUndefined();
  });

  it("returns a promise when waitForResult is true", () => {
    const promise = handoff.dispatch("task", {}, { waitForResult: true, timeout: 5000 });
    expect(promise).toBeInstanceOf(Promise);

    // Simulate a result to resolve the promise
    const task = room.getPublished()[0].data as TaskEnvelope;
    const resultEnvelope: ResultEnvelope = {
      type: "result",
      taskId: task.taskId,
      correlationId: task.correlationId,
      status: "success",
      payload: { answer: 42 },
      completedAt: Date.now(),
    };
    room.simulate("result", resultEnvelope);

    return expect(promise).resolves.toEqual(resultEnvelope);
  });

  it("times out if no result is received", async () => {
    const promise = handoff.dispatch("task", {}, { waitForResult: true, timeout: 50 });
    await expect(promise).rejects.toThrow("timed out");
  });

  // --- onTask ---

  it("receives tasks and provides a respond function", () => {
    const handler = vi.fn();
    handoff.onTask(handler);

    const task: TaskEnvelope = {
      type: "task",
      taskId: "t1",
      correlationId: "c1",
      capability: "review",
      priority: "medium",
      payload: { doc: "123" },
      createdAt: Date.now(),
    };
    room.simulate("task", task);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0]).toEqual(task);
    expect(typeof handler.mock.calls[0][1]).toBe("function");
  });

  it("respond function publishes a result envelope", () => {
    handoff.onTask((task, respond) => {
      respond("success", { done: true });
    });

    const task: TaskEnvelope = {
      type: "task",
      taskId: "t1",
      correlationId: "c1",
      capability: "review",
      priority: "medium",
      payload: {},
      createdAt: Date.now(),
    };
    room.simulate("task", task);

    const published = room.getPublished();
    expect(published).toHaveLength(1);
    expect(published[0].method).toBe("publishResult");
    const result = published[0].data as ResultEnvelope;
    expect(result.type).toBe("result");
    expect(result.taskId).toBe("t1");
    expect(result.correlationId).toBe("c1");
    expect(result.status).toBe("success");
    expect(result.payload).toEqual({ done: true });
  });

  it("respond function passes error correctly", () => {
    handoff.onTask((task, respond) => {
      respond("error", {}, { code: "FAIL", message: "something broke" });
    });

    room.simulate("task", {
      type: "task",
      taskId: "t1",
      correlationId: "c1",
      capability: "review",
      priority: "medium",
      payload: {},
      createdAt: Date.now(),
    } as TaskEnvelope);

    const result = room.getPublished()[0].data as ResultEnvelope;
    expect(result.status).toBe("error");
    expect(result.error).toEqual({ code: "FAIL", message: "something broke" });
  });

  // --- correlation ---

  it("correlates results back to dispatch", async () => {
    const promise = handoff.dispatch("task", {}, { waitForResult: true });
    const task = room.getPublished()[0].data as TaskEnvelope;

    const result: ResultEnvelope = {
      type: "result",
      taskId: task.taskId,
      correlationId: task.correlationId,
      status: "success",
      payload: { value: "done" },
      completedAt: Date.now(),
    };
    room.simulate("result", result);

    const resolved = await promise;
    expect(resolved).toEqual(result);
  });

  it("ignores results with non-matching correlationId", async () => {
    const promise = handoff.dispatch("task", {}, { waitForResult: true, timeout: 100 });

    room.simulate("result", {
      type: "result",
      taskId: "other",
      correlationId: "wrong-id",
      status: "success",
      payload: {},
      completedAt: Date.now(),
    } as ResultEnvelope);

    await expect(promise).rejects.toThrow("timed out");
  });

  // --- dispose ---

  it("cancels pending correlations on dispose", async () => {
    const promise = handoff.dispatch("task", {}, { waitForResult: true });
    handoff.dispose();
    await expect(promise).rejects.toThrow("cancelled");
  });

  it("can dispatch after dispose without errors", async () => {
    handoff.dispose();
    await handoff.dispatch("task", {});
    expect(room.getPublished()).toHaveLength(1);
  });

  // --- edge cases ---

  it("multiple concurrent dispatches with waitForResult", async () => {
    const p1 = handoff.dispatch("task-a", { n: 1 }, { waitForResult: true });
    const p2 = handoff.dispatch("task-b", { n: 2 }, { waitForResult: true });
    const p3 = handoff.dispatch("task-c", { n: 3 }, { waitForResult: true });

    const published = room.getPublished();
    const tasks = published.map((p) => p.data as TaskEnvelope);

    const makeResult = (task: TaskEnvelope, value: number): ResultEnvelope => ({
      type: "result",
      taskId: task.taskId,
      correlationId: task.correlationId,
      status: "success",
      payload: { value },
      completedAt: Date.now(),
    });

    room.simulate("result", makeResult(tasks[0], 10));
    room.simulate("result", makeResult(tasks[1], 20));
    room.simulate("result", makeResult(tasks[2], 30));

    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
    expect(r1!.payload).toEqual({ value: 10 });
    expect(r2!.payload).toEqual({ value: 20 });
    expect(r3!.payload).toEqual({ value: 30 });
  });

  it("onTask handler receives tasks in order", () => {
    const received: string[] = [];
    handoff.onTask((task) => received.push(task.capability));

    const makeTask = (capability: string): TaskEnvelope => ({
      type: "task",
      taskId: capability,
      correlationId: `c-${capability}`,
      capability,
      priority: "medium",
      payload: {},
      createdAt: Date.now(),
    });

    room.simulate("task", makeTask("alpha"));
    room.simulate("task", makeTask("beta"));
    room.simulate("task", makeTask("gamma"));

    expect(received).toEqual(["alpha", "beta", "gamma"]);
  });

  it("dispatch with all options sets all envelope fields", async () => {
    const expiresAt = Date.now() + 60_000;
    await handoff.dispatch(
      "full-task",
      { data: 1 },
      {
        tags: ["tag-a", "tag-b"],
        priority: "critical",
        metadata: { source: "test" },
        createdBy: "orchestrator-1",
        timeout: 5000,
      }
    );
    const task = room.getPublished()[0].data as TaskEnvelope;
    expect(task.capability).toBe("full-task");
    expect(task.tags).toEqual(["tag-a", "tag-b"]);
    expect(task.priority).toBe("critical");
    expect(task.metadata).toEqual({ source: "test" });
    expect(task.createdBy).toBe("orchestrator-1");
  });

  it("dispatch fires even with no workers registered", async () => {
    // No onTask registered
    await handoff.dispatch("orphan-task", { key: "value" });
    const published = room.getPublished();
    expect(published).toHaveLength(1);
    expect((published[0].data as TaskEnvelope).capability).toBe("orphan-task");
  });

  it("multiple onTask handlers all receive the same task", () => {
    const handler1 = vi.fn();
    const handler2 = vi.fn();
    handoff.onTask(handler1);
    handoff.onTask(handler2);

    const task: TaskEnvelope = {
      type: "task",
      taskId: "t-shared",
      correlationId: "c-shared",
      capability: "shared-work",
      priority: "medium",
      payload: { x: 99 },
      createdAt: Date.now(),
    };
    room.simulate("task", task);

    expect(handler1).toHaveBeenCalledTimes(1);
    expect(handler1.mock.calls[0][0]).toEqual(task);
    expect(handler2).toHaveBeenCalledTimes(1);
    expect(handler2.mock.calls[0][0]).toEqual(task);
  });
});

describe("protocol gating on waitForResult (v0.3.0)", () => {
  it("fails fast when ALL capable workers are pre-protocol-2", async () => {
    const oldRoom = createMockAgentRoom([{ capabilities: ["review"], protocol: 1 }]);
    const h = new Handoff(oldRoom);
    await expect(
      h.dispatch("review", {}, { waitForResult: true, timeout: 50 }),
    ).rejects.toThrowError(/agents-protocol < 2/);
  });

  it("proceeds with allowLegacyResponders", async () => {
    const oldRoom = createMockAgentRoom([{ capabilities: ["review"], protocol: 1 }]);
    const h = new Handoff(oldRoom);
    await expect(
      h.dispatch("review", {}, { waitForResult: true, timeout: 30, allowLegacyResponders: true }),
    ).rejects.toThrowError(/timed out/);
  });

  it("timeout errors name the capability and worker count", async () => {
    const r = createMockAgentRoom([{ capabilities: ["review"] }]);
    const h = new Handoff(r);
    try {
      await h.dispatch("review", {}, { waitForResult: true, timeout: 30 });
      expect.unreachable();
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain("Task 'review' dispatch");
      expect(msg).toContain("1 capable worker");
    }
  });
});
