import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockClient = {
  connected: false,
  actorId: 'test-actor-123',
  connect: vi.fn(),
  disconnect: vi.fn(),
  on: vi.fn(),
  off: vi.fn(),
  setApp: vi.fn(),
};

const mockRoomContext = {
  subscribe: vi.fn(),
  unsubscribe: vi.fn(),
  emit: vi.fn(),
  on: vi.fn().mockReturnThis(),
  off: vi.fn().mockReturnThis(),
  setPresence: vi.fn(),
  fetchPresence: vi.fn(() => Promise.resolve([])),
};

const mockLobbyContext = {
  subscribe: vi.fn(() => Promise.resolve({})),
  unsubscribe: vi.fn(),
  fetchPresence: vi.fn(() => Promise.resolve({})),
  setPresence: vi.fn(),
  on: vi.fn().mockReturnThis(),
};

const mockAppContext = {
  setRoom: vi.fn(() => mockRoomContext),
  setLobby: vi.fn(() => mockLobbyContext),
};

mockClient.setApp.mockReturnValue(mockAppContext);

vi.mock('@nolag/js-sdk', () => ({
  NoLag: vi.fn(() => {
    mockClient.connected = false;
    mockClient.connect.mockImplementation(async () => { mockClient.connected = true; });
    return mockClient;
  }),
}));

import { NoLagNotify } from '../../src/NoLagNotify';

describe('NoLagNotify', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockClient.connected = false;
    mockClient.connect.mockImplementation(async () => { mockClient.connected = true; });
    mockLobbyContext.subscribe.mockResolvedValue({});
  });

  it('should accept token and options', () => {
    const notify = new NoLagNotify('token');
    expect(notify.connected).toBe(false);
  });

  it('should connect and emit connected event', async () => {
    const notify = new NoLagNotify('token');
    const handler = vi.fn();
    notify.on('connected', handler);
    await notify.connect();
    expect(mockClient.connect).toHaveBeenCalled();
    expect(notify.connected).toBe(true);
    expect(handler).toHaveBeenCalled();
  });

  it('should subscribe to channels', async () => {
    const notify = new NoLagNotify('token');
    await notify.connect();
    const channel = notify.subscribe('alerts');
    expect(channel).toBeDefined();
    expect(channel.name).toBe('alerts');
  });

  it('should unsubscribe from channels', async () => {
    const notify = new NoLagNotify('token');
    await notify.connect();
    notify.subscribe('alerts');
    notify.unsubscribe('alerts');
    expect(notify.channels.size).toBe(0);
  });

  it('should return badge counts', async () => {
    const notify = new NoLagNotify('token');
    await notify.connect();
    const counts = notify.getBadgeCounts();
    expect(counts.total).toBe(0);
  });

  it('should disconnect and clean up', async () => {
    const notify = new NoLagNotify('token');
    await notify.connect();
    notify.subscribe('alerts');
    notify.disconnect();
    expect(notify.channels.size).toBe(0);
    expect(mockClient.disconnect).toHaveBeenCalled();
  });
});
