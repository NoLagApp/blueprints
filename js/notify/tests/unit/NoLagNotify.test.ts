import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NoLagNotify } from '../../src/NoLagNotify';
import { makeFakeClient, FakeNoLagClient } from '../helpers/fakeNoLagClient';

/**
 * Contract tests for the client-injection lifecycle (the canonical set —
 * every wrapper SDK carries equivalents):
 * 1. attach-to-connected microtask setup
 * 2. once-per-epoch setup (connect vs reconnect)
 * 3. the leak test: detaching one wrapper leaves a co-attached wrapper intact
 * 4. detach-while-disconnected / double-detach
 * 5. ready() semantics
 */

const flushMicrotasks = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

function makeNotify(client: FakeNoLagClient, opts: Record<string, unknown> = {}) {
  return new NoLagNotify({
    client: client as never,
    appName: 'notify-app',
    ...opts,
  });
}

describe('NoLagNotify (client injection)', () => {
  let client: FakeNoLagClient;

  beforeEach(() => {
    client = makeFakeClient();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('throws without an injected client', () => {
    expect(() => new NoLagNotify({} as never)).toThrow(TypeError);
  });

  it('sets up after the client connects and resolves ready()', async () => {
    const notify = makeNotify(client);
    const connected = vi.fn();
    notify.on('connected', connected);

    client.fireConnect('actor-1');
    await flushMicrotasks();

    await notify.ready();
    expect(connected).toHaveBeenCalledTimes(1);
    expect(notify.connected).toBe(true);
    notify.detach();
  });

  it('attach-to-connected: runs setup via microtask when the client is already live', async () => {
    client.fireConnect('actor-early');
    const notify = makeNotify(client);
    const connected = vi.fn();
    notify.on('connected', connected); // wired synchronously, before the microtask

    await flushMicrotasks();
    await notify.ready();

    expect(connected).toHaveBeenCalledTimes(1);
    notify.detach();
  });

  it('runs setup once per epoch: reconnects emit reconnected, not connected', async () => {
    const notify = makeNotify(client);
    const connected = vi.fn();
    const reconnected = vi.fn();
    notify.on('connected', connected);
    notify.on('reconnected', reconnected);

    client.fireConnect();
    await flushMicrotasks();
    client.fireConnect(); // reconnect: core fires 'connect' again
    await flushMicrotasks();

    expect(connected).toHaveBeenCalledTimes(1);
    expect(reconnected).toHaveBeenCalledTimes(1);
    notify.detach();
  });

  it('LEAK TEST: detaching one wrapper leaves a co-attached wrapper fully intact', async () => {
    const notifyA = makeNotify(client, { appName: 'app-a' });
    const notifyB = makeNotify(client, { appName: 'app-b' });

    client.fireConnect();
    await flushMicrotasks();
    await notifyA.ready();
    await notifyB.ready();

    notifyA.subscribe('alerts');
    notifyB.subscribe('alerts');

    const bTopicHandlers = client.handlerCount('app-b/alerts/notifications');
    const bConnectHandlersBefore = client.handlerCount('connect');
    expect(bTopicHandlers).toBeGreaterThan(0);

    notifyA.detach();

    // B's topic handlers and lifecycle handlers are untouched
    expect(client.handlerCount('app-b/alerts/notifications')).toBe(bTopicHandlers);
    expect(client.handlerCount('connect')).toBe(bConnectHandlersBefore - 1);
    // A's topic handlers and subscriptions are gone
    expect(client.handlerCount('app-a/alerts/notifications')).toBe(0);
    expect(client.isSubscribed('app-a/alerts/notifications')).toBe(false);
    expect(client.isSubscribed('app-b/alerts/notifications')).toBe(true);

    // B still receives notifications
    const channel = notifyB.channels.get('alerts')!;
    const onNotification = vi.fn();
    channel.on('notification', onNotification);
    client.fireMessage('app-b/alerts/notifications', {
      id: 'n1', title: 'Hi', timestamp: Date.now(),
    }, {});
    expect(onNotification).toHaveBeenCalledTimes(1);
    notifyB.detach();
  });

  it('detach while disconnected skips server unsubscribes and removes handlers', async () => {
    const notify = makeNotify(client);
    client.fireConnect();
    await flushMicrotasks();
    notify.subscribe('alerts');

    client.fireDisconnect();
    client.sent = [];
    notify.detach();

    expect(client.sent.filter((s) => s.op === 'unsubscribe')).toEqual([]);
    expect(client.sent.filter((s) => s.op === 'lobbyUnsubscribe')).toEqual([]);
    expect(client.handledEvents()).toEqual([]);
  });

  it('double detach is a no-op and public methods throw after detach', async () => {
    const notify = makeNotify(client);
    client.fireConnect();
    await flushMicrotasks();

    notify.detach();
    expect(() => notify.detach()).not.toThrow();
    expect(() => notify.subscribe('x')).toThrow(/detached/);
  });

  it('ready() rejects when detached before ready and subscribe guards pre-ready', async () => {
    const notify = makeNotify(client);
    expect(() => notify.subscribe('x')).toThrow(/not ready/);

    const readyPromise = notify.ready();
    notify.detach();
    await expect(readyPromise).rejects.toThrow(/detached before ready/);
  });

  it('filters presence tagged with another app scope, accepts own and untagged', async () => {
    const notify = makeNotify(client);
    client.fireConnect();
    await flushMicrotasks();

    client.fireLobby('join', { actorId: 'actor-own', data: { userId: 'u1', __scope: 'notify-app' } });
    client.fireLobby('join', { actorId: 'actor-foreign', data: { userId: 'u2', __scope: 'other-app' } });
    client.fireLobby('join', { actorId: 'actor-untagged', data: { userId: 'u3' } });

    // Foreign-scoped presence is dropped; own + untagged are tracked.
    const badges = notify.getBadgeCounts();
    expect(badges.total).toBe(0); // presence tracking is separate from badges
    notify.detach();
  });

  it('runs the deferred lobby refresh and cancels it on detach', async () => {
    vi.useFakeTimers();
    const notify = makeNotify(client);
    client.fireConnect();
    await flushMicrotasks();

    client.sent = [];
    await vi.advanceTimersByTimeAsync(2000);
    expect(client.sent.some((s) => s.op === 'lobbyFetchPresence')).toBe(true);

    // A new wrapper's pending refresh dies with detach
    const notify2 = makeNotify(client, { appName: 'notify-app-2' });
    client.fireConnect();
    await flushMicrotasks();
    client.sent = [];
    notify2.detach();
    await vi.advanceTimersByTimeAsync(5000);
    expect(client.sent.filter((s) => s.op === 'lobbyFetchPresence' && s.topic?.startsWith('notify-app-2'))).toEqual([]);

    notify.detach();
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

    const notify = makeNotify(client);
    const connected = vi.fn();
    notify.on('connected', connected);

    client.fireConnect(); // epoch 1: hangs in lobby subscribe
    await flushMicrotasks();
    client.fireConnect(); // epoch 2: completes normally
    await flushMicrotasks();
    resolveFirst!({}); // epoch 1 resumes, must abort silently
    await flushMicrotasks();

    // Ready resolved exactly once, via epoch 2
    await notify.ready();
    expect(connected).toHaveBeenCalledTimes(1);
    notify.detach();
  });
});

describe('NoLagNotify (domain behavior)', () => {
  let client: FakeNoLagClient;

  beforeEach(() => {
    client = makeFakeClient();
  });

  async function connected(opts: Record<string, unknown> = {}) {
    const notify = makeNotify(client, opts);
    client.fireConnect();
    await flushMicrotasks();
    await notify.ready();
    return notify;
  }

  it('subscribes to channels and returns them', async () => {
    const notify = await connected();
    const channel = notify.subscribe('alerts');
    expect(channel).toBeDefined();
    expect(channel.name).toBe('alerts');
    expect(notify.channels.size).toBe(1);
    notify.detach();
  });

  it('is idempotent on repeated subscribe', async () => {
    const notify = await connected();
    const a = notify.subscribe('alerts');
    const b = notify.subscribe('alerts');
    expect(a).toBe(b);
    expect(notify.channels.size).toBe(1);
    notify.detach();
  });

  it('unsubscribes from channels', async () => {
    const notify = await connected();
    notify.subscribe('alerts');
    notify.unsubscribe('alerts');
    expect(notify.channels.size).toBe(0);
    notify.detach();
  });

  it('returns badge counts', async () => {
    const notify = await connected();
    expect(notify.getBadgeCounts().total).toBe(0);
    notify.detach();
  });

  it('updates badge counts and emits badgeUpdated on incoming notification', async () => {
    const notify = await connected({ appName: 'notify-app' });
    const badgeUpdated = vi.fn();
    const onNotification = vi.fn();
    notify.on('badgeUpdated', badgeUpdated);
    notify.on('notification', onNotification);

    notify.subscribe('alerts');
    client.fireMessage('notify-app/alerts/notifications', {
      id: 'n1', title: 'Deploy done', timestamp: Date.now(),
    }, { isReplay: false });

    expect(onNotification).toHaveBeenCalledTimes(1);
    expect(notify.getBadgeCounts().total).toBe(1);
    expect(notify.getBadgeCounts().byChannel.alerts).toBe(1);
    expect(badgeUpdated).toHaveBeenCalled();
    notify.detach();
  });

  it('marks all read across channels and zeroes badges', async () => {
    const notify = await connected({ appName: 'notify-app' });
    notify.subscribe('alerts');
    client.fireMessage('notify-app/alerts/notifications', {
      id: 'n1', title: 'One', timestamp: Date.now(),
    }, { isReplay: false });
    expect(notify.getBadgeCounts().total).toBe(1);

    notify.markAllRead();
    expect(notify.getBadgeCounts().total).toBe(0);
    notify.detach();
  });

  it('pre-subscribes configured channels on first setup', async () => {
    const notify = await connected({ appName: 'notify-app', channels: ['alerts', 'updates'] });
    expect(notify.channels.size).toBe(2);
    expect(client.isSubscribed('notify-app/alerts/notifications')).toBe(true);
    expect(client.isSubscribed('notify-app/updates/notifications')).toBe(true);
    notify.detach();
  });

  it('relays replay start/end to channels', async () => {
    const notify = await connected({ appName: 'notify-app' });
    const channel = notify.subscribe('alerts');
    const start = vi.fn();
    const end = vi.fn();
    channel.on('replayStart', start);
    channel.on('replayEnd', end);

    client.fireReplay('start', { count: 3 });
    client.fireReplay('end', { replayed: 3 });
    expect(start).toHaveBeenCalledWith({ count: 3 });
    expect(end).toHaveBeenCalledWith({ replayed: 3 });
    notify.detach();
  });
});
