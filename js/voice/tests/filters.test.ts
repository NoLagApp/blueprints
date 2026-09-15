import { describe, it, expect } from "vitest";
import type { NoLagAgents } from "@nolag/agents";
import { NoLagVoice } from "../src/NoLagVoice.js";
import { CALL_TRANSCRIPT, callEventCategory } from "../src/types.js";

/**
 * Filter API contract for @nolag/voice.
 *
 * A call publishes two kinds of thing on one topic: transcript lines, one per
 * utterance, and a handful of lifecycle events. `watchCall` used to receive
 * both and discard by category in the handler. Filters move that to the
 * broker, so a metrics dashboard never receives the transcript at all.
 *
 * The constraint that shapes this: filters are scoped to the events topic.
 * `inbox` — which carries say/instruct steering — is published unfiltered and
 * matched on `to` client-side, so a room-wide filter would silently stop
 * steering from arriving.
 */

function fakeRoom() {
  const events: Array<{ envelope: Record<string, unknown>; options?: unknown }> = [];
  const inbox: Record<string, unknown>[] = [];
  const filterCalls: Array<{ values: unknown; options?: unknown }> = [];
  const handlers: Record<string, (envelope: unknown) => void> = {};
  return {
    events,
    inbox,
    filterCalls,
    deliver: (type: string, envelope: unknown) => handlers[type]?.(envelope),
    publishEvent: (envelope: Record<string, unknown>, options?: unknown) =>
      events.push({ envelope, options }),
    publishInbox: (envelope: Record<string, unknown>) => inbox.push(envelope),
    setFilters: (values: unknown, options?: unknown) => filterCalls.push({ values, options }),
    on: (type: string, handler: (envelope: unknown) => void) => {
      handlers[type] = handler;
    },
  };
}

function fakeAgents(room: ReturnType<typeof fakeRoom>, agentId = "supervisor-1") {
  return { agentId, room: () => room } as unknown as NoLagAgents;
}

describe("publishCall tagging", () => {
  it("tags transcript lines with the transcript category", () => {
    const room = fakeRoom();
    const publisher = new NoLagVoice({ agents: fakeAgents(room) }).publishCall("CA-1");

    publisher.onCallerSpeech("hello", { sttMs: 100 });

    expect(room.events.at(-1)!.options).toEqual({ filter: CALL_TRANSCRIPT });
  });

  it("tags a lifecycle event with its own category", () => {
    const room = fakeRoom();
    const publisher = new NoLagVoice({ agents: fakeAgents(room) }).publishCall("CA-1");

    publisher.onBargeIn();

    expect(room.events.at(-1)!.options).toEqual({
      filter: callEventCategory("barge-in"),
    });
  });

  it("tags each event to match its own envelope category", () => {
    const room = fakeRoom();
    const publisher = new NoLagVoice({ agents: fakeAgents(room) }).publishCall("CA-1");

    publisher.onCallStarted({ callId: "CA-1", peer: "+61", outbound: false });
    publisher.onAgentSpeech("hi", { kind: "greeting" });
    publisher.onError(new Error("boom"));

    // A filter that disagreed with the category would make setFilters select
    // the wrong events, so they have to be derived from the same value.
    for (const { envelope, options } of room.events) {
      expect(options).toEqual({ filter: envelope.category });
    }
  });

  it("still records the category in the envelope, for unfiltered watchers", () => {
    const room = fakeRoom();
    const publisher = new NoLagVoice({ agents: fakeAgents(room) }).publishCall("CA-1");

    publisher.onCallerSpeech("hello", { sttMs: 100 });

    expect(room.events.at(-1)!.envelope.category).toBe(CALL_TRANSCRIPT);
  });

  it("can be turned off to reproduce pre-filter wire behaviour", () => {
    const room = fakeRoom();
    const publisher = new NoLagVoice({ agents: fakeAgents(room) }).publishCall(
      "CA-1",
      {},
      { tagCategories: false },
    );

    publisher.onCallerSpeech("hello", { sttMs: 100 });

    expect(room.events.at(-1)!.options).toBeUndefined();
  });
});

describe("watchCall filters", () => {
  it("subscribes unfiltered by default", () => {
    const room = fakeRoom();
    new NoLagVoice({ agents: fakeAgents(room) }).watchCall("CA-1");

    expect(room.filterCalls).toHaveLength(0);
  });

  it("applies requested filters to the events topic only", () => {
    const room = fakeRoom();
    new NoLagVoice({ agents: fakeAgents(room) }).watchCall(
      "CA-1",
      {},
      { filters: [CALL_TRANSCRIPT] },
    );

    expect(room.filterCalls).toEqual([
      { values: [CALL_TRANSCRIPT], options: { topic: "events" } },
    ]);
  });

  it("never filters inbox, so steering keeps arriving", () => {
    const room = fakeRoom();
    new NoLagVoice({ agents: fakeAgents(room) }).watchCall(
      "CA-1",
      {},
      { filters: [CALL_TRANSCRIPT] },
    );

    for (const call of room.filterCalls) {
      expect((call.options as { topic?: string }).topic).toBe("events");
    }
  });

  it("steering still publishes after filters are applied", () => {
    const room = fakeRoom();
    const watcher = new NoLagVoice({ agents: fakeAgents(room) }).watchCall(
      "CA-1",
      {},
      { filters: [CALL_TRANSCRIPT] },
    );

    watcher.say("please hold");

    expect(room.inbox.at(-1)).toMatchObject({
      to: "call-ca-1",
      payload: { type: "say", text: "please hold" },
    });
  });

  it("treats an empty filter list as no filtering", () => {
    const room = fakeRoom();
    new NoLagVoice({ agents: fakeAgents(room) }).watchCall("CA-1", {}, { filters: [] });

    expect(room.filterCalls).toHaveLength(0);
  });

  it("can re-point filters mid-call", () => {
    const room = fakeRoom();
    const watcher = new NoLagVoice({ agents: fakeAgents(room) }).watchCall("CA-1");

    watcher.setFilters([callEventCategory("turn-complete")]);

    expect(room.filterCalls).toEqual([
      { values: [callEventCategory("turn-complete")], options: { topic: "events" } },
    ]);
  });

  it("restores the full stream with an empty array", () => {
    const room = fakeRoom();
    const watcher = new NoLagVoice({ agents: fakeAgents(room) }).watchCall(
      "CA-1",
      {},
      { filters: [CALL_TRANSCRIPT] },
    );

    watcher.setFilters([]);

    expect(room.filterCalls.at(-1)).toEqual({ values: [], options: { topic: "events" } });
  });

  it("delivers a filtered transcript to the transcript handler", () => {
    const room = fakeRoom();
    const lines: unknown[] = [];
    new NoLagVoice({ agents: fakeAgents(room) }).watchCall(
      "CA-1",
      { onTranscript: (line) => lines.push(line) },
      { filters: [CALL_TRANSCRIPT] },
    );

    room.deliver("event", {
      category: CALL_TRANSCRIPT,
      timestamp: 1000,
      payload: { role: "caller", text: "hello" },
    });

    expect(lines).toEqual([{ at: 1000, role: "caller", text: "hello" }]);
  });
});

describe("category helpers", () => {
  it("builds a call event category", () => {
    expect(callEventCategory("turn-complete")).toBe("call.turn-complete");
  });

  it("keeps every category free of characters illegal in a filter", () => {
    // '/', '#', '+' and '|' are rejected by the broker as filter values.
    const categories = [
      CALL_TRANSCRIPT,
      ...(["call-started", "call-ended", "screening-detected", "barge-in", "turn-complete", "error"] as const).map(
        callEventCategory,
      ),
    ];
    for (const category of categories) {
      expect(category).not.toMatch(/[/#+|]/);
    }
  });
});
