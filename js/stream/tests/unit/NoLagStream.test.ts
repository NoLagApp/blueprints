import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockClient = { connected: false, actorId: 'test-actor', connect: vi.fn(), disconnect: vi.fn(), on: vi.fn(), off: vi.fn(), setApp: vi.fn() };
const mockRoomContext = { subscribe: vi.fn(), unsubscribe: vi.fn(), emit: vi.fn(), on: vi.fn().mockReturnThis(), off: vi.fn().mockReturnThis(), setPresence: vi.fn(), fetchPresence: vi.fn(() => Promise.resolve([])) };
const mockLobbyContext = { subscribe: vi.fn(() => Promise.resolve({})), unsubscribe: vi.fn(), fetchPresence: vi.fn(() => Promise.resolve({})), on: vi.fn().mockReturnThis() };
const mockAppContext = { setRoom: vi.fn(() => mockRoomContext), setLobby: vi.fn(() => mockLobbyContext) };
mockClient.setApp.mockReturnValue(mockAppContext);

vi.mock('@nolag/js-sdk', () => ({ NoLag: vi.fn(() => { mockClient.connected = false; mockClient.connect.mockImplementation(async () => { mockClient.connected = true; }); return mockClient; }) }));

import { NoLagStream } from '../../src/NoLagStream';

describe('NoLagStream', () => {
  beforeEach(() => { vi.clearAllMocks(); mockClient.connected = false; mockClient.connect.mockImplementation(async () => { mockClient.connected = true; }); });

  it('should connect', async () => {
    const stream = new NoLagStream('token', { username: 'Host' });
    await stream.connect();
    expect(stream.connected).toBe(true);
    expect(stream.localViewer).not.toBeNull();
  });

  it('should join/leave streams', async () => {
    const stream = new NoLagStream('token', { username: 'Host' });
    await stream.connect();
    const room = stream.joinStream('live-1');
    expect(room.name).toBe('live-1');
    stream.leaveStream('live-1');
    expect(stream.rooms.size).toBe(0);
  });

  it('should disconnect', async () => {
    const stream = new NoLagStream('token', { username: 'Host' });
    await stream.connect();
    stream.disconnect();
    expect(mockClient.disconnect).toHaveBeenCalled();
  });
});
