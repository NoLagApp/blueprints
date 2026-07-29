import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NoLagSync } from '../../src/NoLagSync';
import { makeFakeClient, FakeNoLagClient } from '../helpers/fakeNoLagClient';

/**
 * Contract tests for the client-injection lifecycle (the canonical set —
 * every wrapper SDK carries equivalents):
 * 1. throws without an injected client
 * 2. attach-to-connected microtask setup + ready()
 * 3. once-per-epoch setup (connect vs reconnect)
 * 4. reconnect diff-hydration
 * 5. the leak test: detaching one wrapper leaves a co-attached wrapper intact
 * 6. detach-while-disconnected / double-detach / post-detach + pre-ready throws
 * 7. ready() rejects on early detach
 * Plus sync domain tests (collections, documents, collaborator presence).
 */

const flushMicrotasks = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

function snapshotCollaborator(userId: string, username?: string, scope?: string) {
  return {
    presence: { userId, ...(username ? { username } : {}), ...(scope ? { __scope: scope } : {}) },
  };
}

function makeSync(client: FakeNoLagClient, opts: Record<string, unknown> = {}) {
  return new NoLagSync({
    client: client as never,
    appName: 'sync-app',
    ...opts,
  });
}

describe('NoLagSync (client injection)', () => {
  let client: FakeNoLagClient;

  beforeEach(() => {
    client = makeFakeClient();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('throws without an injected client', () => {
    expect(() => new NoLagSync({} as never)).toThrow(TypeError);
  });

  it('sets up after the client connects and resolves ready()', async () => {
    const sync = makeSync(client);
    const connected = vi.fn();
    sync.on('connected', connected);

    expect(sync.localCollaborator).toBeNull();

    client.fireConnect('actor-1');
    await flushMicrotasks();

    await sync.ready();
    expect(connected).toHaveBeenCalledTimes(1);
    expect(sync.localCollaborator?.actorTokenId).toBe('actor-1');
    sync.detach();
  });

  it('attach-to-connected: runs setup via microtask when the client is already live', async () => {
    client.fireConnect('actor-early');
    const sync = makeSync(client);
    const connected = vi.fn();
    sync.on('connected', connected); // wired synchronously, before the microtask

    await flushMicrotasks();
    await sync.ready();

    expect(connected).toHaveBeenCalledTimes(1);
    expect(sync.localCollaborator?.actorTokenId).toBe('actor-early');
    sync.detach();
  });

  it('runs setup once per epoch: reconnects emit reconnected, not connected', async () => {
    const sync = makeSync(client);
    const connected = vi.fn();
    const reconnected = vi.fn();
    sync.on('connected', connected);
    sync.on('reconnected', reconnected);

    client.fireConnect();
    await flushMicrotasks();
    client.fireConnect(); // reconnect: core fires 'connect' again
    await flushMicrotasks();

    expect(connected).toHaveBeenCalledTimes(1);
    expect(reconnected).toHaveBeenCalledTimes(1);
    sync.detach();
  });

  it('diff-hydrates online collaborators across reconnects', async () => {
    client.lobbySnapshot = {
      room1: { actorA: snapshotCollaborator('user-a', 'Ann'), actorB: snapshotCollaborator('user-b', 'Ben') },
    };
    const sync = makeSync(client);
    const online = vi.fn();
    const offline = vi.fn();
    sync.on('collaboratorOnline', online);
    sync.on('collaboratorOffline', offline);

    client.fireConnect();
    await flushMicrotasks();
    expect(online).toHaveBeenCalledTimes(2);
    expect(sync.getCollaborators().map((c) => c.userId).sort()).toEqual(['user-a', 'user-b']);

    // Reconnect with Ann gone and Cid new: exactly one offline + one online
    client.lobbySnapshot = {
      room1: { actorB: snapshotCollaborator('user-b', 'Ben'), actorC: snapshotCollaborator('user-c', 'Cid') },
    };
    client.fireConnect();
    await flushMicrotasks();

    expect(offline).toHaveBeenCalledTimes(1);
    expect(offline.mock.calls[0][0].userId).toBe('user-a');
    expect(online).toHaveBeenCalledTimes(3);
    expect(sync.getCollaborators().map((c) => c.userId).sort()).toEqual(['user-b', 'user-c']);
    sync.detach();
  });

  it('LEAK TEST: detaching one wrapper leaves a co-attached wrapper fully intact', async () => {
    const syncA = makeSync(client, { appName: 'app-a' });
    const syncB = makeSync(client, { appName: 'app-b' });

    client.fireConnect();
    await flushMicrotasks();
    await syncA.ready();
    await syncB.ready();

    syncA.joinCollection('todos');
    syncB.joinCollection('todos');

    const bTopicHandlers = client.handlerCount('app-b/todos/changes');
    const bConnectHandlersBefore = client.handlerCount('connect');
    expect(bTopicHandlers).toBeGreaterThan(0);

    syncA.detach();

    // B's topic handlers and lifecycle handlers are untouched
    expect(client.handlerCount('app-b/todos/changes')).toBe(bTopicHandlers);
    expect(client.handlerCount('connect')).toBe(bConnectHandlersBefore - 1);
    // A's topic handlers and subscriptions are gone
    expect(client.handlerCount('app-a/todos/changes')).toBe(0);
    expect(client.isSubscribed('app-a/todos/changes')).toBe(false);
    expect(client.isSubscribed('app-b/todos/changes')).toBe(true);

    // B still receives changes from remote users
    const collection = syncB.collections.get('todos')!;
    const onCreated = vi.fn();
    collection.on('documentCreated', onCreated);
    client.fireMessage('app-b/todos/changes', {
      id: 'c1', documentId: 'doc-1', type: 'create', fields: { text: 'hi' },
      version: 1, updatedBy: 'remote-user', timestamp: Date.now(), optimistic: false, isReplay: false,
    }, {});
    expect(onCreated).toHaveBeenCalledTimes(1);
    syncB.detach();
  });

  it('detach while disconnected skips server unsubscribes and removes handlers', async () => {
    const sync = makeSync(client);
    client.fireConnect();
    await flushMicrotasks();
    sync.joinCollection('todos');

    client.fireDisconnect();
    client.sent = [];
    sync.detach();

    expect(client.sent.filter((s) => s.op === 'unsubscribe')).toEqual([]);
    expect(client.sent.filter((s) => s.op === 'lobbyUnsubscribe')).toEqual([]);
    expect(client.handledEvents()).toEqual([]);
  });

  it('double detach is a no-op and public methods throw after detach', async () => {
    const sync = makeSync(client);
    client.fireConnect();
    await flushMicrotasks();

    sync.detach();
    expect(() => sync.detach()).not.toThrow();
    expect(() => sync.joinCollection('x')).toThrow(/detached/);
  });

  it('ready() rejects when detached before ready and joinCollection guards pre-ready', async () => {
    const sync = makeSync(client);
    expect(() => sync.joinCollection('x')).toThrow(/not ready/);

    const readyPromise = sync.ready();
    sync.detach();
    await expect(readyPromise).rejects.toThrow(/detached before ready/);
  });

  it('filters presence tagged with another app scope, accepts own and untagged', async () => {
    const sync = makeSync(client);
    const online = vi.fn();
    sync.on('collaboratorOnline', online);
    client.fireConnect();
    await flushMicrotasks();

    client.fireLobby('join', { actorId: 'actor-own', data: { userId: 'u1', username: 'Own', __scope: 'sync-app' } });
    client.fireLobby('join', { actorId: 'actor-foreign', data: { userId: 'u2', username: 'Foreign', __scope: 'other-app' } });
    client.fireLobby('join', { actorId: 'actor-untagged', data: { userId: 'u3', username: 'Legacy' } });

    expect(online).toHaveBeenCalledTimes(2);
    expect(sync.getCollaborators().map((c) => c.userId).sort()).toEqual(['u1', 'u3']);
    sync.detach();
  });

  it('runs the deferred lobby refresh and cancels it on detach', async () => {
    vi.useFakeTimers();
    const sync = makeSync(client);
    client.fireConnect();
    await flushMicrotasks();

    client.sent = [];
    await vi.advanceTimersByTimeAsync(2000);
    expect(client.sent.some((s) => s.op === 'lobbyFetchPresence')).toBe(true);

    // A new wrapper's pending refresh dies with detach
    const sync2 = makeSync(client, { appName: 'sync-app-2' });
    client.fireConnect();
    await flushMicrotasks();
    client.sent = [];
    sync2.detach();
    await vi.advanceTimersByTimeAsync(5000);
    expect(client.sent.filter((s) => s.op === 'lobbyFetchPresence' && s.topic?.startsWith('sync-app-2'))).toEqual([]);

    sync.detach();
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

    const sync = makeSync(client);
    const connected = vi.fn();
    sync.on('connected', connected);

    client.fireConnect(); // epoch 1: hangs in lobby subscribe
    await flushMicrotasks();
    client.fireConnect(); // epoch 2: completes normally
    await flushMicrotasks();
    resolveFirst!({}); // epoch 1 resumes, must abort silently
    await flushMicrotasks();

    // Ready resolved exactly once, via epoch 2
    await sync.ready();
    expect(connected).toHaveBeenCalledTimes(1);
    sync.detach();
  });
});

describe('NoLagSync (domain behavior)', () => {
  let client: FakeNoLagClient;

  const setup = async (opts: Record<string, unknown> = {}) => {
    const sync = makeSync(client, opts);
    client.fireConnect('local-actor');
    await flushMicrotasks();
    await sync.ready();
    return sync;
  };

  beforeEach(() => {
    client = makeFakeClient();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('assigns a stable local collaborator with metadata/username after ready', async () => {
    const sync = await setup({ userId: 'my-id', username: 'Alice', metadata: { role: 'editor' } });
    expect(sync.localCollaborator!.userId).toBe('my-id');
    expect(sync.localCollaborator!.username).toBe('Alice');
    expect(sync.localCollaborator!.isLocal).toBe(true);
    expect(sync.localCollaborator!.metadata).toEqual({ role: 'editor' });
    sync.detach();
  });

  it('generates a userId when none is provided', async () => {
    const sync = await setup();
    expect(typeof sync.localCollaborator!.userId).toBe('string');
    expect(sync.localCollaborator!.userId.length).toBeGreaterThan(0);
    sync.detach();
  });

  it('joinCollection subscribes to the changes topic and is idempotent', async () => {
    const sync = await setup();
    const c1 = sync.joinCollection('todos');
    const c2 = sync.joinCollection('todos');

    expect(c1).toBe(c2);
    expect(c1.name).toBe('todos');
    expect(client.isSubscribed('sync-app/todos/changes')).toBe(true);
    sync.detach();
  });

  it('uses a custom app name for topic prefixes', async () => {
    const sync = await setup({ appName: 'my-app' });
    sync.joinCollection('todos');
    expect(client.isSubscribed('my-app/todos/changes')).toBe(true);
    sync.detach();
  });

  it('auto-joins pre-configured collections on connect', async () => {
    const sync = await setup({ collections: ['todos', 'notes'] });
    expect(sync.collections.size).toBe(2);
    expect(sync.collections.has('todos')).toBe(true);
    expect(sync.collections.has('notes')).toBe(true);
    expect(client.isSubscribed('sync-app/todos/changes')).toBe(true);
    expect(client.isSubscribed('sync-app/notes/changes')).toBe(true);
    sync.detach();
  });

  it('createDocument emits a change on the changes topic', async () => {
    const sync = await setup({ userId: 'local-user' });
    const collection = sync.joinCollection('todos');
    client.sent = [];
    collection.createDocument('todo-1', { text: 'Hello', done: false });

    const emitted = client.sent.find((s) => s.op === 'emit' && s.topic === 'sync-app/todos/changes');
    expect(emitted).toBeTruthy();
    const change = emitted!.data as Record<string, unknown>;
    expect(change.type).toBe('create');
    expect(change.documentId).toBe('todo-1');
    expect(change.updatedBy).toBe('local-user');
    sync.detach();
  });

  it('applies a remote create change and emits documentCreated', async () => {
    const sync = await setup();
    const collection = sync.joinCollection('todos');
    const onCreated = vi.fn();
    collection.on('documentCreated', onCreated);

    client.fireMessage('sync-app/todos/changes', {
      id: 'c1', documentId: 'doc-remote', type: 'create', fields: { text: 'From remote' },
      version: 1, updatedBy: 'remote-user', timestamp: Date.now(), optimistic: false, isReplay: false,
    }, {});

    expect(onCreated).toHaveBeenCalledTimes(1);
    expect((onCreated.mock.calls[0][0] as { id: string }).id).toBe('doc-remote');
    sync.detach();
  });

  it('routes room presence to all joined collections and tracks online collaborators', async () => {
    const sync = await setup();
    const collA = sync.joinCollection('todos');
    const collB = sync.joinCollection('notes');
    const joinedA = vi.fn();
    const joinedB = vi.fn();
    const online = vi.fn();
    collA.on('collaboratorJoined', joinedA);
    collB.on('collaboratorJoined', joinedB);
    sync.on('collaboratorOnline', online);

    client.firePresence('join', {
      actorTokenId: 'actor-remote',
      presence: { userId: 'u-remote', username: 'Bob', __scope: 'sync-app' },
    });

    expect(joinedA).toHaveBeenCalledTimes(1);
    expect(joinedB).toHaveBeenCalledTimes(1);
    expect(online).toHaveBeenCalledTimes(1);
    expect(sync.getCollaborators().map((c) => c.userId)).toContain('u-remote');
    sync.detach();
  });

  it('leaveCollection unsubscribes and removes the collection', async () => {
    const sync = await setup();
    sync.joinCollection('todos');
    client.sent = [];
    sync.leaveCollection('todos');

    expect(sync.collections.size).toBe(0);
    expect(client.sent.some((s) => s.op === 'unsubscribe' && s.topic === 'sync-app/todos/changes')).toBe(true);
    sync.detach();
  });

  it('re-applies collection presence on reconnect', async () => {
    const sync = await setup();
    sync.joinCollection('todos');
    client.sent = [];

    client.fireConnect('local-actor'); // reconnect
    await flushMicrotasks();

    // Presence re-set for joined collections on restore
    expect(client.sent.some((s) => s.op === 'setPresence' && s.topic === 'sync-app/todos')).toBe(true);
    sync.detach();
  });
});
