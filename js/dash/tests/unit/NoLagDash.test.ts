import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockClient = { connected: false, actorId: 'test-actor', connect: vi.fn(), disconnect: vi.fn(), on: vi.fn(), off: vi.fn(), setApp: vi.fn() };
const mockRoomContext = { subscribe: vi.fn(), unsubscribe: vi.fn(), emit: vi.fn(), on: vi.fn().mockReturnThis(), off: vi.fn().mockReturnThis(), setPresence: vi.fn(), fetchPresence: vi.fn(() => Promise.resolve([])) };
const mockLobbyContext = { subscribe: vi.fn(() => Promise.resolve({})), unsubscribe: vi.fn(), fetchPresence: vi.fn(() => Promise.resolve({})), on: vi.fn().mockReturnThis() };
const mockAppContext = { setRoom: vi.fn(() => mockRoomContext), setLobby: vi.fn(() => mockLobbyContext) };
mockClient.setApp.mockReturnValue(mockAppContext);

vi.mock('@nolag/js-sdk', () => ({ NoLag: vi.fn(() => { mockClient.connected = false; mockClient.connect.mockImplementation(async () => { mockClient.connected = true; }); return mockClient; }) }));

import { NoLagDash } from '../../src/NoLagDash';

describe('NoLagDash', () => {
  beforeEach(() => { vi.clearAllMocks(); mockClient.connected = false; mockClient.connect.mockImplementation(async () => { mockClient.connected = true; }); });

  it('should connect', async () => {
    const dash = new NoLagDash('token');
    await dash.connect();
    expect(dash.connected).toBe(true);
  });

  it('should join/leave panels', async () => {
    const dash = new NoLagDash('token');
    await dash.connect();
    const panel = dash.joinPanel('overview');
    expect(panel.name).toBe('overview');
    dash.leavePanel('overview');
    expect(dash.panels.size).toBe(0);
  });

  it('should disconnect', async () => {
    const dash = new NoLagDash('token');
    await dash.connect();
    dash.disconnect();
    expect(mockClient.disconnect).toHaveBeenCalled();
  });
});
