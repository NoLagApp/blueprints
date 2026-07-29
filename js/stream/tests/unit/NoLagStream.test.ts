import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NoLagStream } from '../../src/NoLagStream';
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
    presence: { viewerId, username, role: 'viewer', ...(scope ? { __scope: scope } : {}) },
  };
}

function makeStream(client: FakeNoLagClient, opts: Record<string, unknown> = {}) {
  return new NoLagStream({
    client: client as never,
    username: 'Alice',
    appName: 'stream-app',
    ...opts,
  });
}

describe('NoLagStream (client injection)', () => {
  let client: FakeNoLagClient;

  beforeEach(() => {
    client = makeFakeClient();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('throws without an injected client', () => {
    expect(() => new NoLagStream({ username: 'Alice' } as never)).toThrow(TypeError);
  });

  it('sets up after the client connects and resolves ready()', async () => {
    const stream = makeStream(client);
    const connected = vi.fn();
    stream.on('connected', connected);

    expect(stream.localViewer).toBeNull();

    client.fireConnect('actor-1');
    await flushMicrotasks();

    await stream.ready();
    expect(connected).toHaveBeenCalledTimes(1);
    expect(stream.localViewer?.actorTokenId).toBe('actor-1');
    stream.detach();
  });

  it('attach-to-connected: runs setup via microtask when the client is already live', async () => {
    client.fireConnect('actor-early');
    const stream = makeStream(client);
    const connected = vi.fn();
    stream.on('connected', connected); // wired synchronously, before the microtask

    await flushMicrotasks();
    await stream.ready();

    expect(connected).toHaveBeenCalledTimes(1);
    expect(stream.localViewer?.actorTokenId).toBe('actor-early');
    stream.detach();
  });

  it('runs setup once per epoch: reconnects emit reconnected, not connected', async () => {
    const stream = makeStream(client);
    const connected = vi.fn();
    const reconnected = vi.fn();
    stream.on('connected', connected);
    stream.on('reconnected', reconnected);

    client.fireConnect();
    await flushMicrotasks();
    client.fireConnect(); // reconnect: core fires 'connect' again
    await flushMicrotasks();

    expect(connected).toHaveBeenCalledTimes(1);
    expect(reconnected).toHaveBeenCalledTimes(1);
    stream.detach();
  });

  it('emits reconnecting on the client reconnect event', async () => {
    const stream = makeStream(client);
    const reconnecting = vi.fn();
    stream.on('reconnecting', reconnecting);

    client.fireConnect();
    await flushMicrotasks();
    client.fireReconnect();

    expect(reconnecting).toHaveBeenCalledTimes(1);
    stream.detach();
  });

  it('diff-hydrates online viewers across reconnects', async () => {
    client.lobbySnapshot = {
      room1: { actorA: snapshotViewer('viewer-a', 'Ann'), actorB: snapshotViewer('viewer-b', 'Ben') },
    };
    const stream = makeStream(client);
    const online = vi.fn();
    const offline = vi.fn();
    stream.on('viewerOnline', online);
    stream.on('viewerOffline', offline);

    client.fireConnect();
    await flushMicrotasks();
    expect(online).toHaveBeenCalledTimes(2);
    expect(stream.getOnlineViewers().map((v) => v.viewerId).sort()).toEqual(['viewer-a', 'viewer-b']);
    // viewerCount includes the local viewer
    expect(stream.viewerCount).toBe(3);

    // Reconnect with Ann gone and Cid new: exactly one offline + one online
    client.lobbySnapshot = {
      room1: { actorB: snapshotViewer('viewer-b', 'Ben'), actorC: snapshotViewer('viewer-c', 'Cid') },
    };
    client.fireConnect();
    await flushMicrotasks();

    expect(offline).toHaveBeenCalledTimes(1);
    expect(offline.mock.calls[0][0].viewerId).toBe('viewer-a');
    expect(online).toHaveBeenCalledTimes(3);
    expect(stream.getOnlineViewers().map((v) => v.viewerId).sort()).toEqual(['viewer-b', 'viewer-c']);
    stream.detach();
  });

  it('LEAK TEST: detaching one wrapper leaves a co-attached wrapper fully intact', async () => {
    const streamA = makeStream(client, { appName: 'app-a' });
    const streamB = makeStream(client, { appName: 'app-b' });

    client.fireConnect();
    await flushMicrotasks();
    await streamA.ready();
    await streamB.ready();

    streamA.joinStream('live-1');
    streamB.joinStream('live-1');

    const bTopicHandlers = client.handlerCount('app-b/live-1/comments');
    const bConnectHandlersBefore = client.handlerCount('connect');
    expect(bTopicHandlers).toBeGreaterThan(0);

    streamA.detach();

    // B's topic handlers and lifecycle handlers are untouched
    expect(client.handlerCount('app-b/live-1/comments')).toBe(bTopicHandlers);
    expect(client.handlerCount('connect')).toBe(bConnectHandlersBefore - 1);
    // A's topic handlers and subscriptions are gone
    expect(client.handlerCount('app-a/live-1/comments')).toBe(0);
    expect(client.isSubscribed('app-a/live-1/comments')).toBe(false);
    expect(client.isSubscribed('app-b/live-1/comments')).toBe(true);

    // B still receives comments
    const room = streamB.rooms.get('live-1')!;
    const onComment = vi.fn();
    room.on('comment', onComment);
    client.fireMessage('app-b/live-1/comments', {
      id: 'c1', viewerId: 'viewer-x', username: 'X', text: 'hi', timestamp: Date.now(),
    }, {});
    expect(onComment).toHaveBeenCalledTimes(1);
    streamB.detach();
  });

  it('detach while disconnected skips server unsubscribes and removes handlers', async () => {
    const stream = makeStream(client);
    client.fireConnect();
    await flushMicrotasks();
    stream.joinStream('live-1');

    client.fireDisconnect();
    client.sent = [];
    stream.detach();

    expect(client.sent.filter((s) => s.op === 'unsubscribe')).toEqual([]);
    expect(client.sent.filter((s) => s.op === 'lobbyUnsubscribe')).toEqual([]);
    expect(client.handledEvents()).toEqual([]);
  });

  it('double detach is a no-op and public methods throw after detach', async () => {
    const stream = makeStream(client);
    client.fireConnect();
    await flushMicrotasks();

    stream.detach();
    expect(() => stream.detach()).not.toThrow();
    expect(() => stream.joinStream('x')).toThrow(/detached/);
  });

  it('ready() rejects when detached before ready and joinStream guards pre-ready', async () => {
    const stream = makeStream(client);
    expect(() => stream.joinStream('x')).toThrow(/not ready/);

    const readyPromise = stream.ready();
    stream.detach();
    await expect(readyPromise).rejects.toThrow(/detached before ready/);
  });

  it('filters presence tagged with another app scope, accepts own and untagged', async () => {
    const stream = makeStream(client);
    const online = vi.fn();
    stream.on('viewerOnline', online);
    client.fireConnect();
    await flushMicrotasks();

    client.fireLobby('join', { actorId: 'actor-own', data: { viewerId: 'v1', username: 'Own', role: 'viewer', __scope: 'stream-app' } });
    client.fireLobby('join', { actorId: 'actor-foreign', data: { viewerId: 'v2', username: 'Foreign', role: 'viewer', __scope: 'other-app' } });
    client.fireLobby('join', { actorId: 'actor-untagged', data: { viewerId: 'v3', username: 'Legacy', role: 'viewer' } });

    expect(online).toHaveBeenCalledTimes(2);
    expect(stream.getOnlineViewers().map((v) => v.viewerId).sort()).toEqual(['v1', 'v3']);
    stream.detach();
  });

  it('runs the deferred lobby refresh and cancels it on detach', async () => {
    vi.useFakeTimers();
    const stream = makeStream(client);
    client.fireConnect();
    await flushMicrotasks();

    client.sent = [];
    await vi.advanceTimersByTimeAsync(2000);
    expect(client.sent.some((s) => s.op === 'lobbyFetchPresence')).toBe(true);

    // A new wrapper's pending refresh dies with detach
    const stream2 = makeStream(client, { appName: 'stream-app-2' });
    client.fireConnect();
    await flushMicrotasks();
    client.sent = [];
    stream2.detach();
    await vi.advanceTimersByTimeAsync(5000);
    expect(client.sent.filter((s) => s.op === 'lobbyFetchPresence' && s.topic?.startsWith('stream-app-2'))).toEqual([]);

    stream.detach();
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

    const stream = makeStream(client);
    const connected = vi.fn();
    stream.on('connected', connected);

    client.fireConnect(); // epoch 1: hangs in lobby subscribe
    await flushMicrotasks();
    client.fireConnect(); // epoch 2: completes normally
    await flushMicrotasks();
    resolveFirst!({}); // epoch 1 resumes, must abort silently
    await flushMicrotasks();

    // Ready resolved exactly once, via epoch 2
    await stream.ready();
    expect(connected).toHaveBeenCalledTimes(1);
    stream.detach();
  });

  // ============ Domain behavior (adapted to injection lifecycle) ============

  it('joins and leaves streams; comments fan out to the joined stream', async () => {
    const stream = makeStream(client);
    client.fireConnect();
    await flushMicrotasks();
    await stream.ready();

    const room = stream.joinStream('main');
    expect(room.name).toBe('main');

    const comment = vi.fn();
    room.on('comment', comment);
    client.fireMessage('stream-app/main/comments', {
      id: 'c1', viewerId: 'viewer-x', username: 'X', text: 'first!', timestamp: Date.now(),
    }, {});
    expect(comment).toHaveBeenCalledTimes(1);
    expect(room.comments.map((c) => c.id)).toContain('c1');

    stream.leaveStream('main');
    expect(stream.rooms.size).toBe(0);
    stream.detach();
  });

  it('routes reactions and polls to the joined stream', async () => {
    const stream = makeStream(client);
    client.fireConnect();
    await flushMicrotasks();
    await stream.ready();

    const room = stream.joinStream('main');

    const reaction = vi.fn();
    const pollCreated = vi.fn();
    room.on('reaction', reaction);
    room.on('pollCreated', pollCreated);

    client.fireMessage('stream-app/main/_reactions', { emoji: '🔥' }, {});
    client.fireMessage('stream-app/main/polls', {
      id: 'poll-1', question: 'Q?', options: [{ text: 'A', votes: 0 }, { text: 'B', votes: 0 }],
      createdBy: 'viewer-y', closed: false, totalVotes: 0, timestamp: Date.now(),
    }, {});

    expect(pollCreated).toHaveBeenCalledTimes(1);
    stream.detach();
  });

  it('tags stream presence with the app scope on join', async () => {
    const stream = makeStream(client);
    client.fireConnect();
    await flushMicrotasks();
    await stream.ready();

    client.sent = [];
    stream.joinStream('main');
    const presenceWrite = client.sent.find((s) => s.op === 'setPresence');
    expect(presenceWrite).toBeDefined();
    expect((presenceWrite!.data as Record<string, unknown>).__scope).toBe('stream-app');
    stream.detach();
  });
});
