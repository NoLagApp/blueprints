import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NoLagTrack } from '../../src/NoLagTrack';
import { makeFakeClient, FakeNoLagClient } from '../helpers/fakeNoLagClient';

/**
 * Contract tests for the client-injection lifecycle (the canonical set —
 * every wrapper SDK carries equivalents):
 * 1. attach-to-connected microtask setup
 * 2. once-per-epoch setup (connect vs reconnect)
 * 3. reconnect diff-hydration
 * 4. the leak test: detaching one wrapper leaves a co-attached wrapper intact
 * 5. detach-while-disconnected / double-detach
 * 6. ready() semantics
 * plus track domain: multi-zone presence routing, persistent presence.
 */

const flushMicrotasks = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

function snapshotAsset(assetId: string, assetName: string, scope?: string) {
  return {
    presence: { assetId, assetName, ...(scope ? { __scope: scope } : {}) },
  };
}

function makeTrack(client: FakeNoLagClient, opts: Record<string, unknown> = {}) {
  return new NoLagTrack({
    client: client as never,
    assetName: 'Truck-01',
    appName: 'track-app',
    ...opts,
  });
}

describe('NoLagTrack (client injection)', () => {
  let client: FakeNoLagClient;

  beforeEach(() => {
    client = makeFakeClient();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('throws without an injected client', () => {
    expect(() => new NoLagTrack({ assetName: 'Truck-01' } as never)).toThrow(TypeError);
  });

  it('sets up after the client connects and resolves ready()', async () => {
    const track = makeTrack(client);
    const connected = vi.fn();
    track.on('connected', connected);

    expect(track.localAsset).toBeNull();

    client.fireConnect('actor-1');
    await flushMicrotasks();

    await track.ready();
    expect(connected).toHaveBeenCalledTimes(1);
    expect(track.localAsset?.actorTokenId).toBe('actor-1');
    track.detach();
  });

  it('attach-to-connected: runs setup via microtask when the client is already live', async () => {
    client.fireConnect('actor-early');
    const track = makeTrack(client);
    const connected = vi.fn();
    track.on('connected', connected); // wired synchronously, before the microtask

    await flushMicrotasks();
    await track.ready();

    expect(connected).toHaveBeenCalledTimes(1);
    expect(track.localAsset?.actorTokenId).toBe('actor-early');
    track.detach();
  });

  it('runs setup once per epoch: reconnects emit reconnected, not connected', async () => {
    const track = makeTrack(client);
    const connected = vi.fn();
    const reconnected = vi.fn();
    track.on('connected', connected);
    track.on('reconnected', reconnected);

    client.fireConnect();
    await flushMicrotasks();
    client.fireConnect(); // reconnect: core fires 'connect' again
    await flushMicrotasks();

    expect(connected).toHaveBeenCalledTimes(1);
    expect(reconnected).toHaveBeenCalledTimes(1);
    track.detach();
  });

  it('emits reconnecting when the core fires its reconnect event', async () => {
    const track = makeTrack(client);
    const reconnecting = vi.fn();
    track.on('reconnecting', reconnecting);

    client.fireConnect();
    await flushMicrotasks();
    client.fireReconnect();

    expect(reconnecting).toHaveBeenCalledTimes(1);
    track.detach();
  });

  it('diff-hydrates online assets across reconnects', async () => {
    client.lobbySnapshot = {
      zone1: { actorA: snapshotAsset('asset-a', 'Ann'), actorB: snapshotAsset('asset-b', 'Ben') },
    };
    const track = makeTrack(client);
    const online = vi.fn();
    const offline = vi.fn();
    track.on('assetOnline', online);
    track.on('assetOffline', offline);

    client.fireConnect();
    await flushMicrotasks();
    expect(online).toHaveBeenCalledTimes(2);
    expect(track.getOnlineAssets().map((a) => a.assetId).sort()).toEqual(['asset-a', 'asset-b']);

    // Reconnect with Ann gone and Cid new: exactly one offline + one online
    client.lobbySnapshot = {
      zone1: { actorB: snapshotAsset('asset-b', 'Ben'), actorC: snapshotAsset('asset-c', 'Cid') },
    };
    client.fireConnect();
    await flushMicrotasks();

    expect(offline).toHaveBeenCalledTimes(1);
    expect(offline.mock.calls[0][0].assetId).toBe('asset-a');
    expect(online).toHaveBeenCalledTimes(3);
    expect(track.getOnlineAssets().map((a) => a.assetId).sort()).toEqual(['asset-b', 'asset-c']);
    track.detach();
  });

  it('re-applies zone presence on reconnect (persistent presence)', async () => {
    const track = makeTrack(client);
    client.fireConnect();
    await flushMicrotasks();
    track.joinZone('fleet');

    const presenceBefore = client.sent.filter((s) => s.op === 'setPresence').length;
    expect(presenceBefore).toBeGreaterThan(0);

    client.fireConnect(); // reconnect
    await flushMicrotasks();

    // Presence was re-set for the joined zone on the new epoch
    expect(client.sent.filter((s) => s.op === 'setPresence').length).toBeGreaterThan(presenceBefore);
    track.detach();
  });

  it('LEAK TEST: detaching one wrapper leaves a co-attached wrapper fully intact', async () => {
    const trackA = makeTrack(client, { appName: 'app-a' });
    const trackB = makeTrack(client, { appName: 'app-b' });

    client.fireConnect();
    await flushMicrotasks();
    await trackA.ready();
    await trackB.ready();

    trackA.joinZone('fleet');
    trackB.joinZone('fleet');

    const bTopicHandlers = client.handlerCount('app-b/fleet/locations');
    const bConnectHandlersBefore = client.handlerCount('connect');
    expect(bTopicHandlers).toBeGreaterThan(0);

    trackA.detach();

    // B's topic handlers and lifecycle handlers are untouched
    expect(client.handlerCount('app-b/fleet/locations')).toBe(bTopicHandlers);
    expect(client.handlerCount('connect')).toBe(bConnectHandlersBefore - 1);
    // A's topic handlers and subscriptions are gone
    expect(client.handlerCount('app-a/fleet/locations')).toBe(0);
    expect(client.isSubscribed('app-a/fleet/locations')).toBe(false);
    expect(client.isSubscribed('app-b/fleet/locations')).toBe(true);

    // B still receives location updates
    const zone = trackB.zones.get('fleet')!;
    const onUpdate = vi.fn();
    zone.on('locationUpdate', onUpdate);
    client.fireMessage('app-b/fleet/locations', {
      id: 'loc1', assetId: 'asset-x', point: { lat: 1, lng: 2 }, timestamp: Date.now(), isReplay: false,
    }, {});
    expect(onUpdate).toHaveBeenCalledTimes(1);
    trackB.detach();
  });

  it('detach while disconnected skips server unsubscribes and removes handlers', async () => {
    const track = makeTrack(client);
    client.fireConnect();
    await flushMicrotasks();
    track.joinZone('fleet');

    client.fireDisconnect();
    client.sent = [];
    track.detach();

    expect(client.sent.filter((s) => s.op === 'unsubscribe')).toEqual([]);
    expect(client.sent.filter((s) => s.op === 'lobbyUnsubscribe')).toEqual([]);
    expect(client.handledEvents()).toEqual([]);
  });

  it('double detach is a no-op and public methods throw after detach', async () => {
    const track = makeTrack(client);
    client.fireConnect();
    await flushMicrotasks();

    track.detach();
    expect(() => track.detach()).not.toThrow();
    expect(() => track.joinZone('x')).toThrow(/detached/);
  });

  it('ready() rejects when detached before ready and joinZone guards pre-ready', async () => {
    const track = makeTrack(client);
    expect(() => track.joinZone('x')).toThrow(/not ready/);

    const readyPromise = track.ready();
    track.detach();
    await expect(readyPromise).rejects.toThrow(/detached before ready/);
  });

  it('filters presence tagged with another app scope, accepts own and untagged', async () => {
    const track = makeTrack(client);
    const online = vi.fn();
    track.on('assetOnline', online);
    client.fireConnect();
    await flushMicrotasks();

    client.fireLobby('join', { actorId: 'actor-own', data: { assetId: 'a1', assetName: 'Own', __scope: 'track-app' } });
    client.fireLobby('join', { actorId: 'actor-foreign', data: { assetId: 'a2', assetName: 'Foreign', __scope: 'other-app' } });
    client.fireLobby('join', { actorId: 'actor-untagged', data: { assetId: 'a3', assetName: 'Legacy' } });

    expect(online).toHaveBeenCalledTimes(2);
    expect(track.getOnlineAssets().map((a) => a.assetId).sort()).toEqual(['a1', 'a3']);
    track.detach();
  });

  it('routes room presence to every joined zone (multi-zone)', async () => {
    const track = makeTrack(client);
    client.fireConnect();
    await flushMicrotasks();

    const zoneA = track.joinZone('zone-a');
    const zoneB = track.joinZone('zone-b');
    const joinA = vi.fn();
    const joinB = vi.fn();
    zoneA.on('assetJoined', joinA);
    zoneB.on('assetJoined', joinB);

    client.firePresence('join', {
      actorTokenId: 'actor-remote',
      presence: { assetId: 'remote-asset', assetName: 'Bus' },
    });

    expect(joinA).toHaveBeenCalledTimes(1);
    expect(joinB).toHaveBeenCalledTimes(1);
    track.detach();
  });

  it('runs the deferred lobby refresh and cancels it on detach', async () => {
    vi.useFakeTimers();
    const track = makeTrack(client);
    client.fireConnect();
    await flushMicrotasks();

    client.sent = [];
    await vi.advanceTimersByTimeAsync(2000);
    expect(client.sent.some((s) => s.op === 'lobbyFetchPresence')).toBe(true);

    // A new wrapper's pending refresh dies with detach
    const track2 = makeTrack(client, { appName: 'track-app-2' });
    client.fireConnect();
    await flushMicrotasks();
    client.sent = [];
    track2.detach();
    await vi.advanceTimersByTimeAsync(5000);
    expect(client.sent.filter((s) => s.op === 'lobbyFetchPresence' && s.topic?.startsWith('track-app-2'))).toEqual([]);

    track.detach();
  });

  it('stale setup aborts: a reconnect mid-setup wins', async () => {
    // Make the first lobby subscribe hang until after a second connect
    let resolveFirst: (v: Record<string, Record<string, unknown>>) => void;
    const origSetApp = client.setApp.bind(client);
    let call = 0;
    (client as { setApp: typeof client.setApp }).setApp = (appName: string) => {
      const ctx = origSetApp(appName);
      const origSetLobby = ctx.setLobby.bind(ctx);
      ctx.setLobby = (lobbyId: string) => {
        const lobby = origSetLobby(lobbyId);
        const origSubscribe = lobby.subscribe.bind(lobby);
        lobby.subscribe = () => {
          call++;
          if (call === 1) {
            return new Promise((resolve) => { resolveFirst = resolve; });
          }
          return origSubscribe();
        };
        return lobby;
      };
      return ctx;
    };

    const track = makeTrack(client);
    const connected = vi.fn();
    track.on('connected', connected);

    client.fireConnect(); // epoch 1: hangs in lobby subscribe
    await flushMicrotasks();
    client.fireConnect(); // epoch 2: completes normally
    await flushMicrotasks();
    resolveFirst!({}); // epoch 1 resumes, must abort silently
    await flushMicrotasks();

    // Ready resolved exactly once, via epoch 2
    await track.ready();
    expect(connected).toHaveBeenCalledTimes(1);
    track.detach();
  });

  it('auto-joins configured zoneNames on first setup', async () => {
    const track = makeTrack(client, { zoneNames: ['fleet', 'depot'] });
    client.fireConnect();
    await flushMicrotasks();
    await track.ready();

    expect(track.zones.size).toBe(2);
    expect(client.isSubscribed('track-app/fleet/locations')).toBe(true);
    expect(client.isSubscribed('track-app/depot/locations')).toBe(true);
    track.detach();
  });
});
