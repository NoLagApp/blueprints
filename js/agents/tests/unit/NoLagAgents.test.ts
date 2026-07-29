import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NoLagAgents } from "../../src/NoLagAgents";
import { makeFakeClient, FakeNoLagClient } from "../helpers/fakeNoLagClient";

/**
 * Contract tests for the client-injection lifecycle (the canonical set —
 * every wrapper SDK carries equivalents):
 * 1. attach-to-connected microtask setup
 * 2. once-per-epoch setup (connect vs reconnect)
 * 3. the leak test: detaching one wrapper leaves a co-attached wrapper intact
 * 4. detach-while-disconnected / double-detach
 * 5. ready() semantics
 * 6. optional lobby: presence forwarded into rooms
 */

const flushMicrotasks = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

function makeAgents(client: FakeNoLagClient, opts: Record<string, unknown> = {}) {
  return new NoLagAgents({
    client: client as never,
    appName: "agents-app",
    agentId: "agent-self",
    ...opts,
  });
}

describe("NoLagAgents (client injection)", () => {
  let client: FakeNoLagClient;

  beforeEach(() => {
    client = makeFakeClient();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("throws without an injected client", () => {
    expect(() => new NoLagAgents({ appName: "x" } as never)).toThrow(TypeError);
  });

  it("sets up after the client connects and resolves ready()", async () => {
    const agents = makeAgents(client, { rooms: [] });
    const connected = vi.fn();
    agents.on("connected", connected);

    client.fireConnect("actor-1");
    await flushMicrotasks();

    await agents.ready();
    expect(connected).toHaveBeenCalledTimes(1);
    expect(agents.connected).toBe(true);
    agents.detach();
  });

  it("attach-to-connected: runs setup via microtask when the client is already live", async () => {
    client.fireConnect("actor-early");
    const agents = makeAgents(client, { rooms: [] });
    const connected = vi.fn();
    agents.on("connected", connected); // wired synchronously, before the microtask

    await flushMicrotasks();
    await agents.ready();

    expect(connected).toHaveBeenCalledTimes(1);
    agents.detach();
  });

  it("runs setup once per epoch: reconnects emit reconnected, not connected", async () => {
    const agents = makeAgents(client, { rooms: [] });
    const connected = vi.fn();
    const reconnected = vi.fn();
    agents.on("connected", connected);
    agents.on("reconnected", reconnected);

    client.fireConnect();
    await flushMicrotasks();
    client.fireConnect(); // reconnect: core fires 'connect' again
    await flushMicrotasks();

    expect(connected).toHaveBeenCalledTimes(1);
    expect(reconnected).toHaveBeenCalledTimes(1);
    agents.detach();
  });

  it("auto-joins configured rooms on first setup only", async () => {
    const agents = makeAgents(client, { rooms: ["room-a", "room-b"] });
    client.fireConnect();
    await flushMicrotasks();
    await agents.ready();

    expect(agents.rooms.size).toBe(2);
    expect(agents.rooms.has("room-a")).toBe(true);
    expect(client.isSubscribed("agents-app/room-a/tasks")).toBe(true);
    agents.detach();
  });

  it("LEAK TEST: detaching one wrapper leaves a co-attached wrapper fully intact", async () => {
    const agentsA = makeAgents(client, { appName: "app-a", rooms: ["general"] });
    const agentsB = makeAgents(client, { appName: "app-b", rooms: ["general"] });

    client.fireConnect();
    await flushMicrotasks();
    await agentsA.ready();
    await agentsB.ready();

    const bTopicHandlers = client.handlerCount("app-b/general/tasks");
    const bConnectHandlersBefore = client.handlerCount("connect");
    expect(bTopicHandlers).toBeGreaterThan(0);

    agentsA.detach();

    // B's topic handlers and lifecycle handlers are untouched
    expect(client.handlerCount("app-b/general/tasks")).toBe(bTopicHandlers);
    expect(client.handlerCount("connect")).toBe(bConnectHandlersBefore - 1);
    // A's topic handlers and subscriptions are gone
    expect(client.handlerCount("app-a/general/tasks")).toBe(0);
    expect(client.isSubscribed("app-a/general/tasks")).toBe(false);
    expect(client.isSubscribed("app-b/general/tasks")).toBe(true);

    // B still receives tasks on its room topic
    const room = agentsB.rooms.get("general")!;
    const onTask = vi.fn();
    room.on("task", onTask);
    client.fireMessage(
      "app-b/general/tasks",
      { type: "task", taskId: "t1", capability: "x" },
      {},
    );
    expect(onTask).toHaveBeenCalledTimes(1);
    agentsB.detach();
  });

  it("detach while disconnected skips server unsubscribes and removes handlers", async () => {
    const agents = makeAgents(client, { rooms: ["general"] });
    client.fireConnect();
    await flushMicrotasks();

    client.fireDisconnect();
    client.sent = [];
    agents.detach();

    expect(client.sent.filter((s) => s.op === "unsubscribe")).toEqual([]);
    expect(client.sent.filter((s) => s.op === "lobbyUnsubscribe")).toEqual([]);
    expect(client.handledEvents()).toEqual([]);
  });

  it("double detach is a no-op and public methods throw after detach", async () => {
    const agents = makeAgents(client, { rooms: [] });
    client.fireConnect();
    await flushMicrotasks();

    agents.detach();
    expect(() => agents.detach()).not.toThrow();
    expect(() => agents.room("x")).toThrow(/detached/);
  });

  it("ready() rejects when detached before ready and room() guards pre-ready", async () => {
    const agents = makeAgents(client, { rooms: [] });
    expect(() => agents.room("x")).toThrow(/not ready/);

    const readyPromise = agents.ready();
    agents.detach();
    await expect(readyPromise).rejects.toThrow(/detached before ready/);
  });

  it("skips the lobby entirely when not configured", async () => {
    const agents = makeAgents(client, { rooms: [] });
    client.fireConnect();
    await flushMicrotasks();
    await agents.ready();

    expect(client.sent.some((s) => s.op === "lobbySubscribe")).toBe(false);
    agents.detach();
  });

  it("subscribes the lobby and forwards lobby presence into rooms when configured", async () => {
    const agents = makeAgents(client, { rooms: ["general"], lobby: "activity" });
    client.fireConnect();
    await flushMicrotasks();
    await agents.ready();

    expect(client.sent.some((s) => s.op === "lobbySubscribe")).toBe(true);

    const room = agents.rooms.get("general")!;
    const join = vi.fn();
    room.on("presenceJoin", join);
    client.fireLobby("join", {
      actorId: "peer-1",
      data: { name: "Peer", role: "agent", capabilities: ["summarize"] },
    });

    expect(join).toHaveBeenCalledTimes(1);
    // The room's registry now knows about the discovered agent
    expect(room.findAgents("summarize").map((a) => a.actorId)).toEqual(["peer-1"]);
    agents.detach();
  });

  it("filters presence tagged with another app scope, accepts own and untagged", async () => {
    const agents = makeAgents(client, { rooms: ["general"], lobby: "activity" });
    client.fireConnect();
    await flushMicrotasks();
    await agents.ready();

    const room = agents.rooms.get("general")!;
    const join = vi.fn();
    room.on("presenceJoin", join);

    client.fireLobby("join", { actorId: "own", data: { name: "Own", capabilities: ["a"], __scope: "agents-app" } });
    client.fireLobby("join", { actorId: "foreign", data: { name: "Foreign", capabilities: ["a"], __scope: "other-app" } });
    client.fireLobby("join", { actorId: "legacy", data: { name: "Legacy", capabilities: ["a"] } });

    // Foreign-scoped presence is dropped; own + untagged accepted.
    expect(join).toHaveBeenCalledTimes(2);
    expect(room.getConnectedAgents().map((a) => a.actorId).sort()).toEqual(["legacy", "own"]);
    agents.detach();
  });

  it("runs the deferred lobby refresh and cancels it on detach", async () => {
    vi.useFakeTimers();
    const agents = makeAgents(client, { rooms: [], lobby: "activity" });
    client.fireConnect();
    await flushMicrotasks();

    client.sent = [];
    await vi.advanceTimersByTimeAsync(2000);
    expect(client.sent.some((s) => s.op === "lobbyFetchPresence")).toBe(true);

    // A new wrapper's pending refresh dies with detach
    const agents2 = makeAgents(client, { appName: "agents-app-2", rooms: [], lobby: "activity" });
    client.fireConnect();
    await flushMicrotasks();
    client.sent = [];
    agents2.detach();
    await vi.advanceTimersByTimeAsync(5000);
    expect(
      client.sent.filter((s) => s.op === "lobbyFetchPresence" && s.topic?.startsWith("agents-app-2")),
    ).toEqual([]);

    agents.detach();
  });

  it("stale setup aborts: a reconnect mid-setup wins", async () => {
    // Make the first lobby subscribe hang until after a second connect
    let resolveFirst: (v: Record<string, Record<string, unknown>>) => void;
    const origSetApp = client.setApp.bind(client);
    let call = 0;
    (client as { setApp: typeof client.setApp }).setApp = (appName: string) => {
      const ctx = origSetApp(appName);
      const origSetLobby = ctx.setLobby.bind(ctx);
      ctx.setLobby = (lobbyId: string) => {
        const lobby = origSetLobby(lobbyId);
        const origSubscribe = lobby.subscribe.bind(lobby);
        lobby.subscribe = () => {
          call++;
          if (call === 1) {
            return new Promise((resolve) => {
              resolveFirst = resolve;
            });
          }
          return origSubscribe();
        };
        return lobby;
      };
      return ctx;
    };

    const agents = makeAgents(client, { rooms: [], lobby: "activity" });
    const connected = vi.fn();
    agents.on("connected", connected);

    client.fireConnect(); // epoch 1: hangs in lobby subscribe
    await flushMicrotasks();
    client.fireConnect(); // epoch 2: completes normally
    await flushMicrotasks();
    resolveFirst!({}); // epoch 1 resumes, must abort silently
    await flushMicrotasks();

    // Ready resolved exactly once, via epoch 2
    await agents.ready();
    expect(connected).toHaveBeenCalledTimes(1);
    agents.detach();
  });
});

describe("NoLagAgents (domain behavior)", () => {
  let client: FakeNoLagClient;

  beforeEach(() => {
    client = makeFakeClient();
  });

  async function connected(opts: Record<string, unknown> = {}) {
    const agents = makeAgents(client, opts);
    client.fireConnect();
    await flushMicrotasks();
    await agents.ready();
    return agents;
  }

  it("uses default app name and default room", async () => {
    const agents = new NoLagAgents({ client: client as never });
    client.fireConnect();
    await flushMicrotasks();
    await agents.ready();

    expect(agents.rooms.has("default-workflow")).toBe(true);
    expect(client.isSubscribed("agents/default-workflow/tasks")).toBe(true);
    agents.detach();
  });

  it("room() returns the same instance for the same name", async () => {
    const agents = await connected({ rooms: [] });
    const first = agents.room("test-room");
    const second = agents.room("test-room");
    expect(first).toBe(second);
    agents.detach();
  });

  it("multiple rooms can be created", async () => {
    const agents = await connected({ rooms: [] });
    agents.room("a");
    agents.room("b");
    expect(agents.rooms.size).toBe(2);
    agents.detach();
  });

  it("advertises presence with a __scope tag when identity is provided", async () => {
    const agents = await connected({
      rooms: ["general"],
      presence: { name: "worker", role: "agent", capabilities: ["x"] },
    });
    const presenceCalls = client.sent.filter(
      (s) => s.op === "setPresence" && s.topic === "agents-app/general",
    );
    expect(presenceCalls.length).toBeGreaterThan(0);
    expect((presenceCalls[0].data as Record<string, unknown>).__scope).toBe("agents-app");
    agents.detach();
  });

  it("derives presence from name/role options when no presence object is given", async () => {
    const agents = await connected({ rooms: ["general"], name: "Worker", role: "orchestrator" });
    const presenceCall = client.sent.find(
      (s) => s.op === "setPresence" && s.topic === "agents-app/general",
    );
    expect(presenceCall).toBeDefined();
    const data = presenceCall!.data as Record<string, unknown>;
    expect(data.name).toBe("Worker");
    expect(data.role).toBe("orchestrator");
    agents.detach();
  });

  it("re-applies room presence on reconnect", async () => {
    const agents = await connected({
      rooms: ["general"],
      presence: { name: "worker", role: "agent" },
    });
    const before = client.sent.filter(
      (s) => s.op === "setPresence" && s.topic === "agents-app/general",
    ).length;

    client.fireConnect(); // reconnect
    await flushMicrotasks();

    const after = client.sent.filter(
      (s) => s.op === "setPresence" && s.topic === "agents-app/general",
    ).length;
    expect(after).toBeGreaterThan(before);
    agents.detach();
  });

  it("exposes the agentId", async () => {
    const agents = await connected({ rooms: [], agentId: "worker-42" });
    expect(agents.agentId).toBe("worker-42");
    agents.detach();
  });
});
