import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "../../src/EventEmitter";

type TestEvents = {
  message: [text: string];
  count: [n: number];
};

class TestEmitter extends EventEmitter<TestEvents> {
  // Expose emit for testing
  public doEmit<K extends keyof TestEvents>(
    event: K,
    ...args: TestEvents[K]
  ) {
    this.emit(event, ...args);
  }
}

describe("EventEmitter", () => {
  it("registers and calls handlers", () => {
    const emitter = new TestEmitter();
    const handler = vi.fn();
    emitter.on("message", handler);
    emitter.doEmit("message", "hello");
    expect(handler).toHaveBeenCalledWith("hello");
  });

  it("removes a specific handler", () => {
    const emitter = new TestEmitter();
    const handler = vi.fn();
    emitter.on("message", handler);
    emitter.off("message", handler);
    emitter.doEmit("message", "hello");
    expect(handler).not.toHaveBeenCalled();
  });

  it("removes all handlers for an event", () => {
    const emitter = new TestEmitter();
    const h1 = vi.fn();
    const h2 = vi.fn();
    emitter.on("message", h1);
    emitter.on("message", h2);
    emitter.off("message");
    emitter.doEmit("message", "hello");
    expect(h1).not.toHaveBeenCalled();
    expect(h2).not.toHaveBeenCalled();
  });

  it("reports listener count", () => {
    const emitter = new TestEmitter();
    expect(emitter.listenerCount("message")).toBe(0);
    emitter.on("message", () => {});
    expect(emitter.listenerCount("message")).toBe(1);
  });

  it("removes all listeners", () => {
    const emitter = new TestEmitter();
    emitter.on("message", () => {});
    emitter.on("count", () => {});
    emitter.removeAllListeners();
    expect(emitter.listenerCount("message")).toBe(0);
    expect(emitter.listenerCount("count")).toBe(0);
  });
});
