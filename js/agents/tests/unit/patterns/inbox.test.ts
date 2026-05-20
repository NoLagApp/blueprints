import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockAgentRoom } from "../helpers/mockAgentRoom";
import { Inbox } from "../../../src/patterns/inbox";

describe("Inbox pattern", () => {
  let room: ReturnType<typeof createMockAgentRoom>;
  let inbox: Inbox;

  beforeEach(() => {
    room = createMockAgentRoom();
    inbox = new Inbox(room, "agent-1");
  });

  // --- send ---

  it("publishes an inbox message on send", () => {
    inbox.send("agent-2", { text: "hello" });
    const published = room.getPublished();
    expect(published).toHaveLength(1);
    expect(published[0].method).toBe("publishInbox");
    const msg = published[0].data as any;
    expect(msg.from).toBe("agent-1");
    expect(msg.to).toBe("agent-2");
    expect(msg.payload).toEqual({ text: "hello" });
    expect(msg.messageId).toBeDefined();
    expect(typeof msg.createdAt).toBe("number");
  });

  it("generates unique message IDs", () => {
    inbox.send("agent-2", { a: 1 });
    inbox.send("agent-2", { a: 2 });
    const ids = room.getPublished().map((p) => (p.data as any).messageId);
    expect(ids[0]).not.toBe(ids[1]);
  });

  // --- onMessage ---

  it("receives messages addressed to this agent", () => {
    const handler = vi.fn();
    inbox.onMessage(handler);

    room.simulate("inbox", {
      messageId: "m1",
      from: "agent-2",
      to: "agent-1",
      payload: { text: "hi" },
      createdAt: Date.now(),
    } as any);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0].payload).toEqual({ text: "hi" });
  });

  it("filters out messages addressed to other agents", () => {
    const handler = vi.fn();
    inbox.onMessage(handler);

    room.simulate("inbox", {
      messageId: "m1",
      from: "agent-2",
      to: "agent-3",
      payload: { text: "not for me" },
      createdAt: Date.now(),
    } as any);

    expect(handler).not.toHaveBeenCalled();
  });

  it("multiple agents can receive their own messages", () => {
    const inbox2 = new Inbox(room, "agent-2");
    const handler1 = vi.fn();
    const handler2 = vi.fn();
    inbox.onMessage(handler1);
    inbox2.onMessage(handler2);

    room.simulate("inbox", {
      messageId: "m1",
      from: "agent-3",
      to: "agent-1",
      payload: {},
      createdAt: Date.now(),
    } as any);

    room.simulate("inbox", {
      messageId: "m2",
      from: "agent-3",
      to: "agent-2",
      payload: {},
      createdAt: Date.now(),
    } as any);

    expect(handler1).toHaveBeenCalledTimes(1);
    expect(handler2).toHaveBeenCalledTimes(1);
  });

  it("delivers messages in order", () => {
    const received: string[] = [];
    inbox.onMessage((msg) => received.push((msg as any).payload.seq));

    for (let i = 0; i < 5; i++) {
      room.simulate("inbox", {
        messageId: `m${i}`,
        from: "agent-2",
        to: "agent-1",
        payload: { seq: `msg-${i}` },
        createdAt: Date.now(),
      } as any);
    }

    expect(received).toEqual(["msg-0", "msg-1", "msg-2", "msg-3", "msg-4"]);
  });

  // --- edge cases ---

  it("send with empty payload publishes empty payload object", () => {
    inbox.send("agent-2", {});
    const msg = room.getPublished()[0].data as any;
    expect(msg.to).toBe("agent-2");
    expect(msg.payload).toEqual({});
  });

  it("broadcast to 'all' is not received by agent-1 handler (exact agentId match)", () => {
    const handler = vi.fn();
    inbox.onMessage(handler);

    room.simulate("inbox", {
      messageId: "m-broadcast",
      from: "agent-2",
      to: "all",
      payload: { text: "broadcast" },
      createdAt: Date.now(),
    } as any);

    expect(handler).not.toHaveBeenCalled();
  });

  it("multiple handlers registered for same agent both receive the message", () => {
    const handler1 = vi.fn();
    const handler2 = vi.fn();
    inbox.onMessage(handler1);
    inbox.onMessage(handler2);

    room.simulate("inbox", {
      messageId: "m1",
      from: "agent-2",
      to: "agent-1",
      payload: { text: "hi" },
      createdAt: Date.now(),
    } as any);

    expect(handler1).toHaveBeenCalledTimes(1);
    expect(handler2).toHaveBeenCalledTimes(1);
  });

  it("createdAt is a number timestamp", () => {
    inbox.send("agent-2", { text: "hello" });
    const msg = room.getPublished()[0].data as any;
    expect(typeof msg.createdAt).toBe("number");
  });
});
