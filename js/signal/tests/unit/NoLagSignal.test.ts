import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NoLagSignal } from '../../src/NoLagSignal';
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
 * Plus signal domain tests (rooms, signaling, peer presence) adapted.
 */

const flushMicrotasks = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

function snapshotPeer(peerId: string, scope?: string) {
  return {
    presence: { peerId, ...(scope ? { __scope: scope } : {}) },
  };
}

function makeSignal(client: FakeNoLagClient, opts: Record<string, unknown> = {}) {
  return new NoLagSignal({
    client: client as never,
    appName: 'signal-app',
    ...opts,
  });
}

describe('NoLagSignal (client injection)', () => {
  let client: FakeNoLagClient;

  beforeEach(() => {
    client = makeFakeClient();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('throws without an injected client', () => {
    expect(() => new NoLagSignal({} as never)).toThrow(TypeError);
  });

  it('sets up after the client connects and resolves ready()', async () => {
    const signal = makeSignal(client);
    const connected = vi.fn();
    signal.on('connected', connected);

    expect(signal.localPeer).toBeNull();

    client.fireConnect('actor-1');
    await flushMicrotasks();

    await signal.ready();
    expect(connected).toHaveBeenCalledTimes(1);
    expect(signal.localPeer?.actorTokenId).toBe('actor-1');
    signal.detach();
  });

  it('attach-to-connected: runs setup via microtask when the client is already live', async () => {
    client.fireConnect('actor-early');
    const signal = makeSignal(client);
    const connected = vi.fn();
    signal.on('connected', connected); // wired synchronously, before the microtask

    await flushMicrotasks();
    await signal.ready();

    expect(connected).toHaveBeenCalledTimes(1);
    expect(signal.localPeer?.actorTokenId).toBe('actor-early');
    signal.detach();
  });

  it('runs setup once per epoch: reconnects emit reconnected, not connected', async () => {
    const signal = makeSignal(client);
    const connected = vi.fn();
    const reconnected = vi.fn();
    signal.on('connected', connected);
    signal.on('reconnected', reconnected);

    client.fireConnect();
    await flushMicrotasks();
    client.fireConnect(); // reconnect: core fires 'connect' again
    await flushMicrotasks();

    expect(connected).toHaveBeenCalledTimes(1);
    expect(reconnected).toHaveBeenCalledTimes(1);
    signal.detach();
  });

  it('diff-hydrates online peers across reconnects', async () => {
    client.lobbySnapshot = {
      room1: { actorA: snapshotPeer('peer-a'), actorB: snapshotPeer('peer-b') },
    };
    const signal = makeSignal(client);
    const online = vi.fn();
    const offline = vi.fn();
    signal.on('peerOnline', online);
    signal.on('peerOffline', offline);

    client.fireConnect();
    await flushMicrotasks();
    expect(online).toHaveBeenCalledTimes(2);
    expect(signal.getOnlinePeers().map((p) => p.peerId).sort()).toEqual(['peer-a', 'peer-b']);

    // Reconnect with A gone and C new: exactly one offline + one online
    client.lobbySnapshot = {
      room1: { actorB: snapshotPeer('peer-b'), actorC: snapshotPeer('peer-c') },
    };
    client.fireConnect();
    await flushMicrotasks();

    expect(offline).toHaveBeenCalledTimes(1);
    expect(offline.mock.calls[0][0].peerId).toBe('peer-a');
    expect(online).toHaveBeenCalledTimes(3);
    expect(signal.getOnlinePeers().map((p) => p.peerId).sort()).toEqual(['peer-b', 'peer-c']);
    signal.detach();
  });

  it('LEAK TEST: detaching one wrapper leaves a co-attached wrapper fully intact', async () => {
    const signalA = makeSignal(client, { appName: 'app-a' });
    const signalB = makeSignal(client, { appName: 'app-b' });

    client.fireConnect();
    await flushMicrotasks();
    await signalA.ready();
    await signalB.ready();

    signalA.joinRoom('call');
    signalB.joinRoom('call');

    const bTopicHandlers = client.handlerCount('app-b/call/signaling');
    const bConnectHandlersBefore = client.handlerCount('connect');
    expect(bTopicHandlers).toBeGreaterThan(0);

    signalA.detach();

    // B's topic handlers and lifecycle handlers are untouched
    expect(client.handlerCount('app-b/call/signaling')).toBe(bTopicHandlers);
    expect(client.handlerCount('connect')).toBe(bConnectHandlersBefore - 1);
    // A's topic handlers and subscriptions are gone
    expect(client.handlerCount('app-a/call/signaling')).toBe(0);
    expect(client.isSubscribed('app-a/call/signaling')).toBe(false);
    expect(client.isSubscribed('app-b/call/signaling')).toBe(true);

    // B still receives signals targeted at its local peer
    const room = signalB.rooms.get('call')!;
    const onSignal = vi.fn();
    room.on('signal', onSignal);
    client.fireMessage('app-b/call/signaling', {
      id: 's1', type: 'offer', fromPeerId: 'remote',
      toPeerId: signalB.localPeer!.peerId, payload: {}, timestamp: Date.now(),
    }, {});
    expect(onSignal).toHaveBeenCalledTimes(1);
    signalB.detach();
  });

  it('detach while disconnected skips server unsubscribes and removes handlers', async () => {
    const signal = makeSignal(client);
    client.fireConnect();
    await flushMicrotasks();
    signal.joinRoom('call');

    client.fireDisconnect();
    client.sent = [];
    signal.detach();

    expect(client.sent.filter((s) => s.op === 'unsubscribe')).toEqual([]);
    expect(client.sent.filter((s) => s.op === 'lobbyUnsubscribe')).toEqual([]);
    expect(client.handledEvents()).toEqual([]);
  });

  it('double detach is a no-op and public methods throw after detach', async () => {
    const signal = makeSignal(client);
    client.fireConnect();
    await flushMicrotasks();

    signal.detach();
    expect(() => signal.detach()).not.toThrow();
    expect(() => signal.joinRoom('x')).toThrow(/detached/);
  });

  it('ready() rejects when detached before ready and joinRoom guards pre-ready', async () => {
    const signal = makeSignal(client);
    expect(() => signal.joinRoom('x')).toThrow(/not ready/);

    const readyPromise = signal.ready();
    signal.detach();
    await expect(readyPromise).rejects.toThrow(/detached before ready/);
  });

  it('filters presence tagged with another app scope, accepts own and untagged', async () => {
    const signal = makeSignal(client);
    const online = vi.fn();
    signal.on('peerOnline', online);
    client.fireConnect();
    await flushMicrotasks();

    client.fireLobby('join', { actorId: 'actor-own', data: { peerId: 'p1', __scope: 'signal-app' } });
    client.fireLobby('join', { actorId: 'actor-foreign', data: { peerId: 'p2', __scope: 'other-app' } });
    client.fireLobby('join', { actorId: 'actor-untagged', data: { peerId: 'p3' } });

    expect(online).toHaveBeenCalledTimes(2);
    expect(signal.getOnlinePeers().map((p) => p.peerId).sort()).toEqual(['p1', 'p3']);
    signal.detach();
  });

  it('runs the deferred lobby refresh and cancels it on detach', async () => {
    vi.useFakeTimers();
    const signal = makeSignal(client);
    client.fireConnect();
    await flushMicrotasks();

    client.sent = [];
    await vi.advanceTimersByTimeAsync(2000);
    expect(client.sent.some((s) => s.op === 'lobbyFetchPresence')).toBe(true);

    // A new wrapper's pending refresh dies with detach
    const signal2 = makeSignal(client, { appName: 'signal-app-2' });
    client.fireConnect();
    await flushMicrotasks();
    client.sent = [];
    signal2.detach();
    await vi.advanceTimersByTimeAsync(5000);
    expect(client.sent.filter((s) => s.op === 'lobbyFetchPresence' && s.topic?.startsWith('signal-app-2'))).toEqual([]);

    signal.detach();
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

    const signal = makeSignal(client);
    const connected = vi.fn();
    signal.on('connected', connected);

    client.fireConnect(); // epoch 1: hangs in lobby subscribe
    await flushMicrotasks();
    client.fireConnect(); // epoch 2: completes normally
    await flushMicrotasks();
    resolveFirst!({}); // epoch 1 resumes, must abort silently
    await flushMicrotasks();

    // Ready resolved exactly once, via epoch 2
    await signal.ready();
    expect(connected).toHaveBeenCalledTimes(1);
    signal.detach();
  });
});

describe('NoLagSignal (domain behavior)', () => {
  let client: FakeNoLagClient;

  const setup = async (opts: Record<string, unknown> = {}) => {
    const signal = makeSignal(client, opts);
    client.fireConnect('local-actor');
    await flushMicrotasks();
    await signal.ready();
    return signal;
  };

  beforeEach(() => {
    client = makeFakeClient();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('assigns a stable local peer with metadata after ready', async () => {
    const signal = await setup({ metadata: { role: 'host' } });
    expect(signal.localPeer!.peerId).toBeTruthy();
    expect(signal.localPeer!.isLocal).toBe(true);
    expect(signal.localPeer!.metadata).toEqual({ role: 'host' });
    signal.detach();
  });

  it('joinRoom subscribes to the signaling topic and is idempotent', async () => {
    const signal = await setup();
    const room1 = signal.joinRoom('call');
    const room2 = signal.joinRoom('call');

    expect(room1).toBe(room2);
    expect(client.isSubscribed('signal-app/call/signaling')).toBe(true);
    signal.detach();
  });

  it('uses a custom app name for topic prefixes', async () => {
    const signal = await setup({ appName: 'my-app' });
    signal.joinRoom('call');
    expect(client.isSubscribed('my-app/call/signaling')).toBe(true);
    signal.detach();
  });

  it('sendOffer emits a signal message on the signaling topic', async () => {
    const signal = await setup();
    const room = signal.joinRoom('call');
    client.sent = [];
    const offer: RTCSessionDescriptionInit = { type: 'offer', sdp: 'v=0' };
    room.sendOffer('remote-peer', offer);

    const emitted = client.sent.find((s) => s.op === 'emit' && s.topic === 'signal-app/call/signaling');
    expect(emitted).toBeTruthy();
    const msg = emitted!.data as Record<string, unknown>;
    expect(msg.type).toBe('offer');
    expect(msg.toPeerId).toBe('remote-peer');
    expect(msg.payload).toEqual(offer);
    signal.detach();
  });

  it('emits "signal" only for messages targeted at the local peer', async () => {
    const signal = await setup();
    const room = signal.joinRoom('call');
    const onSignal = vi.fn();
    room.on('signal', onSignal);

    client.fireMessage('signal-app/call/signaling', {
      id: 's1', type: 'offer', fromPeerId: 'remote',
      toPeerId: signal.localPeer!.peerId, payload: {}, timestamp: Date.now(),
    }, {});
    client.fireMessage('signal-app/call/signaling', {
      id: 's2', type: 'offer', fromPeerId: 'remote',
      toPeerId: 'someone-else', payload: {}, timestamp: Date.now(),
    }, {});

    expect(onSignal).toHaveBeenCalledTimes(1);
    expect((onSignal.mock.calls[0][0] as { id: string }).id).toBe('s1');
    signal.detach();
  });

  it('routes room presence to all joined rooms and tracks online peers', async () => {
    const signal = await setup();
    const roomA = signal.joinRoom('call-a');
    const roomB = signal.joinRoom('call-b');
    const joinedA = vi.fn();
    const joinedB = vi.fn();
    const online = vi.fn();
    roomA.on('peerJoined', joinedA);
    roomB.on('peerJoined', joinedB);
    signal.on('peerOnline', online);

    client.firePresence('join', {
      actorTokenId: 'actor-remote',
      presence: { peerId: 'p-remote', __scope: 'signal-app' },
    });

    expect(joinedA).toHaveBeenCalledTimes(1);
    expect(joinedB).toHaveBeenCalledTimes(1);
    expect(online).toHaveBeenCalledTimes(1);
    expect(signal.getOnlinePeers().map((p) => p.peerId)).toContain('p-remote');
    signal.detach();
  });

  it('leaveRoom unsubscribes and removes the room', async () => {
    const signal = await setup();
    signal.joinRoom('call');
    client.sent = [];
    signal.leaveRoom('call');

    expect(signal.rooms.size).toBe(0);
    expect(client.sent.some((s) => s.op === 'unsubscribe' && s.topic === 'signal-app/call/signaling')).toBe(true);
    signal.detach();
  });

  it('re-applies room presence on reconnect', async () => {
    const signal = await setup();
    signal.joinRoom('call');
    client.sent = [];

    client.fireConnect('local-actor'); // reconnect
    await flushMicrotasks();

    // Presence re-set for the active room on restore
    expect(client.sent.some((s) => s.op === 'setPresence' && s.topic === 'signal-app/call')).toBe(true);
    signal.detach();
  });
});
