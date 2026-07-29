import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NoLagIoT } from '../../src/NoLagIoT';
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

function deviceSnapshot(deviceId: string, scope?: string) {
  return {
    presence: {
      deviceId,
      role: 'device',
      ...(scope ? { __scope: scope } : {}),
    },
  };
}

function makeIoT(client: FakeNoLagClient, opts: Record<string, unknown> = {}) {
  return new NoLagIoT({
    client: client as never,
    appName: 'iot-app',
    ...opts,
  });
}

describe('NoLagIoT (client injection)', () => {
  let client: FakeNoLagClient;

  beforeEach(() => {
    client = makeFakeClient();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('throws without an injected client', () => {
    expect(() => new NoLagIoT({} as never)).toThrow(TypeError);
  });

  it('sets up after the client connects and resolves ready()', async () => {
    const iot = makeIoT(client);
    const connected = vi.fn();
    iot.on('connected', connected);

    expect(iot.localDevice).toBeNull();

    client.fireConnect('actor-1');
    await flushMicrotasks();

    await iot.ready();
    expect(connected).toHaveBeenCalledTimes(1);
    expect(iot.localDevice?.actorTokenId).toBe('actor-1');
    expect(iot.localDevice?.isLocal).toBe(true);
    iot.detach();
  });

  it('attach-to-connected: runs setup via microtask when the client is already live', async () => {
    client.fireConnect('actor-early');
    const iot = makeIoT(client);
    const connected = vi.fn();
    iot.on('connected', connected); // wired synchronously, before the microtask

    await flushMicrotasks();
    await iot.ready();

    expect(connected).toHaveBeenCalledTimes(1);
    expect(iot.localDevice?.actorTokenId).toBe('actor-early');
    iot.detach();
  });

  it('runs setup once per epoch: reconnects emit reconnected, not connected', async () => {
    const iot = makeIoT(client);
    const connected = vi.fn();
    const reconnected = vi.fn();
    iot.on('connected', connected);
    iot.on('reconnected', reconnected);

    client.fireConnect();
    await flushMicrotasks();
    client.fireConnect(); // reconnect: core fires 'connect' again
    await flushMicrotasks();

    expect(connected).toHaveBeenCalledTimes(1);
    expect(reconnected).toHaveBeenCalledTimes(1);
    iot.detach();
  });

  it('emits reconnecting when the core fires reconnect', async () => {
    const iot = makeIoT(client);
    const reconnecting = vi.fn();
    iot.on('reconnecting', reconnecting);

    client.fireConnect();
    await flushMicrotasks();
    client.fireReconnect();

    expect(reconnecting).toHaveBeenCalledTimes(1);
    iot.detach();
  });

  it('diff-hydrates online devices across reconnects', async () => {
    client.lobbySnapshot = {
      room1: { actorA: deviceSnapshot('device-a'), actorB: deviceSnapshot('device-b') },
    };
    const iot = makeIoT(client);
    const online = vi.fn();
    const offline = vi.fn();
    iot.on('deviceOnline', online);
    iot.on('deviceOffline', offline);

    client.fireConnect();
    await flushMicrotasks();
    expect(online).toHaveBeenCalledTimes(2);
    expect(iot.getOnlineDevices().map((d) => d.deviceId).sort()).toEqual(['device-a', 'device-b']);

    // Reconnect with A gone and C new: exactly one offline + one online
    client.lobbySnapshot = {
      room1: { actorB: deviceSnapshot('device-b'), actorC: deviceSnapshot('device-c') },
    };
    client.fireConnect();
    await flushMicrotasks();

    expect(offline).toHaveBeenCalledTimes(1);
    expect(offline.mock.calls[0][0].deviceId).toBe('device-a');
    expect(online).toHaveBeenCalledTimes(3);
    expect(iot.getOnlineDevices().map((d) => d.deviceId).sort()).toEqual(['device-b', 'device-c']);
    iot.detach();
  });

  it('LEAK TEST: detaching one wrapper leaves a co-attached wrapper fully intact', async () => {
    const iotA = makeIoT(client, { appName: 'app-a', deviceId: 'dev-a' });
    const iotB = makeIoT(client, { appName: 'app-b', deviceId: 'dev-b' });

    client.fireConnect();
    await flushMicrotasks();
    await iotA.ready();
    await iotB.ready();

    iotA.joinGroup('factory-floor');
    iotB.joinGroup('factory-floor');

    const bTopicHandlers = client.handlerCount('app-b/factory-floor/telemetry');
    const bConnectHandlersBefore = client.handlerCount('connect');
    expect(bTopicHandlers).toBeGreaterThan(0);

    iotA.detach();

    // B's topic handlers and lifecycle handlers are untouched
    expect(client.handlerCount('app-b/factory-floor/telemetry')).toBe(bTopicHandlers);
    expect(client.handlerCount('connect')).toBe(bConnectHandlersBefore - 1);
    // A's topic handlers and subscriptions are gone
    expect(client.handlerCount('app-a/factory-floor/telemetry')).toBe(0);
    expect(client.isSubscribed('app-a/factory-floor/telemetry')).toBe(false);
    expect(client.isSubscribed('app-b/factory-floor/telemetry')).toBe(true);

    // B still receives telemetry
    const group = iotB.groups.get('factory-floor')!;
    const onTelemetry = vi.fn();
    group.on('telemetry', onTelemetry);
    client.fireMessage('app-b/factory-floor/telemetry', {
      id: 't1', deviceId: 'sensor-x', sensorId: 'temp', value: 21, timestamp: Date.now(), isReplay: false,
    }, {});
    expect(onTelemetry).toHaveBeenCalledTimes(1);
    iotB.detach();
  });

  it('detach while disconnected skips server unsubscribes and removes handlers', async () => {
    const iot = makeIoT(client);
    client.fireConnect();
    await flushMicrotasks();
    iot.joinGroup('factory-floor');

    client.fireDisconnect();
    client.sent = [];
    iot.detach();

    expect(client.sent.filter((s) => s.op === 'unsubscribe')).toEqual([]);
    expect(client.sent.filter((s) => s.op === 'lobbyUnsubscribe')).toEqual([]);
    expect(client.handledEvents()).toEqual([]);
  });

  it('double detach is a no-op and public methods throw after detach', async () => {
    const iot = makeIoT(client);
    client.fireConnect();
    await flushMicrotasks();

    iot.detach();
    expect(() => iot.detach()).not.toThrow();
    expect(() => iot.joinGroup('x')).toThrow(/detached/);
  });

  it('ready() rejects when detached before ready and joinGroup guards pre-ready', async () => {
    const iot = makeIoT(client);
    expect(() => iot.joinGroup('x')).toThrow(/not ready/);

    const readyPromise = iot.ready();
    iot.detach();
    await expect(readyPromise).rejects.toThrow(/detached before ready/);
  });

  it('detach rejects pending command promises via command-timeout disposal', async () => {
    const iot = makeIoT(client, { role: 'controller', commandTimeout: 5000 });
    client.fireConnect();
    await flushMicrotasks();
    await iot.ready();

    const group = iot.joinGroup('factory-floor');
    const p = group.sendCommand('device-01', 'reboot');

    iot.detach();

    await expect(p).rejects.toThrow();
  });

  it('filters presence tagged with another app scope, accepts own and untagged', async () => {
    const iot = makeIoT(client);
    const online = vi.fn();
    iot.on('deviceOnline', online);
    client.fireConnect();
    await flushMicrotasks();

    client.fireLobby('join', { actorId: 'actor-own', data: { deviceId: 'd1', role: 'device', __scope: 'iot-app' } });
    client.fireLobby('join', { actorId: 'actor-foreign', data: { deviceId: 'd2', role: 'device', __scope: 'other-app' } });
    client.fireLobby('join', { actorId: 'actor-untagged', data: { deviceId: 'd3', role: 'device' } });

    expect(online).toHaveBeenCalledTimes(2);
    expect(iot.getOnlineDevices().map((d) => d.deviceId).sort()).toEqual(['d1', 'd3']);
    iot.detach();
  });

  it('runs the deferred lobby refresh and cancels it on detach', async () => {
    vi.useFakeTimers();
    const iot = makeIoT(client);
    client.fireConnect();
    await flushMicrotasks();

    client.sent = [];
    await vi.advanceTimersByTimeAsync(2000);
    expect(client.sent.some((s) => s.op === 'lobbyFetchPresence')).toBe(true);

    // A new wrapper's pending refresh dies with detach
    const iot2 = makeIoT(client, { appName: 'iot-app-2' });
    client.fireConnect();
    await flushMicrotasks();
    client.sent = [];
    iot2.detach();
    await vi.advanceTimersByTimeAsync(5000);
    expect(client.sent.filter((s) => s.op === 'lobbyFetchPresence' && s.topic?.startsWith('iot-app-2'))).toEqual([]);

    iot.detach();
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

    const iot = makeIoT(client);
    const connected = vi.fn();
    iot.on('connected', connected);

    client.fireConnect(); // epoch 1: hangs in lobby subscribe
    await flushMicrotasks();
    client.fireConnect(); // epoch 2: completes normally
    await flushMicrotasks();
    resolveFirst!({}); // epoch 1 resumes, must abort silently
    await flushMicrotasks();

    // Ready resolved exactly once, via epoch 2
    await iot.ready();
    expect(connected).toHaveBeenCalledTimes(1);
    iot.detach();
  });
});

describe('NoLagIoT (domain behavior)', () => {
  let client: FakeNoLagClient;

  beforeEach(() => {
    client = makeFakeClient();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function connected(opts: Record<string, unknown> = {}) {
    const iot = makeIoT(client, opts);
    client.fireConnect('actor-local');
    await flushMicrotasks();
    await iot.ready();
    return iot;
  }

  it('builds a local device with role, deviceName, and metadata', async () => {
    const iot = await connected({
      role: 'controller',
      deviceName: 'Temperature Sensor A',
      metadata: { location: 'factory-A' },
    });
    expect(iot.localDevice!.role).toBe('controller');
    expect(iot.localDevice!.deviceName).toBe('Temperature Sensor A');
    expect(iot.localDevice!.metadata).toEqual({ location: 'factory-A' });
    iot.detach();
  });

  it('defaults role to device', async () => {
    const iot = await connected();
    expect(iot.localDevice!.role).toBe('device');
    iot.detach();
  });

  it('uses a stable deviceId when provided, auto-generates otherwise', async () => {
    const withId = await connected({ deviceId: 'my-sensor-01' });
    expect(withId.localDevice!.deviceId).toBe('my-sensor-01');
    withId.detach();

    const client2 = makeFakeClient();
    const auto = new NoLagIoT({ client: client2 as never, appName: 'iot-app' });
    client2.fireConnect('actor-x');
    await flushMicrotasks();
    await auto.ready();
    expect(auto.localDevice!.deviceId).toBeTruthy();
    auto.detach();
  });

  it('joins a group and returns it (idempotent)', async () => {
    const iot = await connected();
    const a = iot.joinGroup('factory-floor');
    const b = iot.joinGroup('factory-floor');
    expect(a).toBe(b);
    expect(a.name).toBe('factory-floor');
    expect(iot.groups.size).toBe(1);
    iot.detach();
  });

  it('subscribes to telemetry, commands and _cmd_ack topics on join', async () => {
    const iot = await connected({ appName: 'iot-app' });
    iot.joinGroup('factory-floor');
    expect(client.isSubscribed('iot-app/factory-floor/telemetry')).toBe(true);
    expect(client.isSubscribed('iot-app/factory-floor/commands')).toBe(true);
    expect(client.isSubscribed('iot-app/factory-floor/_cmd_ack')).toBe(true);
    iot.detach();
  });

  it('pre-joins configured groups on first setup', async () => {
    const iot = await connected({ appName: 'iot-app', groups: ['a', 'b'] });
    expect(iot.groups.size).toBe(2);
    expect(client.isSubscribed('iot-app/a/telemetry')).toBe(true);
    expect(client.isSubscribed('iot-app/b/telemetry')).toBe(true);
    iot.detach();
  });

  it('runs the full command dispatch + ack lifecycle end-to-end', async () => {
    const iot = await connected({ appName: 'iot-app', role: 'controller' });
    const group = iot.joinGroup('factory-floor');

    const ackHandler = vi.fn();
    group.on('commandAck', ackHandler);

    const promise = group.sendCommand('device-01', 'ping');

    // Find the command id that was emitted on the commands topic
    const emitted = client.sent.find((s) => s.op === 'emit' && s.topic === 'iot-app/factory-floor/commands');
    expect(emitted).toBeDefined();
    const cmdId = (emitted!.data as { id: string }).id;

    client.fireMessage('iot-app/factory-floor/_cmd_ack', {
      commandId: cmdId,
      status: 'completed',
      result: { pong: true },
      ackedBy: 'device-01',
      ackedAt: Date.now(),
    }, {});

    const settled = await promise;
    expect(settled.status).toBe('completed');
    expect(ackHandler).toHaveBeenCalledWith(expect.objectContaining({ id: cmdId, status: 'completed' }));
    iot.detach();
  });

  it('streams telemetry and buffers it locally, deduplicating on the wire', async () => {
    const iot = await connected({ appName: 'iot-app' });
    const group = iot.joinGroup('factory-floor');
    const telemetry = vi.fn();
    group.on('telemetry', telemetry);

    const reading = {
      id: 'r-remote', deviceId: 'sensor-02', sensorId: 'temp', value: 18,
      timestamp: Date.now(), isReplay: false,
    };
    client.fireMessage('iot-app/factory-floor/telemetry', reading, {});
    client.fireMessage('iot-app/factory-floor/telemetry', reading, {});

    expect(telemetry).toHaveBeenCalledTimes(1);
    expect(group.getTelemetry('sensor-02', 'temp').length).toBe(1);
    iot.detach();
  });

  it('tracks online devices via lobby join/leave and routes room presence to groups', async () => {
    const iot = await connected({ appName: 'iot-app' });
    const group = iot.joinGroup('factory-floor');
    const online = vi.fn();
    const offline = vi.fn();
    const joined = vi.fn();
    const left = vi.fn();
    iot.on('deviceOnline', online);
    iot.on('deviceOffline', offline);
    group.on('deviceJoined', joined);
    group.on('deviceLeft', left);

    const presence = { deviceId: 'remote-d1', role: 'device', __scope: 'iot-app' };
    client.fireLobby('join', { actorId: 'actor-remote', data: presence });
    expect(online).toHaveBeenCalledTimes(1);

    client.firePresence('join', { actorTokenId: 'actor-remote', presence });
    expect(joined).toHaveBeenCalledTimes(1);

    client.firePresence('leave', { actorTokenId: 'actor-remote', presence });
    expect(left).toHaveBeenCalledTimes(1);

    client.fireLobby('leave', { actorId: 'actor-remote', data: presence });
    expect(offline).toHaveBeenCalledTimes(1);
    iot.detach();
  });

  it('leaveGroup unsubscribes and removes the group', async () => {
    const iot = await connected({ appName: 'iot-app' });
    iot.joinGroup('factory-floor');
    iot.leaveGroup('factory-floor');

    expect(iot.groups.size).toBe(0);
    expect(client.isSubscribed('iot-app/factory-floor/telemetry')).toBe(false);
    iot.detach();
  });

  it('re-applies presence across groups after a reconnect (persistent presence)', async () => {
    const iot = await connected({ appName: 'iot-app' });
    iot.joinGroup('factory-floor');

    // Clear the setPresence record from the initial activate
    const presenceBefore = client.sent.filter((s) => s.op === 'setPresence').length;
    expect(presenceBefore).toBeGreaterThan(0);

    client.sent = [];
    client.fireConnect(); // reconnect
    await flushMicrotasks();

    const presenceAfter = client.sent.filter((s) => s.op === 'setPresence');
    expect(presenceAfter.length).toBeGreaterThan(0);
    iot.detach();
  });

  it('stamps group presence with the app scope', async () => {
    const iot = await connected({ appName: 'iot-app' });
    iot.joinGroup('factory-floor');

    const presenceCall = client.sent.find((s) => s.op === 'setPresence');
    expect(presenceCall).toBeDefined();
    expect((presenceCall!.data as Record<string, unknown>).__scope).toBe('iot-app');
    iot.detach();
  });

  it('getOnlineDevices returns empty before connect', () => {
    const iot = makeIoT(client);
    expect(iot.getOnlineDevices()).toEqual([]);
    iot.detach();
  });
});
