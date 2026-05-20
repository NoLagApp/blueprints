import { describe, it, expect, vi } from "vitest";
import { CorrelationManager } from "../../src/correlation";

describe("CorrelationManager", () => {
  it("resolves a pending correlation", async () => {
    const manager = new CorrelationManager<string>();
    const promise = manager.register("id-1");
    expect(manager.has("id-1")).toBe(true);
    expect(manager.size).toBe(1);

    manager.resolve("id-1", "result");
    await expect(promise).resolves.toBe("result");
    expect(manager.size).toBe(0);
  });

  it("rejects a pending correlation", async () => {
    const manager = new CorrelationManager<string>();
    const promise = manager.register("id-2");
    manager.reject("id-2", new Error("fail"));
    await expect(promise).rejects.toThrow("fail");
  });

  it("times out after specified duration", async () => {
    vi.useFakeTimers();
    const manager = new CorrelationManager<string>();
    const promise = manager.register("id-3", 100);

    vi.advanceTimersByTime(101);

    await expect(promise).rejects.toThrow("timed out");
    expect(manager.size).toBe(0);
    vi.useRealTimers();
  });

  it("clears all pending correlations", async () => {
    const manager = new CorrelationManager<string>();
    const p1 = manager.register("id-a");
    const p2 = manager.register("id-b");

    manager.clear();

    await expect(p1).rejects.toThrow("cancelled");
    await expect(p2).rejects.toThrow("cancelled");
    expect(manager.size).toBe(0);
  });

  it("returns false for unknown correlationIds", () => {
    const manager = new CorrelationManager<string>();
    expect(manager.resolve("unknown", "value")).toBe(false);
    expect(manager.reject("unknown", new Error("err"))).toBe(false);
  });
});
