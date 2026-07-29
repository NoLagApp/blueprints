import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NoLagDash } from '../../src/NoLagDash';
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
 */

const flushMicrotasks = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

function snapshotViewer(viewerId: string, username: string, scope?: string) {
  return {
    presence: { viewerId, username, ...(scope ? { __scope: scope } : {}) },
  };
}

function makeDash(client: FakeNoLagClient, opts: Record<string, unknown> = {}) {
  return new NoLagDash({
    client: client as never,
    username: 'Alice',
    appName: 'dash-app',
    ...opts,
  });
}

describe('NoLagDash (client injection)', () => {
  let client: FakeNoLagClient;

  beforeEach(() => {
    client = makeFakeClient();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('throws without an injected client', () => {
    expect(() => new NoLagDash({ username: 'Alice' } as never)).toThrow(TypeError);
  });

  it('sets up after the client connects and resolves ready()', async () => {
    const dash = makeDash(client);
    const connected = vi.fn();
    dash.on('connected', connected);

    expect(dash.localViewer).toBeNull();

    client.fireConnect('actor-1');
    await flushMicrotasks();

    await dash.ready();
    expect(connected).toHaveBeenCalledTimes(1);
    expect(dash.localViewer?.actorTokenId).toBe('actor-1');
    dash.detach();
  });

  it('attach-to-connected: runs setup via microtask when the client is already live', async () => {
    client.fireConnect('actor-early');
    const dash = makeDash(client);
    const connected = vi.fn();
    dash.on('connected', connected); // wired synchronously, before the microtask

    await flushMicrotasks();
    await dash.ready();

    expect(connected).toHaveBeenCalledTimes(1);
    expect(dash.localViewer?.actorTokenId).toBe('actor-early');
    dash.detach();
  });

  it('runs setup once per epoch: reconnects emit reconnected, not connected', async () => {
    const dash = makeDash(client);
    const connected = vi.fn();
    const reconnected = vi.fn();
    dash.on('connected', connected);
    dash.on('reconnected', reconnected);

    client.fireConnect();
    await flushMicrotasks();
    client.fireConnect(); // reconnect: core fires 'connect' again
    await flushMicrotasks();

    expect(connected).toHaveBeenCalledTimes(1);
    expect(reconnected).toHaveBeenCalledTimes(1);
    dash.detach();
  });

  it('diff-hydrates online viewers across reconnects', async () => {
    client.lobbySnapshot = {
      room1: { actorA: snapshotViewer('viewer-a', 'Ann'), actorB: snapshotViewer('viewer-b', 'Ben') },
    };
    const dash = makeDash(client);
    const online = vi.fn();
    const offline = vi.fn();
    dash.on('viewerOnline', online);
    dash.on('viewerOffline', offline);

    client.fireConnect();
    await flushMicrotasks();
    expect(online).toHaveBeenCalledTimes(2);
    expect(dash.getOnlineViewers().map((v) => v.viewerId).sort()).toEqual(['viewer-a', 'viewer-b']);

    // Reconnect with Ann gone and Cid new: exactly one offline + one online
    client.lobbySnapshot = {
      room1: { actorB: snapshotViewer('viewer-b', 'Ben'), actorC: snapshotViewer('viewer-c', 'Cid') },
    };
    client.fireConnect();
    await flushMicrotasks();

    expect(offline).toHaveBeenCalledTimes(1);
    expect(offline.mock.calls[0][0].viewerId).toBe('viewer-a');
    expect(online).toHaveBeenCalledTimes(3);
    expect(dash.getOnlineViewers().map((v) => v.viewerId).sort()).toEqual(['viewer-b', 'viewer-c']);
    dash.detach();
  });

  it('LEAK TEST: detaching one wrapper leaves a co-attached wrapper fully intact', async () => {
    const dashA = makeDash(client, { appName: 'app-a' });
    const dashB = makeDash(client, { appName: 'app-b' });

    client.fireConnect();
    await flushMicrotasks();
    await dashA.ready();
    await dashB.ready();

    dashA.joinPanel('overview');
    dashB.joinPanel('overview');

    const bTopicHandlers = client.handlerCount('app-b/overview/metrics');
    const bConnectHandlersBefore = client.handlerCount('connect');
    expect(bTopicHandlers).toBeGreaterThan(0);

    dashA.detach();

    // B's topic handlers and lifecycle handlers are untouched
    expect(client.handlerCount('app-b/overview/metrics')).toBe(bTopicHandlers);
    expect(client.handlerCount('connect')).toBe(bConnectHandlersBefore - 1);
    // A's topic handlers and subscriptions are gone
    expect(client.handlerCount('app-a/overview/metrics')).toBe(0);
    expect(client.isSubscribed('app-a/overview/metrics')).toBe(false);
    expect(client.isSubscribed('app-b/overview/metrics')).toBe(true);

    // B still receives metrics
    const panel = dashB.panels.get('overview')!;
    const onMetric = vi.fn();
    panel.on('metric', onMetric);
    client.fireMessage('app-b/overview/metrics', {
      id: 'm1', streamId: 'cpu', value: 80, timestamp: Date.now(),
    }, { isReplay: false });
    expect(onMetric).toHaveBeenCalledTimes(1);
    dashB.detach();
  });

  it('detach while disconnected skips server unsubscribes and removes handlers', async () => {
    const dash = makeDash(client);
    client.fireConnect();
    await flushMicrotasks();
    dash.joinPanel('overview');

    client.fireDisconnect();
    client.sent = [];
    dash.detach();

    expect(client.sent.filter((s) => s.op === 'unsubscribe')).toEqual([]);
    expect(client.sent.filter((s) => s.op === 'lobbyUnsubscribe')).toEqual([]);
    expect(client.handledEvents()).toEqual([]);
  });

  it('double detach is a no-op and public methods throw after detach', async () => {
    const dash = makeDash(client);
    client.fireConnect();
    await flushMicrotasks();

    dash.detach();
    expect(() => dash.detach()).not.toThrow();
    expect(() => dash.joinPanel('x')).toThrow(/detached/);
  });

  it('ready() rejects when detached before ready and joinPanel guards pre-ready', async () => {
    const dash = makeDash(client);
    expect(() => dash.joinPanel('x')).toThrow(/not ready/);

    const readyPromise = dash.ready();
    dash.detach();
    await expect(readyPromise).rejects.toThrow(/detached before ready/);
  });

  it('filters presence tagged with another app scope, accepts own and untagged', async () => {
    const dash = makeDash(client);
    const online = vi.fn();
    dash.on('viewerOnline', online);
    client.fireConnect();
    await flushMicrotasks();

    client.fireLobby('join', { actorId: 'actor-own', data: { viewerId: 'v1', username: 'Own', __scope: 'dash-app' } });
    client.fireLobby('join', { actorId: 'actor-foreign', data: { viewerId: 'v2', username: 'Foreign', __scope: 'other-app' } });
    client.fireLobby('join', { actorId: 'actor-untagged', data: { viewerId: 'v3', username: 'Legacy' } });

    expect(online).toHaveBeenCalledTimes(2);
    expect(dash.getOnlineViewers().map((v) => v.viewerId).sort()).toEqual(['v1', 'v3']);
    dash.detach();
  });

  it('runs the deferred lobby refresh and cancels it on detach', async () => {
    vi.useFakeTimers();
    const dash = makeDash(client);
    client.fireConnect();
    await flushMicrotasks();

    client.sent = [];
    await vi.advanceTimersByTimeAsync(2000);
    expect(client.sent.some((s) => s.op === 'lobbyFetchPresence')).toBe(true);

    // A new wrapper's pending refresh dies with detach
    const dash2 = makeDash(client, { appName: 'dash-app-2' });
    client.fireConnect();
    await flushMicrotasks();
    client.sent = [];
    dash2.detach();
    await vi.advanceTimersByTimeAsync(5000);
    expect(client.sent.filter((s) => s.op === 'lobbyFetchPresence' && s.topic?.startsWith('dash-app-2'))).toEqual([]);

    dash.detach();
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

    const dash = makeDash(client);
    const connected = vi.fn();
    dash.on('connected', connected);

    client.fireConnect(); // epoch 1: hangs in lobby subscribe
    await flushMicrotasks();
    client.fireConnect(); // epoch 2: completes normally
    await flushMicrotasks();
    resolveFirst!({}); // epoch 1 resumes, must abort silently
    await flushMicrotasks();

    // Ready resolved exactly once, via epoch 2
    await dash.ready();
    expect(connected).toHaveBeenCalledTimes(1);
    dash.detach();
  });

  // ============ Domain tests (adapted onto injection) ============

  it('joins and leaves panels', async () => {
    const dash = makeDash(client);
    client.fireConnect();
    await flushMicrotasks();
    await dash.ready();

    const panel = dash.joinPanel('overview');
    expect(panel.name).toBe('overview');
    expect(dash.panels.size).toBe(1);
    expect(client.isSubscribed('dash-app/overview/metrics')).toBe(true);

    dash.leavePanel('overview');
    expect(dash.panels.size).toBe(0);
    dash.detach();
  });

  it('publishes and receives metrics on a panel', async () => {
    const dash = makeDash(client);
    client.fireConnect();
    await flushMicrotasks();
    await dash.ready();

    const panel = dash.joinPanel('overview');
    const point = panel.publishMetric('cpu', 75, { unit: '%' });
    expect(point.value).toBe(75);
    expect(client.sent.some((s) => s.op === 'emit' && s.topic === 'dash-app/overview/metrics')).toBe(true);

    const onMetric = vi.fn();
    panel.on('metric', onMetric);
    client.fireMessage('dash-app/overview/metrics', {
      id: 'm-remote', streamId: 'mem', value: 42, timestamp: Date.now(),
    }, { isReplay: false });
    expect(onMetric).toHaveBeenCalledTimes(1);

    const agg = panel.getAggregation('cpu');
    expect(agg.last).toBe(75);
    dash.detach();
  });

  it('routes replay events to all panels', async () => {
    const dash = makeDash(client);
    client.fireConnect();
    await flushMicrotasks();
    await dash.ready();

    const panel = dash.joinPanel('overview');
    const start = vi.fn();
    const end = vi.fn();
    panel.on('replayStart', start);
    panel.on('replayEnd', end);

    client.fireReplay('start', { count: 3 });
    client.fireReplay('end', { replayed: 3 });

    expect(start).toHaveBeenCalledWith({ count: 3 });
    expect(end).toHaveBeenCalledWith({ replayed: 3 });
    dash.detach();
  });

  it('pre-subscribes configured panels on first setup', async () => {
    const dash = makeDash(client, { panels: ['overview', 'infra'] });
    client.fireConnect();
    await flushMicrotasks();
    await dash.ready();

    expect(dash.panels.size).toBe(2);
    expect(client.isSubscribed('dash-app/overview/metrics')).toBe(true);
    expect(client.isSubscribed('dash-app/infra/metrics')).toBe(true);
    dash.detach();
  });

  it('joinPanel with metricFilters subscribes with filters (no wildcard on empty)', async () => {
    const dash = makeDash(client);
    client.fireConnect();
    await flushMicrotasks();
    await dash.ready();

    dash.joinPanel('overview', { metricFilters: ['region:us'] });
    const sub = client.sent.find((s) => s.op === 'subscribe' && s.topic === 'dash-app/overview/metrics');
    expect(sub).toBeTruthy();
    dash.detach();
  });
});
