import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock @nolag/js-sdk before importing NoLagAgents
const mockClient = {
  connected: false,
  actorId: "test-agent-123",
  connect: vi.fn(),
  disconnect: vi.fn(),
  on: vi.fn(),
  off: vi.fn(),
  setApp: vi.fn(),
};

const mockRoomContext = {
  prefix: "agents/default-workflow",
  subscribe: vi.fn(),
  unsubscribe: vi.fn(),
  emit: vi.fn(),
  on: vi.fn().mockReturnThis(),
  off: vi.fn().mockReturnThis(),
};

const mockAppContext = {
  setRoom: vi.fn(() => mockRoomContext),
};

mockClient.setApp.mockReturnValue(mockAppContext);

vi.mock("@nolag/js-sdk", () => ({
  NoLag: vi.fn(() => mockClient),
}));

import { NoLagAgents } from "../../src/NoLagAgents";

describe("NoLagAgents", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockClient.connect.mockResolvedValue(undefined);
  });

  it("can be instantiated with a token", () => {
    const agents = new NoLagAgents("test-token");
    expect(agents).toBeDefined();
    expect(agents.connected).toBe(false);
  });

  it("can be instantiated with options", () => {
    const agents = new NoLagAgents("test-token", {
      appName: "my-workflow",
      debug: true,
      rooms: ["room-a", "room-b"],
    });
    expect(agents).toBeDefined();
  });

  it("connects and auto-joins rooms", async () => {
    const agents = new NoLagAgents("test-token", {
      rooms: ["default-workflow"],
    });

    await agents.connect();

    expect(mockClient.connect).toHaveBeenCalled();
    expect(mockAppContext.setRoom).toHaveBeenCalledWith("default-workflow");
    expect(agents.rooms.size).toBe(1);
    expect(agents.rooms.has("default-workflow")).toBe(true);
  });

  it("disconnects and clears rooms", async () => {
    const agents = new NoLagAgents("test-token");
    await agents.connect();
    agents.disconnect();

    expect(mockClient.disconnect).toHaveBeenCalled();
    expect(agents.rooms.size).toBe(0);
    expect(agents.connected).toBe(false);
  });

  it("throws when accessing room before connecting", () => {
    const agents = new NoLagAgents("test-token");
    expect(() => agents.room("test")).toThrow("Not connected");
  });

  it("uses default options when none provided", async () => {
    mockClient.setApp.mockReturnValue(mockAppContext);
    const agents = new NoLagAgents("test-token");
    await agents.connect();

    expect(mockClient.setApp).toHaveBeenCalledWith("agents");
    expect(mockAppContext.setRoom).toHaveBeenCalledWith("default-workflow");
  });

  it("room() returns same instance for same name", async () => {
    const agents = new NoLagAgents("test-token");
    await agents.connect();

    const first = agents.room("test-room");
    const second = agents.room("test-room");
    expect(first).toBe(second);
  });

  it("multiple rooms can be created", async () => {
    const agents = new NoLagAgents("test-token");
    await agents.connect();

    agents.room("a");
    agents.room("b");

    expect(agents.rooms.size).toBe(3);
  });

  it("wires client events on connect", async () => {
    const agents = new NoLagAgents("test-token");
    await agents.connect();

    const registeredEvents = mockClient.on.mock.calls.map(
      (call: [string, ...unknown[]]) => call[0]
    );
    expect(registeredEvents).toContain("connected");
    expect(registeredEvents).toContain("disconnected");
    expect(registeredEvents).toContain("reconnected");
    expect(registeredEvents).toContain("error");
  });

  it("calls NoLag constructor with the token", async () => {
    const { NoLag } = await import("@nolag/js-sdk");
    const agents = new NoLagAgents("my-special-token");
    await agents.connect();

    expect(NoLag).toHaveBeenCalledWith(
      "my-special-token",
      expect.any(Object)
    );
  });
});
