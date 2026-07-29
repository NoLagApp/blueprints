import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NoLagCollab } from '../../src/NoLagCollab';
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
 * Plus collab domain tests (documents, operations, cursors, awareness,
 * collaborator presence and colours).
 */

const flushMicrotasks = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

function snapshotUser(userId: string, username: string, scope?: string) {
  return {
    presence: { userId, username, status: 'active', ...(scope ? { __scope: scope } : {}) },
  };
}

function makeCollab(client: FakeNoLagClient, opts: Record<string, unknown> = {}) {
  return new NoLagCollab({
    client: client as never,
    username: 'Alice',
    appName: 'collab-app',
    ...opts,
  });
}

describe('NoLagCollab (client injection)', () => {
  let client: FakeNoLagClient;

  beforeEach(() => {
    client = makeFakeClient();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('throws without an injected client', () => {
    expect(() => new NoLagCollab({ username: 'Alice' } as never)).toThrow(TypeError);
  });

  it('sets up after the client connects and resolves ready()', async () => {
    const collab = makeCollab(client);
    const connected = vi.fn();
    collab.on('connected', connected);

    expect(collab.localUser).toBeNull();

    client.fireConnect('actor-1');
    await flushMicrotasks();

    await collab.ready();
    expect(connected).toHaveBeenCalledTimes(1);
    expect(collab.localUser?.actorTokenId).toBe('actor-1');
    collab.detach();
  });

  it('attach-to-connected: runs setup via microtask when the client is already live', async () => {
    client.fireConnect('actor-early');
    const collab = makeCollab(client);
    const connected = vi.fn();
    collab.on('connected', connected); // wired synchronously, before the microtask

    await flushMicrotasks();
    await collab.ready();

    expect(connected).toHaveBeenCalledTimes(1);
    expect(collab.localUser?.actorTokenId).toBe('actor-early');
    collab.detach();
  });

  it('runs setup once per epoch: reconnects emit reconnected, not connected', async () => {
    const collab = makeCollab(client);
    const connected = vi.fn();
    const reconnected = vi.fn();
    collab.on('connected', connected);
    collab.on('reconnected', reconnected);

    client.fireConnect();
    await flushMicrotasks();
    client.fireConnect(); // reconnect: core fires 'connect' again
    await flushMicrotasks();

    expect(connected).toHaveBeenCalledTimes(1);
    expect(reconnected).toHaveBeenCalledTimes(1);
    collab.detach();
  });

  it('emits reconnecting when the core fires reconnect', async () => {
    const collab = makeCollab(client);
    const reconnecting = vi.fn();
    collab.on('reconnecting', reconnecting);

    client.fireConnect();
    await flushMicrotasks();
    client.fireReconnect();

    expect(reconnecting).toHaveBeenCalledTimes(1);
    collab.detach();
  });

  it('diff-hydrates online users across reconnects', async () => {
    client.lobbySnapshot = {
      room1: { actorA: snapshotUser('user-a', 'Ann'), actorB: snapshotUser('user-b', 'Ben') },
    };
    const collab = makeCollab(client);
    const online = vi.fn();
    const offline = vi.fn();
    collab.on('userOnline', online);
    collab.on('userOffline', offline);

    client.fireConnect();
    await flushMicrotasks();
    expect(online).toHaveBeenCalledTimes(2);
    expect(collab.getOnlineUsers().map((u) => u.userId).sort()).toEqual(['user-a', 'user-b']);

    // Reconnect with Ann gone and Cid new: exactly one offline + one online
    client.lobbySnapshot = {
      room1: { actorB: snapshotUser('user-b', 'Ben'), actorC: snapshotUser('user-c', 'Cid') },
    };
    client.fireConnect();
    await flushMicrotasks();

    expect(offline).toHaveBeenCalledTimes(1);
    expect(offline.mock.calls[0][0].userId).toBe('user-a');
    expect(online).toHaveBeenCalledTimes(3);
    expect(collab.getOnlineUsers().map((u) => u.userId).sort()).toEqual(['user-b', 'user-c']);
    collab.detach();
  });

  it('LEAK TEST: detaching one wrapper leaves a co-attached wrapper fully intact', async () => {
    const collabA = makeCollab(client, { appName: 'app-a' });
    const collabB = makeCollab(client, { appName: 'app-b' });

    client.fireConnect();
    await flushMicrotasks();
    await collabA.ready();
    await collabB.ready();

    collabA.joinDocument('doc-1');
    collabB.joinDocument('doc-1');

    const bTopicHandlers = client.handlerCount('app-b/doc-1/operations');
    const bConnectHandlersBefore = client.handlerCount('connect');
    expect(bTopicHandlers).toBeGreaterThan(0);

    collabA.detach();

    // B's topic handlers and lifecycle handlers are untouched
    expect(client.handlerCount('app-b/doc-1/operations')).toBe(bTopicHandlers);
    expect(client.handlerCount('connect')).toBe(bConnectHandlersBefore - 1);
    // A's topic handlers and subscriptions are gone
    expect(client.handlerCount('app-a/doc-1/operations')).toBe(0);
    expect(client.isSubscribed('app-a/doc-1/operations')).toBe(false);
    expect(client.isSubscribed('app-b/doc-1/operations')).toBe(true);

    // B still receives operations from remote users
    const doc = collabB.documents.get('doc-1')!;
    const onOp = vi.fn();
    doc.on('operation', onOp);
    client.fireMessage('app-b/doc-1/operations', {
      id: 'op-1', type: 'insert', userId: 'user-x', username: 'X',
      position: 0, content: 'hi', timestamp: Date.now(), isReplay: false,
    }, {});
    expect(onOp).toHaveBeenCalledTimes(1);
    collabB.detach();
  });

  it('detach while disconnected skips server unsubscribes and removes handlers', async () => {
    const collab = makeCollab(client);
    client.fireConnect();
    await flushMicrotasks();
    collab.joinDocument('doc-1');

    client.fireDisconnect();
    client.sent = [];
    collab.detach();

    expect(client.sent.filter((s) => s.op === 'unsubscribe')).toEqual([]);
    expect(client.sent.filter((s) => s.op === 'lobbyUnsubscribe')).toEqual([]);
    expect(client.handledEvents()).toEqual([]);
  });

  it('double detach is a no-op and public methods throw after detach', async () => {
    const collab = makeCollab(client);
    client.fireConnect();
    await flushMicrotasks();

    collab.detach();
    expect(() => collab.detach()).not.toThrow();
    expect(() => collab.joinDocument('x')).toThrow(/detached/);
  });

  it('ready() rejects when detached before ready and joinDocument guards pre-ready', async () => {
    const collab = makeCollab(client);
    expect(() => collab.joinDocument('x')).toThrow(/not ready/);

    const readyPromise = collab.ready();
    collab.detach();
    await expect(readyPromise).rejects.toThrow(/detached before ready/);
  });

  it('filters presence tagged with another app scope, accepts own and untagged', async () => {
    const collab = makeCollab(client);
    const online = vi.fn();
    collab.on('userOnline', online);
    client.fireConnect();
    await flushMicrotasks();

    client.fireLobby('join', { actorId: 'actor-own', data: { userId: 'u1', username: 'Own', status: 'active', __scope: 'collab-app' } });
    client.fireLobby('join', { actorId: 'actor-foreign', data: { userId: 'u2', username: 'Foreign', status: 'active', __scope: 'other-app' } });
    client.fireLobby('join', { actorId: 'actor-untagged', data: { userId: 'u3', username: 'Legacy', status: 'active' } });

    expect(online).toHaveBeenCalledTimes(2);
    expect(collab.getOnlineUsers().map((u) => u.userId).sort()).toEqual(['u1', 'u3']);
    collab.detach();
  });

  it('runs the deferred lobby refresh and cancels it on detach', async () => {
    vi.useFakeTimers();
    const collab = makeCollab(client);
    client.fireConnect();
    await flushMicrotasks();

    client.sent = [];
    await vi.advanceTimersByTimeAsync(2000);
    expect(client.sent.some((s) => s.op === 'lobbyFetchPresence')).toBe(true);

    // A new wrapper's pending refresh dies with detach
    const collab2 = makeCollab(client, { appName: 'collab-app-2' });
    client.fireConnect();
    await flushMicrotasks();
    client.sent = [];
    collab2.detach();
    await vi.advanceTimersByTimeAsync(5000);
    expect(client.sent.filter((s) => s.op === 'lobbyFetchPresence' && s.topic?.startsWith('collab-app-2'))).toEqual([]);

    collab.detach();
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

    const collab = makeCollab(client);
    const connected = vi.fn();
    collab.on('connected', connected);

    client.fireConnect(); // epoch 1: hangs in lobby subscribe
    await flushMicrotasks();
    client.fireConnect(); // epoch 2: completes normally
    await flushMicrotasks();
    resolveFirst!({}); // epoch 1 resumes, must abort silently
    await flushMicrotasks();

    // Ready resolved exactly once, via epoch 2
    await collab.ready();
    expect(connected).toHaveBeenCalledTimes(1);
    collab.detach();
  });
});

describe('NoLagCollab (domain behavior)', () => {
  let client: FakeNoLagClient;

  const setup = async (opts: Record<string, unknown> = {}) => {
    const collab = makeCollab(client, opts);
    client.fireConnect('local-actor');
    await flushMicrotasks();
    await collab.ready();
    return collab;
  };

  beforeEach(() => {
    client = makeFakeClient();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('assigns a stable local user with colour/metadata/username after ready', async () => {
    const collab = await setup({ username: 'Alice', color: '#ff0000', metadata: { role: 'editor' } });
    expect(typeof collab.localUser!.userId).toBe('string');
    expect(collab.localUser!.userId.length).toBeGreaterThan(0);
    expect(collab.localUser!.username).toBe('Alice');
    expect(collab.localUser!.color).toBe('#ff0000');
    expect(collab.localUser!.isLocal).toBe(true);
    expect(collab.localUser!.metadata).toEqual({ role: 'editor' });
    collab.detach();
  });

  it('joinDocument subscribes to operations and cursors and is idempotent', async () => {
    const collab = await setup();
    const d1 = collab.joinDocument('doc-1');
    const d2 = collab.joinDocument('doc-1');

    expect(d1).toBe(d2);
    expect(d1.name).toBe('doc-1');
    expect(client.isSubscribed('collab-app/doc-1/operations')).toBe(true);
    expect(client.isSubscribed('collab-app/doc-1/_cursors')).toBe(true);
    collab.detach();
  });

  it('uses a custom app name for topic prefixes', async () => {
    const collab = await setup({ appName: 'my-app' });
    collab.joinDocument('doc-1');
    expect(client.isSubscribed('my-app/doc-1/operations')).toBe(true);
    collab.detach();
  });

  it('auto-joins pre-configured documents on connect', async () => {
    const collab = await setup({ documents: ['doc-a', 'doc-b'] });
    expect(collab.documents.size).toBe(2);
    expect(collab.documents.has('doc-a')).toBe(true);
    expect(collab.documents.has('doc-b')).toBe(true);
    expect(client.isSubscribed('collab-app/doc-a/operations')).toBe(true);
    expect(client.isSubscribed('collab-app/doc-b/operations')).toBe(true);
    collab.detach();
  });

  it('sendOperation emits on the operations topic with echo:false', async () => {
    const collab = await setup();
    const doc = collab.joinDocument('doc-1');
    client.sent = [];
    doc.sendOperation('insert', { position: 0, content: 'Hello' });

    const emitted = client.sent.find((s) => s.op === 'emit' && s.topic === 'collab-app/doc-1/operations');
    expect(emitted).toBeTruthy();
    const op = emitted!.data as Record<string, unknown>;
    expect(op.type).toBe('insert');
    expect(op.content).toBe('Hello');
    collab.detach();
  });

  it('applies a remote operation and emits operation', async () => {
    const collab = await setup();
    const doc = collab.joinDocument('doc-1');
    const onOp = vi.fn();
    doc.on('operation', onOp);

    client.fireMessage('collab-app/doc-1/operations', {
      id: 'remote-op', type: 'insert', userId: 'remote-user', username: 'Bob',
      position: 5, content: 'Hi', timestamp: Date.now(), isReplay: false,
    }, {});

    expect(onOp).toHaveBeenCalledTimes(1);
    expect((onOp.mock.calls[0][0] as { id: string }).id).toBe('remote-op');
    collab.detach();
  });

  it('broadcasts cursor updates (throttled) on the _cursors topic', async () => {
    vi.useFakeTimers();
    const collab = await setup();
    const doc = collab.joinDocument('doc-1');
    client.sent = [];

    doc.updateCursor({ x: 1 });
    doc.updateCursor({ x: 2 });
    doc.updateCursor({ x: 3 });

    const cursorEmits = () => client.sent.filter((s) => s.op === 'emit' && s.topic === 'collab-app/doc-1/_cursors');
    expect(cursorEmits().length).toBe(1); // immediate first send

    vi.advanceTimersByTime(50);
    const emits = cursorEmits();
    expect(emits.length).toBe(2); // trailing pending flush
    expect((emits[1].data as { x: number }).x).toBe(3);
    collab.detach();
  });

  it('routes room presence to all joined documents and tracks online users', async () => {
    const collab = await setup();
    const docA = collab.joinDocument('doc-a');
    const docB = collab.joinDocument('doc-b');
    const joinedA = vi.fn();
    const joinedB = vi.fn();
    const online = vi.fn();
    docA.on('userJoined', joinedA);
    docB.on('userJoined', joinedB);
    collab.on('userOnline', online);

    client.firePresence('join', {
      actorTokenId: 'actor-remote',
      presence: { userId: 'u-remote', username: 'Bob', color: '#00ff00', status: 'active', __scope: 'collab-app' },
    });

    expect(joinedA).toHaveBeenCalledTimes(1);
    expect(joinedB).toHaveBeenCalledTimes(1);
    expect(online).toHaveBeenCalledTimes(1);
    expect(collab.getOnlineUsers().map((u) => u.userId)).toContain('u-remote');
    collab.detach();
  });

  it('emits awarenessChanged when a routed collaborator goes idle', async () => {
    vi.useFakeTimers();
    const collab = await setup({ idleTimeout: 60000 });
    const doc = collab.joinDocument('doc-1');
    const idle = vi.fn();
    doc.on('awarenessChanged', idle);

    client.firePresence('join', {
      actorTokenId: 'actor-remote',
      presence: { userId: 'u-remote', username: 'Bob', status: 'active', __scope: 'collab-app' },
    });

    vi.advanceTimersByTime(60000);
    expect(idle).toHaveBeenCalledWith({ userId: 'u-remote', status: 'idle' });
    collab.detach();
  });

  it('leaveDocument unsubscribes and removes the document', async () => {
    const collab = await setup();
    collab.joinDocument('doc-1');
    client.sent = [];
    collab.leaveDocument('doc-1');

    expect(collab.documents.size).toBe(0);
    expect(client.sent.some((s) => s.op === 'unsubscribe' && s.topic === 'collab-app/doc-1/operations')).toBe(true);
    expect(client.sent.some((s) => s.op === 'unsubscribe' && s.topic === 'collab-app/doc-1/_cursors')).toBe(true);
    collab.detach();
  });

  it('re-applies document presence on reconnect', async () => {
    const collab = await setup();
    collab.joinDocument('doc-1');
    client.sent = [];

    client.fireConnect('local-actor'); // reconnect
    await flushMicrotasks();

    // Presence re-set for joined documents on restore
    expect(client.sent.some((s) => s.op === 'setPresence' && s.topic === 'collab-app/doc-1')).toBe(true);
    collab.detach();
  });
});
