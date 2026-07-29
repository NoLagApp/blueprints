import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NoLagQueue } from '../../src/NoLagQueue';
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

function workerSnapshot(workerId: string, scope?: string) {
  return {
    presence: {
      workerId,
      role: 'worker',
      activeJobs: 0,
      concurrency: 1,
      ...(scope ? { __scope: scope } : {}),
    },
  };
}

function makeQueue(client: FakeNoLagClient, opts: Record<string, unknown> = {}) {
  return new NoLagQueue({
    client: client as never,
    appName: 'queue-app',
    ...opts,
  });
}

describe('NoLagQueue (client injection)', () => {
  let client: FakeNoLagClient;

  beforeEach(() => {
    client = makeFakeClient();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('throws without an injected client', () => {
    expect(() => new NoLagQueue({} as never)).toThrow(TypeError);
  });

  it('sets up after the client connects and resolves ready()', async () => {
    const queue = makeQueue(client);
    const connected = vi.fn();
    queue.on('connected', connected);

    expect(queue.localWorker).toBeNull();

    client.fireConnect('actor-1');
    await flushMicrotasks();

    await queue.ready();
    expect(connected).toHaveBeenCalledTimes(1);
    expect(queue.localWorker?.actorTokenId).toBe('actor-1');
    expect(queue.localWorker?.isLocal).toBe(true);
    queue.detach();
  });

  it('attach-to-connected: runs setup via microtask when the client is already live', async () => {
    client.fireConnect('actor-early');
    const queue = makeQueue(client);
    const connected = vi.fn();
    queue.on('connected', connected); // wired synchronously, before the microtask

    await flushMicrotasks();
    await queue.ready();

    expect(connected).toHaveBeenCalledTimes(1);
    expect(queue.localWorker?.actorTokenId).toBe('actor-early');
    queue.detach();
  });

  it('runs setup once per epoch: reconnects emit reconnected, not connected', async () => {
    const queue = makeQueue(client);
    const connected = vi.fn();
    const reconnected = vi.fn();
    queue.on('connected', connected);
    queue.on('reconnected', reconnected);

    client.fireConnect();
    await flushMicrotasks();
    client.fireConnect(); // reconnect: core fires 'connect' again
    await flushMicrotasks();

    expect(connected).toHaveBeenCalledTimes(1);
    expect(reconnected).toHaveBeenCalledTimes(1);
    queue.detach();
  });

  it('emits reconnecting when the core fires reconnect', async () => {
    const queue = makeQueue(client);
    const reconnecting = vi.fn();
    queue.on('reconnecting', reconnecting);

    client.fireConnect();
    await flushMicrotasks();
    client.fireReconnect();

    expect(reconnecting).toHaveBeenCalledTimes(1);
    queue.detach();
  });

  it('diff-hydrates online workers across reconnects', async () => {
    client.lobbySnapshot = {
      room1: { actorA: workerSnapshot('worker-a'), actorB: workerSnapshot('worker-b') },
    };
    const queue = makeQueue(client);
    const online = vi.fn();
    const offline = vi.fn();
    queue.on('workerOnline', online);
    queue.on('workerOffline', offline);

    client.fireConnect();
    await flushMicrotasks();
    expect(online).toHaveBeenCalledTimes(2);
    expect(queue.getOnlineWorkers().map((w) => w.workerId).sort()).toEqual(['worker-a', 'worker-b']);

    // Reconnect with A gone and C new: exactly one offline + one online
    client.lobbySnapshot = {
      room1: { actorB: workerSnapshot('worker-b'), actorC: workerSnapshot('worker-c') },
    };
    client.fireConnect();
    await flushMicrotasks();

    expect(offline).toHaveBeenCalledTimes(1);
    expect(offline.mock.calls[0][0].workerId).toBe('worker-a');
    expect(online).toHaveBeenCalledTimes(3);
    expect(queue.getOnlineWorkers().map((w) => w.workerId).sort()).toEqual(['worker-b', 'worker-c']);
    queue.detach();
  });

  it('LEAK TEST: detaching one wrapper leaves a co-attached wrapper fully intact', async () => {
    const queueA = makeQueue(client, { appName: 'app-a', role: 'worker' });
    const queueB = makeQueue(client, { appName: 'app-b', role: 'worker' });

    client.fireConnect();
    await flushMicrotasks();
    await queueA.ready();
    await queueB.ready();

    queueA.joinQueue('image-processing');
    queueB.joinQueue('image-processing');

    const bTopicHandlers = client.handlerCount('app-b/image-processing/jobs');
    const bConnectHandlersBefore = client.handlerCount('connect');
    expect(bTopicHandlers).toBeGreaterThan(0);

    queueA.detach();

    // B's topic handlers and lifecycle handlers are untouched
    expect(client.handlerCount('app-b/image-processing/jobs')).toBe(bTopicHandlers);
    expect(client.handlerCount('connect')).toBe(bConnectHandlersBefore - 1);
    // A's topic handlers and subscriptions are gone
    expect(client.handlerCount('app-a/image-processing/jobs')).toBe(0);
    expect(client.isSubscribed('app-a/image-processing/jobs')).toBe(false);
    expect(client.isSubscribed('app-b/image-processing/jobs')).toBe(true);

    // B still receives jobs
    const room = queueB.queues.get('image-processing')!;
    const onJobAdded = vi.fn();
    room.on('jobAdded', onJobAdded);
    const now = Date.now();
    client.fireMessage('app-b/image-processing/jobs', {
      event: 'jobAdded',
      job: {
        id: 'j1', type: 'resize', status: 'pending', priority: 'normal', progress: 0,
        attempts: 0, maxAttempts: 3, createdBy: 'remote', createdAt: now, updatedAt: now, isReplay: false,
      },
    }, {});
    expect(onJobAdded).toHaveBeenCalledTimes(1);
    queueB.detach();
  });

  it('detach while disconnected skips server unsubscribes and removes handlers', async () => {
    const queue = makeQueue(client, { role: 'worker' });
    client.fireConnect();
    await flushMicrotasks();
    queue.joinQueue('image-processing');

    client.fireDisconnect();
    client.sent = [];
    queue.detach();

    expect(client.sent.filter((s) => s.op === 'unsubscribe')).toEqual([]);
    expect(client.sent.filter((s) => s.op === 'lobbyUnsubscribe')).toEqual([]);
    expect(client.handledEvents()).toEqual([]);
  });

  it('double detach is a no-op and public methods throw after detach', async () => {
    const queue = makeQueue(client);
    client.fireConnect();
    await flushMicrotasks();

    queue.detach();
    expect(() => queue.detach()).not.toThrow();
    expect(() => queue.joinQueue('x')).toThrow(/detached/);
  });

  it('ready() rejects when detached before ready and joinQueue guards pre-ready', async () => {
    const queue = makeQueue(client);
    expect(() => queue.joinQueue('x')).toThrow(/not ready/);

    const readyPromise = queue.ready();
    queue.detach();
    await expect(readyPromise).rejects.toThrow(/detached before ready/);
  });

  it('filters presence tagged with another app scope, accepts own and untagged', async () => {
    const queue = makeQueue(client);
    const online = vi.fn();
    queue.on('workerOnline', online);
    client.fireConnect();
    await flushMicrotasks();

    client.fireLobby('join', { actorId: 'actor-own', data: { workerId: 'w1', role: 'worker', __scope: 'queue-app' } });
    client.fireLobby('join', { actorId: 'actor-foreign', data: { workerId: 'w2', role: 'worker', __scope: 'other-app' } });
    client.fireLobby('join', { actorId: 'actor-untagged', data: { workerId: 'w3', role: 'worker' } });

    expect(online).toHaveBeenCalledTimes(2);
    expect(queue.getOnlineWorkers().map((w) => w.workerId).sort()).toEqual(['w1', 'w3']);
    queue.detach();
  });

  it('runs the deferred lobby refresh and cancels it on detach', async () => {
    vi.useFakeTimers();
    const queue = makeQueue(client);
    client.fireConnect();
    await flushMicrotasks();

    client.sent = [];
    await vi.advanceTimersByTimeAsync(2000);
    expect(client.sent.some((s) => s.op === 'lobbyFetchPresence')).toBe(true);

    // A new wrapper's pending refresh dies with detach
    const queue2 = makeQueue(client, { appName: 'queue-app-2' });
    client.fireConnect();
    await flushMicrotasks();
    client.sent = [];
    queue2.detach();
    await vi.advanceTimersByTimeAsync(5000);
    expect(client.sent.filter((s) => s.op === 'lobbyFetchPresence' && s.topic?.startsWith('queue-app-2'))).toEqual([]);

    queue.detach();
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

    const queue = makeQueue(client);
    const connected = vi.fn();
    queue.on('connected', connected);

    client.fireConnect(); // epoch 1: hangs in lobby subscribe
    await flushMicrotasks();
    client.fireConnect(); // epoch 2: completes normally
    await flushMicrotasks();
    resolveFirst!({}); // epoch 1 resumes, must abort silently
    await flushMicrotasks();

    // Ready resolved exactly once, via epoch 2
    await queue.ready();
    expect(connected).toHaveBeenCalledTimes(1);
    queue.detach();
  });
});

describe('NoLagQueue (domain behavior)', () => {
  let client: FakeNoLagClient;

  beforeEach(() => {
    client = makeFakeClient();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function connected(opts: Record<string, unknown> = {}) {
    const queue = makeQueue(client, opts);
    client.fireConnect('actor-local');
    await flushMicrotasks();
    await queue.ready();
    return queue;
  }

  it('builds a local worker with role, concurrency, and metadata', async () => {
    const queue = await connected({ role: 'worker', concurrency: 4, metadata: { env: 'prod' } });
    expect(queue.localWorker!.role).toBe('worker');
    expect(queue.localWorker!.concurrency).toBe(4);
    expect(queue.localWorker!.metadata).toEqual({ env: 'prod' });
    queue.detach();
  });

  it('defaults role to monitor and concurrency to 1', async () => {
    const queue = await connected();
    expect(queue.localWorker!.role).toBe('monitor');
    expect(queue.localWorker!.concurrency).toBe(1);
    queue.detach();
  });

  it('uses a stable workerId when provided, auto-generates otherwise', async () => {
    const withId = await connected({ workerId: 'my-stable-id' });
    expect(withId.localWorker!.workerId).toBe('my-stable-id');
    withId.detach();

    const client2 = makeFakeClient();
    const auto = new NoLagQueue({ client: client2 as never, appName: 'queue-app' });
    client2.fireConnect('actor-x');
    await flushMicrotasks();
    await auto.ready();
    expect(auto.localWorker!.workerId).toBeTruthy();
    auto.detach();
  });

  it('joins a queue and returns it (idempotent)', async () => {
    const queue = await connected();
    const a = queue.joinQueue('image-processing');
    const b = queue.joinQueue('image-processing');
    expect(a).toBe(b);
    expect(a.name).toBe('image-processing');
    expect(queue.queues.size).toBe(1);
    queue.detach();
  });

  it('subscribes to jobs and _progress topics on join', async () => {
    const queue = await connected({ appName: 'queue-app' });
    queue.joinQueue('image-processing');
    expect(client.isSubscribed('queue-app/image-processing/jobs')).toBe(true);
    expect(client.isSubscribed('queue-app/image-processing/_progress')).toBe(true);
    queue.detach();
  });

  // The `loadBalanceGroup` is a SUBSCRIBE-level domain option: it must flow
  // into the room's jobs-topic subscribe for workers. The canonical fake's
  // room-context subscribe drops the options arg (it only records the topic),
  // so we intercept the options on the way through setRoom().
  function captureJobsSubscribeOptions(): Array<[string, unknown]> {
    const calls: Array<[string, unknown]> = [];
    const origSetApp = client.setApp.bind(client);
    (client as { setApp: typeof client.setApp }).setApp = (appName: string) => {
      const ctx = origSetApp(appName);
      const origSetRoom = ctx.setRoom.bind(ctx);
      ctx.setRoom = (roomName: string) => {
        const room = origSetRoom(roomName);
        const origSubscribe = room.subscribe.bind(room);
        room.subscribe = (topic: string, options?: unknown) => {
          calls.push([topic, options]);
          return origSubscribe(topic);
        };
        return room;
      };
      return ctx;
    };
    return calls;
  }

  it('workers subscribe to jobs with load balancing; the group flows into the subscribe', async () => {
    const calls = captureJobsSubscribeOptions();
    const queue = await connected({ appName: 'queue-app', role: 'worker', loadBalanceGroup: 'gpu-pool' });
    queue.joinQueue('image-processing');

    const jobsCall = calls.find(([topic]) => topic === 'jobs');
    expect(jobsCall).toBeDefined();
    expect(jobsCall![1]).toEqual({ loadBalance: true, loadBalanceGroup: 'gpu-pool' });
    queue.detach();
  });

  it('workers default to a per-queue load balance group when none is given', async () => {
    const calls = captureJobsSubscribeOptions();
    const queue = await connected({ appName: 'queue-app', role: 'worker' });
    queue.joinQueue('image-processing');

    const jobsCall = calls.find(([topic]) => topic === 'jobs');
    expect(jobsCall![1]).toEqual({
      loadBalance: true,
      loadBalanceGroup: 'queue-workers-image-processing',
    });
    queue.detach();
  });

  it('non-worker roles subscribe to jobs without load balancing', async () => {
    const calls = captureJobsSubscribeOptions();
    const queue = await connected({ appName: 'queue-app', role: 'monitor' });
    queue.joinQueue('image-processing');

    const jobsCall = calls.find(([topic]) => topic === 'jobs');
    expect(jobsCall).toBeDefined();
    expect(jobsCall![1]).toBeUndefined();
    queue.detach();
  });

  it('pre-subscribes configured queues on first setup', async () => {
    const queue = await connected({ appName: 'queue-app', queues: ['a', 'b'] });
    expect(queue.queues.size).toBe(2);
    expect(client.isSubscribed('queue-app/a/jobs')).toBe(true);
    expect(client.isSubscribed('queue-app/b/jobs')).toBe(true);
    queue.detach();
  });

  it('runs the full job lifecycle end-to-end', async () => {
    const queue = await connected({ role: 'worker' });
    const room = queue.joinQueue('image-processing');

    const added = vi.fn();
    const claimed = vi.fn();
    const progress = vi.fn();
    const completed = vi.fn();
    room.on('jobAdded', added);
    room.on('jobClaimed', claimed);
    room.on('jobProgress', progress);
    room.on('jobCompleted', completed);

    const job = room.addJob({ type: 'resize', priority: 'high' });
    expect(job.status).toBe('pending');
    expect(added).toHaveBeenCalledTimes(1);

    const claim = room.claimJob(job.id);
    expect(claim!.status).toBe('claimed');
    expect(claim!.claimedBy).toBe(queue.localWorker!.workerId);
    expect(claimed).toHaveBeenCalledTimes(1);

    room.reportProgress(job.id, 50);
    expect(room.getJob(job.id)!.progress).toBe(50);
    expect(progress).toHaveBeenCalledTimes(1);

    const done = room.completeJob(job.id, { output: 'thumb.jpg' });
    expect(done!.status).toBe('completed');
    expect(done!.result).toEqual({ output: 'thumb.jpg' });
    expect(completed).toHaveBeenCalledTimes(1);
    queue.detach();
  });

  it('auto-retries a failed job under maxAttempts and stops at the limit', async () => {
    const queue = await connected({ role: 'worker' });
    const room = queue.joinQueue('image-processing');

    const retrying = vi.fn();
    room.on('jobRetrying', retrying);

    const job = room.addJob({ type: 'resize', maxAttempts: 2 });
    room.claimJob(job.id);
    room.failJob(job.id, 'transient');
    expect(retrying).toHaveBeenCalledTimes(1); // attempt 1 < 2 → retry

    const noRetry = room.addJob({ type: 'resize', maxAttempts: 1 });
    room.claimJob(noRetry.id);
    room.failJob(noRetry.id, 'permanent');
    expect(retrying).toHaveBeenCalledTimes(1); // no further retry
    queue.detach();
  });

  it('deduplicates jobs received twice on the wire', async () => {
    const queue = await connected({ appName: 'queue-app', role: 'worker' });
    const room = queue.joinQueue('image-processing');
    const added = vi.fn();
    room.on('jobAdded', added);

    const now = Date.now();
    const msg = {
      event: 'jobAdded',
      job: {
        id: 'remote-j1', type: 'resize', status: 'pending', priority: 'normal', progress: 0,
        attempts: 0, maxAttempts: 3, createdBy: 'remote', createdAt: now, updatedAt: now, isReplay: false,
      },
    };
    client.fireMessage('queue-app/image-processing/jobs', msg, {});
    client.fireMessage('queue-app/image-processing/jobs', msg, {});

    expect(added).toHaveBeenCalledTimes(1);
    expect(room.getJobs().length).toBe(1);
    queue.detach();
  });

  it('tracks online workers via lobby join/leave and routes room presence to rooms', async () => {
    const queue = await connected({ appName: 'queue-app' });
    const room = queue.joinQueue('image-processing');
    const online = vi.fn();
    const offline = vi.fn();
    const joined = vi.fn();
    const left = vi.fn();
    queue.on('workerOnline', online);
    queue.on('workerOffline', offline);
    room.on('workerJoined', joined);
    room.on('workerLeft', left);

    const presence = { workerId: 'remote-w1', role: 'worker', activeJobs: 0, concurrency: 2, __scope: 'queue-app' };
    client.fireLobby('join', { actorId: 'actor-remote', data: presence });
    expect(online).toHaveBeenCalledTimes(1);

    client.firePresence('join', { actorTokenId: 'actor-remote', presence });
    expect(joined).toHaveBeenCalledTimes(1);

    client.firePresence('leave', { actorTokenId: 'actor-remote', presence });
    expect(left).toHaveBeenCalledTimes(1);

    client.fireLobby('leave', { actorId: 'actor-remote', data: presence });
    expect(offline).toHaveBeenCalledTimes(1);
    queue.detach();
  });

  it('leaveQueue unsubscribes and removes the room', async () => {
    const queue = await connected({ appName: 'queue-app' });
    queue.joinQueue('image-processing');
    queue.leaveQueue('image-processing');

    expect(queue.queues.size).toBe(0);
    expect(client.isSubscribed('queue-app/image-processing/jobs')).toBe(false);
    queue.detach();
  });

  it('stamps room presence with the app scope', async () => {
    const queue = await connected({ appName: 'queue-app', role: 'worker' });
    queue.joinQueue('image-processing');

    const presenceCall = client.sent.find((s) => s.op === 'setPresence');
    expect(presenceCall).toBeDefined();
    expect((presenceCall!.data as Record<string, unknown>).__scope).toBe('queue-app');
    queue.detach();
  });
});
