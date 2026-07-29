import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NoLagFeed } from '../../src/NoLagFeed';
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

function snapshotUser(userId: string, username: string, scope?: string) {
  return {
    presence: { userId, username, ...(scope ? { __scope: scope } : {}) },
  };
}

function makeFeed(client: FakeNoLagClient, opts: Record<string, unknown> = {}) {
  return new NoLagFeed({
    client: client as never,
    username: 'Alice',
    appName: 'feed-app',
    ...opts,
  });
}

describe('NoLagFeed (client injection)', () => {
  let client: FakeNoLagClient;

  beforeEach(() => {
    client = makeFakeClient();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('throws without an injected client', () => {
    expect(() => new NoLagFeed({ username: 'Alice' } as never)).toThrow(TypeError);
  });

  it('sets up after the client connects and resolves ready()', async () => {
    const feed = makeFeed(client);
    const connected = vi.fn();
    feed.on('connected', connected);

    expect(feed.localUser).toBeNull();

    client.fireConnect('actor-1');
    await flushMicrotasks();

    await feed.ready();
    expect(connected).toHaveBeenCalledTimes(1);
    expect(feed.localUser?.actorTokenId).toBe('actor-1');
    feed.detach();
  });

  it('attach-to-connected: runs setup via microtask when the client is already live', async () => {
    client.fireConnect('actor-early');
    const feed = makeFeed(client);
    const connected = vi.fn();
    feed.on('connected', connected); // wired synchronously, before the microtask

    await flushMicrotasks();
    await feed.ready();

    expect(connected).toHaveBeenCalledTimes(1);
    expect(feed.localUser?.actorTokenId).toBe('actor-early');
    feed.detach();
  });

  it('runs setup once per epoch: reconnects emit reconnected, not connected', async () => {
    const feed = makeFeed(client);
    const connected = vi.fn();
    const reconnected = vi.fn();
    feed.on('connected', connected);
    feed.on('reconnected', reconnected);

    client.fireConnect();
    await flushMicrotasks();
    client.fireConnect(); // reconnect: core fires 'connect' again
    await flushMicrotasks();

    expect(connected).toHaveBeenCalledTimes(1);
    expect(reconnected).toHaveBeenCalledTimes(1);
    feed.detach();
  });

  it('emits reconnecting on the client reconnect event', async () => {
    const feed = makeFeed(client);
    const reconnecting = vi.fn();
    feed.on('reconnecting', reconnecting);

    client.fireConnect();
    await flushMicrotasks();
    client.fireReconnect();

    expect(reconnecting).toHaveBeenCalledTimes(1);
    feed.detach();
  });

  it('diff-hydrates online users across reconnects', async () => {
    client.lobbySnapshot = {
      channel1: { actorA: snapshotUser('user-a', 'Ann'), actorB: snapshotUser('user-b', 'Ben') },
    };
    const feed = makeFeed(client);
    const online = vi.fn();
    const offline = vi.fn();
    feed.on('userOnline', online);
    feed.on('userOffline', offline);

    client.fireConnect();
    await flushMicrotasks();
    expect(online).toHaveBeenCalledTimes(2);
    expect(feed.getOnlineUsers().map((u) => u.userId).sort()).toEqual(['user-a', 'user-b']);

    // Reconnect with Ann gone and Cid new: exactly one offline + one online
    client.lobbySnapshot = {
      channel1: { actorB: snapshotUser('user-b', 'Ben'), actorC: snapshotUser('user-c', 'Cid') },
    };
    client.fireConnect();
    await flushMicrotasks();

    expect(offline).toHaveBeenCalledTimes(1);
    expect(offline.mock.calls[0][0].userId).toBe('user-a');
    expect(online).toHaveBeenCalledTimes(3);
    expect(feed.getOnlineUsers().map((u) => u.userId).sort()).toEqual(['user-b', 'user-c']);
    feed.detach();
  });

  it('LEAK TEST: detaching one wrapper leaves a co-attached wrapper fully intact', async () => {
    const feedA = makeFeed(client, { appName: 'app-a' });
    const feedB = makeFeed(client, { appName: 'app-b' });

    client.fireConnect();
    await flushMicrotasks();
    await feedA.ready();
    await feedB.ready();

    feedA.joinChannel('general');
    feedB.joinChannel('general');

    const bTopicHandlers = client.handlerCount('app-b/general/posts');
    const bConnectHandlersBefore = client.handlerCount('connect');
    expect(bTopicHandlers).toBeGreaterThan(0);

    feedA.detach();

    // B's topic handlers and lifecycle handlers are untouched
    expect(client.handlerCount('app-b/general/posts')).toBe(bTopicHandlers);
    expect(client.handlerCount('connect')).toBe(bConnectHandlersBefore - 1);
    // A's topic handlers and subscriptions are gone
    expect(client.handlerCount('app-a/general/posts')).toBe(0);
    expect(client.isSubscribed('app-a/general/posts')).toBe(false);
    expect(client.isSubscribed('app-b/general/posts')).toBe(true);

    // B still receives posts
    const channel = feedB.channels.get('general')!;
    const onPost = vi.fn();
    channel.on('postCreated', onPost);
    client.fireMessage('app-b/general/posts', {
      id: 'p1', userId: 'user-x', username: 'X', content: 'hi', timestamp: Date.now(),
    }, {});
    expect(onPost).toHaveBeenCalledTimes(1);
    feedB.detach();
  });

  it('detach while disconnected skips server unsubscribes and removes handlers', async () => {
    const feed = makeFeed(client);
    client.fireConnect();
    await flushMicrotasks();
    feed.joinChannel('general');

    client.fireDisconnect();
    client.sent = [];
    feed.detach();

    expect(client.sent.filter((s) => s.op === 'unsubscribe')).toEqual([]);
    expect(client.sent.filter((s) => s.op === 'lobbyUnsubscribe')).toEqual([]);
    expect(client.handledEvents()).toEqual([]);
  });

  it('double detach is a no-op and public methods throw after detach', async () => {
    const feed = makeFeed(client);
    client.fireConnect();
    await flushMicrotasks();

    feed.detach();
    expect(() => feed.detach()).not.toThrow();
    expect(() => feed.joinChannel('x')).toThrow(/detached/);
  });

  it('ready() rejects when detached before ready and joinChannel guards pre-ready', async () => {
    const feed = makeFeed(client);
    expect(() => feed.joinChannel('x')).toThrow(/not ready/);

    const readyPromise = feed.ready();
    feed.detach();
    await expect(readyPromise).rejects.toThrow(/detached before ready/);
  });

  it('filters presence tagged with another app scope, accepts own and untagged', async () => {
    const feed = makeFeed(client);
    const online = vi.fn();
    feed.on('userOnline', online);
    client.fireConnect();
    await flushMicrotasks();

    client.fireLobby('join', { actorId: 'actor-own', data: { userId: 'u1', username: 'Own', __scope: 'feed-app' } });
    client.fireLobby('join', { actorId: 'actor-foreign', data: { userId: 'u2', username: 'Foreign', __scope: 'other-app' } });
    client.fireLobby('join', { actorId: 'actor-untagged', data: { userId: 'u3', username: 'Legacy' } });

    expect(online).toHaveBeenCalledTimes(2);
    expect(feed.getOnlineUsers().map((u) => u.userId).sort()).toEqual(['u1', 'u3']);
    feed.detach();
  });

  it('runs the deferred lobby refresh and cancels it on detach', async () => {
    vi.useFakeTimers();
    const feed = makeFeed(client);
    client.fireConnect();
    await flushMicrotasks();

    client.sent = [];
    await vi.advanceTimersByTimeAsync(2000);
    expect(client.sent.some((s) => s.op === 'lobbyFetchPresence')).toBe(true);

    // A new wrapper's pending refresh dies with detach
    const feed2 = makeFeed(client, { appName: 'feed-app-2' });
    client.fireConnect();
    await flushMicrotasks();
    client.sent = [];
    feed2.detach();
    await vi.advanceTimersByTimeAsync(5000);
    expect(client.sent.filter((s) => s.op === 'lobbyFetchPresence' && s.topic?.startsWith('feed-app-2'))).toEqual([]);

    feed.detach();
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

    const feed = makeFeed(client);
    const connected = vi.fn();
    feed.on('connected', connected);

    client.fireConnect(); // epoch 1: hangs in lobby subscribe
    await flushMicrotasks();
    client.fireConnect(); // epoch 2: completes normally
    await flushMicrotasks();
    resolveFirst!({}); // epoch 1 resumes, must abort silently
    await flushMicrotasks();

    // Ready resolved exactly once, via epoch 2
    await feed.ready();
    expect(connected).toHaveBeenCalledTimes(1);
    feed.detach();
  });

  // ============ Domain behavior (adapted to injection lifecycle) ============

  it('joins and leaves channels; posts fan out to the active channel', async () => {
    const feed = makeFeed(client);
    client.fireConnect();
    await flushMicrotasks();
    await feed.ready();

    const channel = feed.joinChannel('main');
    expect(channel.name).toBe('main');

    const created = vi.fn();
    channel.on('postCreated', created);
    client.fireMessage('feed-app/main/posts', {
      id: 'p1', userId: 'user-x', username: 'X', content: 'first!', timestamp: Date.now(),
    }, {});
    expect(created).toHaveBeenCalledTimes(1);
    expect(channel.posts.map((p) => p.id)).toContain('p1');

    feed.leaveChannel('main');
    expect(feed.channels.size).toBe(0);
    feed.detach();
  });

  it('routes reactions and comments to the active channel', async () => {
    const feed = makeFeed(client);
    client.fireConnect();
    await flushMicrotasks();
    await feed.ready();

    const channel = feed.joinChannel('main');
    channel.createPost({ content: 'react to me' });
    const post = channel.posts[0];

    const liked = vi.fn();
    const commented = vi.fn();
    channel.on('postLiked', liked);
    channel.on('commentAdded', commented);

    client.fireMessage('feed-app/main/reactions', {
      postId: post.id, userId: 'user-y', type: 'like', timestamp: Date.now(),
    }, {});
    client.fireMessage('feed-app/main/comments', {
      id: 'c1', postId: post.id, userId: 'user-y', username: 'Y', text: 'nice', timestamp: Date.now(),
    }, {});

    expect(liked).toHaveBeenCalledTimes(1);
    expect(commented).toHaveBeenCalledTimes(1);
    expect(channel.getComments(post.id).map((c) => c.id)).toContain('c1');
    feed.detach();
  });

  it('tags channel presence with the app scope', async () => {
    const feed = makeFeed(client);
    client.fireConnect();
    await flushMicrotasks();
    await feed.ready();

    client.sent = [];
    feed.joinChannel('main');
    const presenceWrite = client.sent.find((s) => s.op === 'setPresence');
    expect(presenceWrite).toBeDefined();
    expect((presenceWrite!.data as Record<string, unknown>).__scope).toBe('feed-app');
    feed.detach();
  });
});
