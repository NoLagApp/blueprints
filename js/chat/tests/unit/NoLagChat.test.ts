import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NoLagChat } from '../../src/NoLagChat';
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
    presence: { userId, username, status: 'online', ...(scope ? { __scope: scope } : {}) },
  };
}

function makeChat(client: FakeNoLagClient, opts: Record<string, unknown> = {}) {
  return new NoLagChat({
    client: client as never,
    username: 'Alice',
    appName: 'chat-app',
    ...opts,
  });
}

describe('NoLagChat (client injection)', () => {
  let client: FakeNoLagClient;

  beforeEach(() => {
    client = makeFakeClient();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('throws without an injected client', () => {
    expect(() => new NoLagChat({ username: 'Alice' } as never)).toThrow(TypeError);
  });

  it('sets up after the client connects and resolves ready()', async () => {
    const chat = makeChat(client);
    const connected = vi.fn();
    chat.on('connected', connected);

    expect(chat.localUser).toBeNull();

    client.fireConnect('actor-1');
    await flushMicrotasks();

    await chat.ready();
    expect(connected).toHaveBeenCalledTimes(1);
    expect(chat.localUser?.actorTokenId).toBe('actor-1');
    chat.detach();
  });

  it('attach-to-connected: runs setup via microtask when the client is already live', async () => {
    client.fireConnect('actor-early');
    const chat = makeChat(client);
    const connected = vi.fn();
    chat.on('connected', connected); // wired synchronously, before the microtask

    await flushMicrotasks();
    await chat.ready();

    expect(connected).toHaveBeenCalledTimes(1);
    expect(chat.localUser?.actorTokenId).toBe('actor-early');
    chat.detach();
  });

  it('runs setup once per epoch: reconnects emit reconnected, not connected', async () => {
    const chat = makeChat(client);
    const connected = vi.fn();
    const reconnected = vi.fn();
    chat.on('connected', connected);
    chat.on('reconnected', reconnected);

    client.fireConnect();
    await flushMicrotasks();
    client.fireConnect(); // reconnect: core fires 'connect' again
    await flushMicrotasks();

    expect(connected).toHaveBeenCalledTimes(1);
    expect(reconnected).toHaveBeenCalledTimes(1);
    chat.detach();
  });

  it('diff-hydrates online users across reconnects', async () => {
    client.lobbySnapshot = {
      room1: { actorA: snapshotUser('user-a', 'Ann'), actorB: snapshotUser('user-b', 'Ben') },
    };
    const chat = makeChat(client);
    const online = vi.fn();
    const offline = vi.fn();
    chat.on('userOnline', online);
    chat.on('userOffline', offline);

    client.fireConnect();
    await flushMicrotasks();
    expect(online).toHaveBeenCalledTimes(2);
    expect(chat.getOnlineUsers().map((u) => u.userId).sort()).toEqual(['user-a', 'user-b']);

    // Reconnect with Ann gone and Cid new: exactly one offline + one online
    client.lobbySnapshot = {
      room1: { actorB: snapshotUser('user-b', 'Ben'), actorC: snapshotUser('user-c', 'Cid') },
    };
    client.fireConnect();
    await flushMicrotasks();

    expect(offline).toHaveBeenCalledTimes(1);
    expect(offline.mock.calls[0][0].userId).toBe('user-a');
    expect(online).toHaveBeenCalledTimes(3);
    expect(chat.getOnlineUsers().map((u) => u.userId).sort()).toEqual(['user-b', 'user-c']);
    chat.detach();
  });

  it('LEAK TEST: detaching one wrapper leaves a co-attached wrapper fully intact', async () => {
    const chatA = makeChat(client, { appName: 'app-a' });
    const chatB = makeChat(client, { appName: 'app-b' });

    client.fireConnect();
    await flushMicrotasks();
    await chatA.ready();
    await chatB.ready();

    chatA.joinRoom('general');
    chatB.joinRoom('general');

    const bTopicHandlers = client.handlerCount('app-b/general/messages');
    const bConnectHandlersBefore = client.handlerCount('connect');
    expect(bTopicHandlers).toBeGreaterThan(0);

    chatA.detach();

    // B's topic handlers and lifecycle handlers are untouched
    expect(client.handlerCount('app-b/general/messages')).toBe(bTopicHandlers);
    expect(client.handlerCount('connect')).toBe(bConnectHandlersBefore - 1);
    // A's topic handlers and subscriptions are gone
    expect(client.handlerCount('app-a/general/messages')).toBe(0);
    expect(client.isSubscribed('app-a/general/messages')).toBe(false);
    expect(client.isSubscribed('app-b/general/messages')).toBe(true);

    // B still receives messages
    const room = chatB.rooms.get('general')!;
    const onMessage = vi.fn();
    room.on('message', onMessage);
    client.fireMessage('app-b/general/messages', {
      id: 'm1', userId: 'user-x', username: 'X', text: 'hi', timestamp: Date.now(),
    }, {});
    expect(onMessage).toHaveBeenCalledTimes(1);
    chatB.detach();
  });

  it('detach while disconnected skips server unsubscribes and removes handlers', async () => {
    const chat = makeChat(client);
    client.fireConnect();
    await flushMicrotasks();
    chat.joinRoom('general');

    client.fireDisconnect();
    client.sent = [];
    chat.detach();

    expect(client.sent.filter((s) => s.op === 'unsubscribe')).toEqual([]);
    expect(client.sent.filter((s) => s.op === 'lobbyUnsubscribe')).toEqual([]);
    expect(client.handledEvents()).toEqual([]);
  });

  it('double detach is a no-op and public methods throw after detach', async () => {
    const chat = makeChat(client);
    client.fireConnect();
    await flushMicrotasks();

    chat.detach();
    expect(() => chat.detach()).not.toThrow();
    expect(() => chat.joinRoom('x')).toThrow(/detached/);
  });

  it('ready() rejects when detached before ready and joinRoom guards pre-ready', async () => {
    const chat = makeChat(client);
    expect(() => chat.joinRoom('x')).toThrow(/not ready/);

    const readyPromise = chat.ready();
    chat.detach();
    await expect(readyPromise).rejects.toThrow(/detached before ready/);
  });

  it('filters presence tagged with another app scope, accepts own and untagged', async () => {
    const chat = makeChat(client);
    const online = vi.fn();
    chat.on('userOnline', online);
    client.fireConnect();
    await flushMicrotasks();

    client.fireLobby('join', { actorId: 'actor-own', data: { userId: 'u1', username: 'Own', status: 'online', __scope: 'chat-app' } });
    client.fireLobby('join', { actorId: 'actor-foreign', data: { userId: 'u2', username: 'Foreign', status: 'online', __scope: 'other-app' } });
    client.fireLobby('join', { actorId: 'actor-untagged', data: { userId: 'u3', username: 'Legacy', status: 'online' } });

    expect(online).toHaveBeenCalledTimes(2);
    expect(chat.getOnlineUsers().map((u) => u.userId).sort()).toEqual(['u1', 'u3']);
    chat.detach();
  });

  it('runs the deferred lobby refresh and cancels it on detach', async () => {
    vi.useFakeTimers();
    const chat = makeChat(client);
    client.fireConnect();
    await flushMicrotasks();

    client.sent = [];
    await vi.advanceTimersByTimeAsync(2000);
    expect(client.sent.some((s) => s.op === 'lobbyFetchPresence')).toBe(true);

    // A new wrapper's pending refresh dies with detach
    const chat2 = makeChat(client, { appName: 'chat-app-2' });
    client.fireConnect();
    await flushMicrotasks();
    client.sent = [];
    chat2.detach();
    await vi.advanceTimersByTimeAsync(5000);
    expect(client.sent.filter((s) => s.op === 'lobbyFetchPresence' && s.topic?.startsWith('chat-app-2'))).toEqual([]);

    chat.detach();
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

    const chat = makeChat(client);
    const connected = vi.fn();
    chat.on('connected', connected);

    client.fireConnect(); // epoch 1: hangs in lobby subscribe
    await flushMicrotasks();
    client.fireConnect(); // epoch 2: completes normally
    await flushMicrotasks();
    resolveFirst!({}); // epoch 1 resumes, must abort silently
    await flushMicrotasks();

    // Ready resolved exactly once, via epoch 2
    await chat.ready();
    expect(connected).toHaveBeenCalledTimes(1);
    chat.detach();
  });
});
