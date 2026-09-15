import { describe, it, expect, beforeEach } from "vitest";
import { NoLagAgents } from "../../src/NoLagAgents";
import { makeFakeClient, FakeNoLagClient } from "../helpers/fakeNoLagClient";

/**
 * Filter API contract for @nolag/agents.
 *
 * The headline use is capability routing: today a worker receives every task
 * and discards what it cannot handle, which under load balancing means a task
 * can be handed to a worker that drops it. Filters move that matching to the
 * broker.
 *
 * `results` is deliberately NOT filterable — it carries directed replies keyed
 * to the recipient's agentId, and repointing it would strand every pending
 * task result and tool response.
 */

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

const PREFIX = "agents-app/workflow";
const FILTERABLE = ["tasks", "tools", "state", "events", "inbox", "approval"];

async function connected() {
  const client = makeFakeClient();
  const agents = new NoLagAgents({
    client: client as never,
    appName: "agents-app",
    agentId: "agent-1",
  } as never);
  client.fireConnect("actor-1");
  await flush();
  return { client, agents };
}

describe("@nolag/agents filters", () => {
  let client: FakeNoLagClient;
  let agents: NoLagAgents;

  beforeEach(async () => {
    ({ client, agents } = await connected());
  });

  it("subscribes filterable topics unfiltered by default", async () => {
    await agents.room("workflow");

    for (const topic of ["tasks", "tools"]) {
      const sub = client.sent.find(
        (s) => s.op === "subscribe" && s.topic === `${PREFIX}/${topic}`,
      );
      expect((sub!.options as { filters?: unknown } | undefined)?.filters, topic).toBeUndefined();
    }
  });

  it("keeps results keyed to this agent id by default", async () => {
    await agents.room("workflow");

    expect(client.topicFilters.get(`${PREFIX}/results`)).toEqual(["agent-1"]);
  });

  it("applies join-time filters to every filterable topic", async () => {
    await agents.room("workflow", { filters: ["ocr"] });

    for (const topic of FILTERABLE) {
      expect(client.topicFilters.get(`${PREFIX}/${topic}`), topic).toEqual(["ocr"]);
    }
  });

  it("never applies join-time filters to results", async () => {
    await agents.room("workflow", { filters: ["ocr"] });

    expect(client.topicFilters.get(`${PREFIX}/results`)).toEqual(["agent-1"]);
  });

  it("reports filters per topic", async () => {
    const room = await agents.room("workflow", { filters: ["ocr"] });

    expect(room.filters).toEqual({
      tasks: ["ocr"],
      tools: ["ocr"],
      state: ["ocr"],
      events: ["ocr"],
      inbox: ["ocr"],
      approval: ["ocr"],
    });
  });

  it("setFilters covers every filterable topic and never results", async () => {
    const room = await agents.room("workflow");
    client.sent.length = 0;

    room.setFilters(["ocr"]);

    const topics = client.sent
      .filter((s) => s.op === "setFilters")
      .map((s) => s.topic)
      .sort();
    expect(topics).toEqual(FILTERABLE.map((t) => `${PREFIX}/${t}`).sort());
    expect(topics).not.toContain(`${PREFIX}/results`);
  });

  it("scopes a call to one topic with { topic }", async () => {
    const room = await agents.room("workflow");
    client.sent.length = 0;

    room.setFilters(["ocr", "translate"], { topic: "tasks" });

    const calls = client.sent.filter((s) => s.op === "setFilters");
    expect(calls).toHaveLength(1);
    expect(calls[0].topic).toBe(`${PREFIX}/tasks`);
    expect(room.filters.tasks).toEqual(["ocr", "translate"]);
    expect(room.filters.events).toEqual([]);
  });

  it("setFilters([]) reverts to the wildcard subscription", async () => {
    const room = await agents.room("workflow", { filters: ["ocr"] });

    room.setFilters([]);

    expect(room.filters.tasks).toEqual([]);
    expect(client.topicFilters.has(`${PREFIX}/tasks`)).toBe(false);
  });

  it("clearing filters still leaves results directed", async () => {
    const room = await agents.room("workflow", { filters: ["ocr"] });

    room.setFilters([]);

    expect(client.topicFilters.get(`${PREFIX}/results`)).toEqual(["agent-1"]);
  });

  it("addFilters and removeFilters adjust the set", async () => {
    const room = await agents.room("workflow", { filters: ["ocr"] });

    room.addFilters(["translate"], { topic: "tasks" });
    expect(room.filters.tasks).toEqual(["ocr", "translate"]);

    room.removeFilters(["ocr"], { topic: "tasks" });
    expect(room.filters.tasks).toEqual(["translate"]);
  });

  it("preserves AND groups across OR-term edits", async () => {
    const room = await agents.room("workflow", { filters: [["ocr", "gpu"]] });

    room.addFilters(["translate"], { topic: "tasks" });

    expect(room.filters.tasks).toEqual(["translate", ["ocr", "gpu"]]);
  });

  it("publishTask routes by capability when asked", async () => {
    const room = await agents.room("workflow");
    client.sent.length = 0;

    room.publishTask({ taskId: "t1", capability: "ocr" } as never, { filter: "ocr" });

    const emit = client.sent.find((s) => s.op === "emit");
    expect(emit!.topic).toBe(`${PREFIX}/tasks`);
    expect(emit!.options).toMatchObject({ filter: "ocr" });
  });

  it("publishTask stays a broadcast when no filter is given", async () => {
    const room = await agents.room("workflow");
    client.sent.length = 0;

    room.publishTask({ taskId: "t1", capability: "ocr" } as never);

    // Unchanged from before filters existed: no options object at all.
    const emit = client.sent.find((s) => s.op === "emit");
    expect(emit!.options).toBeUndefined();
  });

  it("publishEvent, publishInbox and publishApproval accept a filter", async () => {
    const room = await agents.room("workflow");

    const cases: Array<[() => void, string]> = [
      [() => room.publishEvent({ kind: "x" }, { filter: "ops" }), `${PREFIX}/events`],
      [() => room.publishInbox({ kind: "x" }, { filter: "ops" }), `${PREFIX}/inbox`],
      [() => room.publishApproval({ kind: "x" }, { filter: "ops" }), `${PREFIX}/approval`],
    ];

    for (const [send, topic] of cases) {
      client.sent.length = 0;
      send();
      const emit = client.sent.find((s) => s.op === "emit" && s.topic === topic);
      expect(emit, topic).toBeDefined();
      expect(emit!.options, topic).toMatchObject({ filter: "ops" });
    }
  });

  it("a directed result still goes to the requester, not a caller filter", async () => {
    const room = await agents.room("workflow");
    client.sent.length = 0;

    room.publishResult({ taskId: "t1", replyTo: "agent-9", status: "ok" } as never);

    const emit = client.sent.find((s) => s.op === "emit");
    expect(emit!.topic).toBe(`${PREFIX}/results`);
    expect(emit!.options).toMatchObject({ filter: "agent-9" });
  });

  it("a tool response ignores a caller filter and stays directed", async () => {
    const room = await agents.room("workflow");
    client.sent.length = 0;

    room.publishTools(
      { type: "tool_response", replyTo: "agent-9" },
      { filter: "should-be-ignored" },
    );

    const emit = client.sent.find((s) => s.op === "emit");
    expect(emit!.topic).toBe(`${PREFIX}/results`);
    expect(emit!.options).toMatchObject({ filter: "agent-9" });
  });

  it("a tool request honours a caller filter", async () => {
    const room = await agents.room("workflow");
    client.sent.length = 0;

    room.publishTools({ type: "tool_request", name: "search" }, { filter: "search-pool" });

    const emit = client.sent.find((s) => s.op === "emit");
    expect(emit!.topic).toBe(`${PREFIX}/tools`);
    expect(emit!.options).toMatchObject({ filter: "search-pool" });
  });

  it("re-points filters when re-requesting an open room", async () => {
    await agents.room("workflow", { filters: ["ocr"] });

    const room = await agents.room("workflow", { filters: ["translate"] });

    expect(room.filters.tasks).toEqual(["translate"]);
  });
});
