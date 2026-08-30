import { describe, it, expect } from "vitest";
import type { NoLagAgents, ResultEnvelope, TaskEnvelope } from "@nolag/agents";
import { OrchestratorBridge, orchestratorPoolOptions } from "../src/orchestrator.js";
import { orchestratedModel, type VoiceFloor } from "../src/orchestrated-model.js";

/**
 * A stand-in for the orchestrator side of an AgentRoom. The bridge only ever
 * publishes tasks, listens for results and reads presence, so faking those is
 * enough to exercise the whole exchange without a broker.
 */
function fakeRoom(capabilities: string[] = ["orchestrate"]) {
  const tasks: TaskEnvelope[] = [];
  const handlers: Record<string, Array<(envelope: unknown) => void>> = {};
  return {
    tasks,
    agentId: "voice-host-1",
    publishTask: (task: TaskEnvelope) => tasks.push(task),
    on: (type: string, handler: (envelope: unknown) => void) => {
      (handlers[type] ??= []).push(handler);
    },
    off: (type: string, handler: (envelope: unknown) => void) => {
      handlers[type] = (handlers[type] ?? []).filter((entry) => entry !== handler);
    },
    getAvailableCapabilities: () => capabilities,
    fetchPresence: async (): Promise<Array<{ capabilities: string[]; actorId?: string }>> => [
      { capabilities },
    ],
    /** Answer the nth outstanding task, the way a worker would. */
    answer(
      task: TaskEnvelope,
      payload: Record<string, unknown>,
      status: ResultEnvelope["status"] = "success"
    ) {
      const result = {
        type: "result",
        taskId: task.taskId,
        correlationId: task.correlationId,
        status,
        payload,
        completedAt: Date.now(),
        completedBy: "orchestrator-1",
      } as ResultEnvelope;
      for (const handler of handlers.result ?? []) handler(result);
    },
    listenerCount: (type: string) => (handlers[type] ?? []).length,
  };
}

function bridgeOn(room: ReturnType<typeof fakeRoom>, options = {}) {
  const agents = { agentId: room.agentId, room: () => room } as unknown as NoLagAgents;
  return new OrchestratorBridge({ agents, ...options });
}

describe("scaling the orchestrator", () => {
  it("names both halves of the setting that stops duplicate inference", () => {
    // The tasks topic broadcasts by default, so N replicas each run the same
    // large-model call and N answers race back to one call. loadBalance alone
    // is not enough either: the group defaults to the actor token id, so
    // replicas holding different tokens each form a group and each get a copy.
    expect(orchestratorPoolOptions()).toEqual({
      loadBalance: true,
      loadBalanceGroup: "orchestrator-pool",
    });
    expect(orchestratorPoolOptions("transfers")).toEqual({
      loadBalance: true,
      loadBalanceGroup: "transfers",
    });
  });
});

describe("OrchestratorBridge", () => {
  it("addresses the reply to this process, not to the room", async () => {
    const room = fakeRoom();
    const bridge = bridgeOn(room);

    bridge.ask({ question: "Is the 1:15 free?", callId: "CA1" });

    // Results are published with a filter on replyTo and subscribed with a
    // filter on this room's agent id. Two processes sharing an id send each
    // other's answers to the wrong call.
    expect(room.tasks[0]).toMatchObject({
      capability: "orchestrate",
      replyTo: "voice-host-1",
      createdBy: "voice-host-1",
      payload: { question: "Is the 1:15 free?", callId: "CA1" },
    });
    expect(room.tasks[0].correlationId).toBeTruthy();
  });

  it("matches an answer to the question that asked it", async () => {
    const room = fakeRoom();
    const bridge = bridgeOn(room);

    const first = bridge.ask({ question: "Is the 1:15 free?", callId: "CA1" });
    const second = bridge.ask({ question: "What about 2:30?", callId: "CA2" });
    expect(bridge.pending).toBe(2);

    // Answered out of order, which is the normal case when one lookup is
    // slower than another.
    room.answer(room.tasks[1], { speech: "The 2:30 is free." });
    room.answer(room.tasks[0], { speech: "The 1:15 is taken." });

    expect(await second.answer).toMatchObject({ ok: true, speech: "The 2:30 is free." });
    expect(await first.answer).toMatchObject({ ok: true, speech: "The 1:15 is taken." });
    expect(bridge.pending).toBe(0);
  });

  it("gives up rather than waiting forever, and leaves nothing behind", async () => {
    const room = fakeRoom();
    const bridge = bridgeOn(room, { timeoutMs: 20 });

    const pending = bridge.ask({ question: "Anyone there?", callId: "CA1" });

    // Nothing in the Agents SDK defaults a timeout, so an ask without one
    // leaves a promise, a map entry and the call's context behind for the life
    // of the process. That only ever shows up as a slow memory climb.
    expect(await pending.answer).toMatchObject({ ok: false, reason: "timeout" });
    expect(bridge.pending).toBe(0);
  });

  it("never rejects, whatever the orchestrator does", async () => {
    const room = fakeRoom();
    const bridge = bridgeOn(room);

    const failed = bridge.ask({ question: "Refund it", callId: "CA1" });
    room.answer(room.tasks[0], { message: "no such booking" }, "error");
    expect(await failed.answer).toMatchObject({ ok: false, reason: "error" });

    const empty = bridge.ask({ question: "And this?", callId: "CA1" });
    room.answer(room.tasks[1], {});
    // A success with nothing to say is not an answer.
    expect(await empty.answer).toMatchObject({ ok: false, speech: "" });
  });

  it("survives a publish that never leaves the process", async () => {
    const room = fakeRoom();
    const bridge = bridgeOn(room);
    room.publishTask = () => {
      throw new Error("socket closed");
    };

    const pending = bridge.ask({ question: "Is the 1:15 free?", callId: "CA1" });
    expect(await pending.answer).toMatchObject({ ok: false, reason: "undeliverable" });
    expect(bridge.pending).toBe(0);
  });

  it("caps an answer rather than letting an oversized publish fail", async () => {
    const room = fakeRoom();
    const bridge = bridgeOn(room, { maxAnswerChars: 20 });

    const pending = bridge.ask({ question: "Tell me everything", callId: "CA1" });
    room.answer(room.tasks[0], { speech: "x".repeat(500) });

    expect((await pending.answer).speech).toHaveLength(20);
  });

  it("reports what the room can do, from both presence views", async () => {
    const room = fakeRoom(["orchestrate", "lookup"]);
    const bridge = bridgeOn(room);

    expect(await bridge.ready()).toEqual(["lookup", "orchestrate"]);
    expect(bridge.available).toBe(true);
  });

  it("names the mistake that looks like a slow orchestrator", async () => {
    const room = fakeRoom();
    room.fetchPresence = async () => [{ capabilities: ["orchestrate"], actorId: "actor-1" }];
    const agents = {
      agentId: room.agentId,
      room: () => room,
      client: { actorId: "actor-1" },
    } as unknown as NoLagAgents;
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (message: string) => warnings.push(message);

    try {
      const bridge = new OrchestratorBridge({ agents });
      await bridge.ready();

      // Everything visible looks right: both sides connect, both join, presence
      // lists them, the capability is discovered. The only symptom is that no
      // answer ever comes, which reads like a slow orchestrator.
      expect(bridge.sharesAnActor).toBe(true);
      expect(warnings[0]).toMatch(/same actor|own actor token/);
    } finally {
      console.warn = original;
    }
  });

  it("stays quiet when the orchestrator is a different actor", async () => {
    const room = fakeRoom();
    room.fetchPresence = async () => [{ capabilities: ["orchestrate"], actorId: "actor-2" }];
    const agents = {
      agentId: room.agentId,
      room: () => room,
      client: { actorId: "actor-1" },
    } as unknown as NoLagAgents;

    const bridge = new OrchestratorBridge({ agents });
    await bridge.ready();
    expect(bridge.sharesAnActor).toBe(false);
  });

  it("knows when nobody can help", async () => {
    const room = fakeRoom([]);
    const bridge = bridgeOn(room);

    await bridge.ready();
    expect(bridge.available).toBe(false);
  });

  it("settles every outstanding ask when it is released", async () => {
    const room = fakeRoom();
    const bridge = bridgeOn(room);

    const pending = bridge.ask({ question: "Is the 1:15 free?", callId: "CA1" });
    bridge.detach();

    expect(await pending.answer).toMatchObject({ ok: false, reason: "cancelled" });
    expect(bridge.pending).toBe(0);
    expect(room.listenerCount("result")).toBe(0);
  });
});

/** A stand-in for the live call, recording what it was asked to say. */
function fakeFloor() {
  const said: Array<{ text: string; kind?: string }> = [];
  const stalls: Array<{ lines: string[]; stopped: boolean }> = [];
  const floor: VoiceFloor = {
    speakUnprompted: (speech) => {
      said.push({ text: speech.text, kind: speech.kind });
      return { done: Promise.resolve("spoken"), started: true, cancel: () => false };
    },
    beginStall: (options) => {
      const record = { lines: options.lines, stopped: false };
      stalls.push(record);
      return {
        stop: () => {
          record.stopped = true;
        },
        stage: 0,
      };
    },
  };
  return { floor, said, stalls };
}

/** A model that says whatever it is scripted to, sentence by sentence. */
function fakeModel(script: string[]) {
  const seen: string[][] = [];
  return {
    seen,
    async chat(request: { messages: Array<{ content: string }>; onSentence?: (s: string) => void }) {
      seen.push(request.messages.map((m) => m.content));
      const reply = script.shift() ?? "";
      for (const sentence of reply.split(/(?<=[.!?\]])\s+/).filter(Boolean)) {
        request.onSentence?.(sentence);
      }
      return reply;
    },
  };
}

describe("orchestratedModel", () => {
  it("costs nothing on a turn that does not need help", async () => {
    const room = fakeRoom();
    const { floor, said } = fakeFloor();
    const model = fakeModel(["We open at eight. See you then."]);
    const spoken: string[] = [];

    const wrapped = orchestratedModel({
      model,
      bridge: bridgeOn(room),
      floor,
      callId: "CA1",
    });

    const reply = await wrapped.chat({
      messages: [{ role: "system", content: "You are an agent." }],
      onSentence: (sentence) => spoken.push(sentence),
    });

    // Streamed sentence by sentence exactly as before, so the head start that
    // makes the agent feel responsive is untouched on the great majority of
    // turns.
    expect(spoken).toEqual(["We open at eight.", "See you then."]);
    expect(reply).toBe("We open at eight. See you then.");
    expect(room.tasks).toHaveLength(0);
    expect(said).toEqual([]);
  });

  it("hides a fast answer completely", async () => {
    const room = fakeRoom();
    const { floor, said, stalls } = fakeFloor();
    const model = fakeModel(["[[ask: is the 1:15 pickup free]]", "The 1:15 is free, shall I book it?"]);
    const spoken: string[] = [];

    const wrapped = orchestratedModel({
      model,
      bridge: bridgeOn(room),
      floor,
      callId: "CA1",
      graceMs: 500,
    });

    const turn = wrapped.chat({
      messages: [{ role: "system", content: "You are an agent." }],
      onSentence: (sentence) => spoken.push(sentence),
    });

    await Promise.resolve();
    room.answer(room.tasks[0], { speech: "The 1:15 is free." });

    expect(await turn).toBe("The 1:15 is free, shall I book it?");
    // The caller never learns anything was asked on their behalf: no marker
    // spoken, no acknowledgement, no stall.
    expect(spoken).toEqual(["The 1:15 is free, shall I book it?"]);
    expect(said).toEqual([]);
    expect(stalls).toEqual([]);
    // The second call sees the answer as guidance, not as something said.
    expect(model.seen[1].join("\n")).toContain("The 1:15 is free.");
  });

  it("ends the turn and delivers a slow answer when it lands", async () => {
    const room = fakeRoom();
    const { floor, said, stalls } = fakeFloor();
    const model = fakeModel(["[[ask: is the 1:15 pickup free]]"]);

    const wrapped = orchestratedModel({
      model,
      bridge: bridgeOn(room),
      floor,
      callId: "CA1",
      graceMs: 10,
    });

    const reply = await wrapped.chat({ messages: [{ role: "system", content: "Agent." }] });

    // A turn cannot be held open for thirty seconds, so it ends with nothing
    // to say and the waiting is made audible instead.
    expect(reply).toBe("");
    expect(said).toEqual([
      { text: "Let me look into that, one moment.", kind: "acknowledge" },
    ]);
    expect(stalls).toHaveLength(1);

    room.answer(room.tasks[0], { speech: "About that pickup, the 1:15 is free." });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(stalls[0].stopped).toBe(true);
    expect(said[1]).toEqual({
      text: "About that pickup, the 1:15 is free.",
      kind: "orchestrator",
    });
  });

  it("says something rather than nothing when no answer ever comes", async () => {
    const room = fakeRoom();
    const { floor, said } = fakeFloor();
    const model = fakeModel(["[[ask: is the 1:15 pickup free]]"]);

    const wrapped = orchestratedModel({
      model,
      bridge: bridgeOn(room, { timeoutMs: 20 }),
      floor,
      callId: "CA1",
      graceMs: 5,
    });

    await wrapped.chat({ messages: [{ role: "system", content: "Agent." }] });
    await new Promise((resolve) => setTimeout(resolve, 60));

    // Silence would read as a dropped call, and the caller is still holding a
    // phone waiting for an answer that is never coming.
    expect(said.map((line) => line.text)).toEqual([
      "Let me look into that, one moment.",
      "Sorry, I could not get that looked up just now.",
    ]);
  });

  it("never reads the marker out loud", async () => {
    const room = fakeRoom();
    const { floor } = fakeFloor();
    const model = fakeModel(["Let me check that for you. [[ask: is the 1:15 free]]"]);
    const spoken: string[] = [];

    const wrapped = orchestratedModel({
      model,
      bridge: bridgeOn(room),
      floor,
      callId: "CA1",
      graceMs: 5,
    });

    const reply = await wrapped.chat({
      messages: [{ role: "system", content: "Agent." }],
      onSentence: (sentence) => spoken.push(sentence),
    });

    expect(spoken).toEqual(["Let me check that for you."]);
    // What was said is what is remembered, so the model does not later see
    // itself saying something the caller never heard.
    expect(reply).toBe("Let me check that for you.");
  });

  it("only lets one ask be outstanding at a time", async () => {
    const room = fakeRoom();
    const { floor } = fakeFloor();
    const model = fakeModel([
      "[[ask: is the 1:15 free]]",
      "[[ask: what about 2:30]]",
    ]);

    const wrapped = orchestratedModel({
      model,
      bridge: bridgeOn(room),
      floor,
      callId: "CA1",
      graceMs: 5,
    });

    await wrapped.chat({ messages: [{ role: "system", content: "Agent." }] });
    await wrapped.chat({ messages: [{ role: "system", content: "Agent." }] });

    // One inviting tool gets reached for constantly, and each reach costs the
    // caller seconds and the orchestrator an inference.
    expect(room.tasks).toHaveLength(1);
    // The second turn was not offered the protocol at all, so a well-behaved
    // model has no reason to try.
    expect(model.seen[1].join("\n")).not.toContain("[[ask:");
  });

  it("stops offering the protocol once the call has asked too often", async () => {
    const room = fakeRoom();
    const { floor } = fakeFloor();
    const model = fakeModel(["[[ask: one]]", "[[ask: two]]"]);

    const wrapped = orchestratedModel({
      model,
      bridge: bridgeOn(room),
      floor,
      callId: "CA1",
      graceMs: 5,
      maxAsksPerCall: 1,
    });

    await wrapped.chat({ messages: [{ role: "system", content: "Agent." }] });
    room.answer(room.tasks[0], { speech: "Yes." });
    await new Promise((resolve) => setTimeout(resolve, 0));

    await wrapped.chat({ messages: [{ role: "system", content: "Agent." }] });
    expect(room.tasks).toHaveLength(1);
  });

  it("stays quiet about a colleague nobody has hired", async () => {
    const room = fakeRoom([]);
    const { floor } = fakeFloor();
    const model = fakeModel(["We open at eight."]);

    const wrapped = orchestratedModel({
      model,
      bridge: bridgeOn(room),
      floor,
      callId: "CA1",
    });

    await wrapped.chat({ messages: [{ role: "system", content: "You are an agent." }] });

    // With nothing in the room, offering the protocol would only ever produce
    // asks that time out.
    expect(model.seen[0].join("\n")).not.toContain("[[ask:");
  });
});
