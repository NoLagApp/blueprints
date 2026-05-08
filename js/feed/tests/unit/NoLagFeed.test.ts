import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockClient = { connected: false, actorId: 'test-actor', connect: vi.fn(), disconnect: vi.fn(), on: vi.fn(), off: vi.fn(), setApp: vi.fn() };
const mockRoomContext = { subscribe: vi.fn(), unsubscribe: vi.fn(), emit: vi.fn(), on: vi.fn().mockReturnThis(), off: vi.fn().mockReturnThis(), setPresence: vi.fn(), fetchPresence: vi.fn(() => Promise.resolve([])) };
const mockLobbyContext = { subscribe: vi.fn(() => Promise.resolve({})), unsubscribe: vi.fn(), fetchPresence: vi.fn(() => Promise.resolve({})), on: vi.fn().mockReturnThis() };
const mockAppContext = { setRoom: vi.fn(() => mockRoomContext), setLobby: vi.fn(() => mockLobbyContext) };
mockClient.setApp.mockReturnValue(mockAppContext);

vi.mock('@nolag/js-sdk', () => ({ NoLag: vi.fn(() => { mockClient.connected = false; mockClient.connect.mockImplementation(async () => { mockClient.connected = true; }); return mockClient; }) }));

import { NoLagFeed } from '../../src/NoLagFeed';

describe('NoLagFeed', () => {
  beforeEach(() => { vi.clearAllMocks(); mockClient.connected = false; mockClient.connect.mockImplementation(async () => { mockClient.connected = true; }); });

  it('should connect', async () => {
    const feed = new NoLagFeed('token', { username: 'Alice' });
    await feed.connect();
    expect(feed.connected).toBe(true);
  });

  it('should join/leave channels', async () => {
    const feed = new NoLagFeed('token', { username: 'Alice' });
    await feed.connect();
    const ch = feed.joinChannel('main');
    expect(ch.name).toBe('main');
    feed.leaveChannel('main');
    expect(feed.channels.size).toBe(0);
  });

  it('should disconnect', async () => {
    const feed = new NoLagFeed('token', { username: 'Alice' });
    await feed.connect();
    feed.disconnect();
    expect(mockClient.disconnect).toHaveBeenCalled();
  });
});
