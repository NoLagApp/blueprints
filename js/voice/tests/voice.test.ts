import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { NoLagAgents } from "@nolag/agents";
import { NoLagVoice } from "../src/NoLagVoice.js";
import { callAgentId, callRoomSlug, createRoomProvisioner } from "../src/rooms.js";
import { VOICE_TOPICS } from "../src/types.js";

/**
 * A stand-in for an AgentRoom. Observe and Inbox only ever call publishEvent,
 * publishInbox and on(), so faking those is enough to exercise the wiring
 * without a broker.
 */
function fakeRoom() {
  const events: Record<string, unknown>[] = [];
  const inbox: Record<string, unknown>[] = [];
  const handlers: Record<string, (envelope: unknown) => void> = {};
  return {
    events,
    inbox,
    deliver: (type: string, envelope: unknown) => handlers[type]?.(envelope),
    publishEvent: (envelope: Record<string, unknown>) => events.push(envelope),
    publishInbox: (envelope: Record<string, unknown>) => inbox.push(envelope),
    on: (type: string, handler: (envelope: unknown) => void) => {
      handlers[type] = handler;
    },
  };
}

function fakeAgents(room: ReturnType<typeof fakeRoom>, agentId = "supervisor-1") {
  return { agentId, room: () => room } as unknown as NoLagAgents;
}

describe("call identity", () => {
  it("lowercases the room slug, because slugs are stored verbatim", () => {
    expect(callRoomSlug("CAfe44844F0181dd8")).toBe("cafe44844f0181dd8");
  });

  it("derives an agent id a supervisor can address without being told", () => {
    // The whole steering story depends on this being predictable from the
    // call id alone: nothing has to publish "here is my agent id" first.
    expect(callAgentId("CAfe44844F0181dd8")).toBe("call-cafe44844f0181dd8");
  });
});

describe("NoLagVoice", () => {
  it("refuses to construct without an injected agents instance", () => {
    expect(() => new NoLagVoice({} as never)).toThrow(/injected NoLagAgents/);
  });
});

describe("publishCall", () => {
  it("publishes transcript lines and prefixed events", () => {
    const room = fakeRoom();
    const publisher = new NoLagVoice({ agents: fakeAgents(room) }).publishCall("CA-Abc");

    publisher.onCallerSpeech("what time is my pickup?", { sttMs: 700 });
    publisher.onAgentSpeech("One moment.", { kind: "filler" });
    publisher.onTurnComplete({ sttMs: 700, llmMs: 800, firstAudioMs: 1500, clips: 2, totalMs: 4000 });

    const categories = room.events.map((e) => e.category);
    expect(categories).toEqual(["call.transcript", "call.transcript", "call.turn-complete"]);

    const caller = room.events[0]!.payload as Record<string, unknown>;
    expect(caller).toMatchObject({ role: "caller", text: "what time is my pickup?", sttMs: 700 });
    expect(room.events[1]!.payload).toMatchObject({ role: "agent", kind: "filler" });
  });

  it("marks errors with error severity so dashboards can filter them", () => {
    const room = fakeRoom();
    const publisher = new NoLagVoice({ agents: fakeAgents(room) }).publishCall("CA-Abc");
    publisher.onError(new Error("speech synthesis failed"));

    expect(room.events[0]).toMatchObject({
      category: "call.error",
      severity: "error",
      payload: { message: "speech synthesis failed" },
    });
  });

  it("routes inbox steering to the right handler", () => {
    const room = fakeRoom();
    const said: string[] = [];
    const instructed: string[] = [];
    new NoLagVoice({ agents: fakeAgents(room) }).publishCall("CA-Abc", {
      onSay: (text) => said.push(text),
      onInstruct: (text) => instructed.push(text),
    });

    const to = callAgentId("CA-Abc");
    room.deliver("inbox", { to, from: "supervisor", payload: { type: "say", text: "hold the car" } });
    room.deliver("inbox", { to, from: "supervisor", payload: { type: "instruct", text: "be brief" } });
    // "instruction" is accepted too, so an older supervisor still works.
    room.deliver("inbox", { to, from: "supervisor", payload: { type: "instruction", text: "no refunds" } });
    // Anything without text is ignored rather than crashing the call.
    room.deliver("inbox", { to, from: "supervisor", payload: { type: "say" } });

    expect(said).toEqual(["hold the car"]);
    expect(instructed).toEqual(["be brief", "no refunds"]);
  });
});

describe("watchCall", () => {
  it("separates transcript from events and strips the prefix", () => {
    const room = fakeRoom();
    const lines: unknown[] = [];
    const events: unknown[] = [];
    new NoLagVoice({ agents: fakeAgents(room) }).watchCall("CA-Abc", {
      onTranscript: (line) => lines.push(line),
      onEvent: (event) => events.push(event),
    });

    room.deliver("event", {
      category: "call.transcript",
      timestamp: 111,
      payload: { role: "agent", text: "Hi Ritta" },
    });
    room.deliver("event", {
      category: "call.screening-detected",
      timestamp: 222,
      payload: { kind: "voicemail" },
    });
    // Events from something else sharing the room are not ours to render.
    room.deliver("event", { category: "task.dispatched", timestamp: 333, payload: {} });

    expect(lines).toEqual([{ at: 111, role: "agent", text: "Hi Ritta" }]);
    expect(events).toEqual([{ event: "screening-detected", at: 222, kind: "voicemail" }]);
  });

  it("addresses steering at the call, not at itself", () => {
    const room = fakeRoom();
    const watcher = new NoLagVoice({ agents: fakeAgents(room, "supervisor-9") }).watchCall("CA-Abc");
    watcher.say("we can hold until 2pm");

    expect(room.inbox[0]).toMatchObject({
      to: callAgentId("CA-Abc"),
      from: "supervisor-9",
      payload: { type: "say", text: "we can hold until 2pm" },
    });
  });
});

describe("createRoomProvisioner", () => {
  const original = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = original;
  });

  const respondWith = (apps: unknown[]) => {
    const calls: Array<{ url: string; body: unknown }> = [];
    globalThis.fetch = vi.fn(async (url: unknown, init?: { body?: string }) => {
      calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : undefined });
      const payload = String(url).endsWith("/apps") ? { data: apps } : {};
      return { ok: true, status: 200, text: async () => JSON.stringify(payload) } as Response;
    }) as unknown as typeof fetch;
    return calls;
  };

  const app = {
    appId: "app-1",
    slug: "voice-calls-56c2",
    topics: [...VOICE_TOPICS],
    config: { autoProvisionRooms: true },
  };
  const options = { apiKey: "nlg_live_x", appSlug: "voice-calls-56c2" };

  it("ensures a room with the topics the blueprint defines", async () => {
    const calls = respondWith([app]);
    const provisioner = await createRoomProvisioner(options);
    await provisioner.ensureRoom("ca-abc");

    expect(provisioner.appId).toBe("app-1");
    expect(calls[1]!.url).toContain("/apps/app-1/rooms/ensure");
    expect(calls[1]!.body).toEqual({ name: "ca-abc", slug: "ca-abc", topics: [...VOICE_TOPICS] });
  });

  it("says which slugs exist when the app is not found", async () => {
    // App slugs get a random suffix, so "not found" is usually a copied slug
    // missing it. The message should make that obvious immediately.
    respondWith([{ ...app, slug: "voice-calls-9999" }]);
    await expect(createRoomProvisioner(options)).rejects.toThrow(/voice-calls-9999/);
  });

  it("refuses when the app cannot create per-call rooms", async () => {
    respondWith([{ ...app, config: { autoProvisionRooms: false } }]);
    await expect(createRoomProvisioner(options)).rejects.toThrow(/autoProvisionRooms/);
  });

  it("refuses when the app schema is missing topics", async () => {
    respondWith([{ ...app, topics: ["events"] }]);
    await expect(createRoomProvisioner(options)).rejects.toThrow(/missing topics: tasks/);
  });
});
