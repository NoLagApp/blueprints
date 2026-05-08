import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DeviceGroup } from '../../src/DeviceGroup';
import type { Device, ResolvedIoTOptions, IoTPresenceData } from '../../src/types';
import type { RoomContext, MessageHandler } from '@nolag/js-sdk';

// Mock RoomContext
function createMockRoomContext(): RoomContext & {
  _handlers: Map<string, MessageHandler>;
  _fireMessage: (topic: string, data: unknown) => void;
} {
  const handlers = new Map<string, MessageHandler>();
  const ctx: any = {
    prefix: 'iot/factory-floor',
    _handlers: handlers,
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
    emit: vi.fn(),
    on: vi.fn((topic: string, handler: MessageHandler) => {
      handlers.set(topic, handler);
      return ctx;
    }),
    off: vi.fn((topic: string) => {
      handlers.delete(topic);
      return ctx;
    }),
    setPresence: vi.fn(),
    getPresence: vi.fn(() => ({})),
    fetchPresence: vi.fn(() => Promise.resolve([])),
    _fireMessage(topic: string, data: unknown) {
      const h = handlers.get(topic);
      if (h) h(data, {});
    },
  };
  return ctx;
}

function createLocalDevice(): Device {
  return {
    deviceId: 'local-device-id',
    actorTokenId: 'local-actor',
    role: 'device',
    joinedAt: Date.now(),
    isLocal: true,
  };
}

function createControllerDevice(): Device {
  return {
    deviceId: 'controller-id',
    actorTokenId: 'controller-actor',
    role: 'controller',
    joinedAt: Date.now(),
    isLocal: true,
  };
}

function createOptions(overrides: Partial<ResolvedIoTOptions> = {}): ResolvedIoTOptions {
  return {
    deviceId: 'local-device-id',
    role: 'device',
    appName: 'iot',
    maxTelemetryPoints: 100,
    commandTimeout: 5000,
    debug: false,
    reconnect: true,
    groups: [],
    ...overrides,
  };
}

const noop = () => {};

describe('DeviceGroup', () => {
  let group: DeviceGroup;
  let ctx: ReturnType<typeof createMockRoomContext>;

  beforeEach(() => {
    vi.useFakeTimers();
    ctx = createMockRoomContext();
    group = new DeviceGroup('factory-floor', ctx, createLocalDevice(), createOptions(), noop);
  });

  afterEach(() => {
    group._cleanup();
    vi.useRealTimers();
  });

  describe('_subscribe', () => {
    it('should subscribe to telemetry, commands, and _cmd_ack topics', () => {
      group._subscribe();
      expect(ctx.subscribe).toHaveBeenCalledWith('telemetry');
      expect(ctx.subscribe).toHaveBeenCalledWith('commands');
      expect(ctx.subscribe).toHaveBeenCalledWith('_cmd_ack');
    });

    it('should register handlers for all three topics', () => {
      group._subscribe();
      expect(ctx.on).toHaveBeenCalledWith('telemetry', expect.any(Function));
      expect(ctx.on).toHaveBeenCalledWith('commands', expect.any(Function));
      expect(ctx.on).toHaveBeenCalledWith('_cmd_ack', expect.any(Function));
    });
  });

  describe('sendTelemetry', () => {
    it('should emit a telemetry reading to the room context', () => {
      group._subscribe();
      group.sendTelemetry('temperature', 22.5, { unit: '°C' });

      expect(ctx.emit).toHaveBeenCalledWith(
        'telemetry',
        expect.objectContaining({
          deviceId: 'local-device-id',
          sensorId: 'temperature',
          value: 22.5,
          unit: '°C',
        }),
        { echo: false },
      );
    });

    it('should return the TelemetryReading', () => {
      group._subscribe();
      const reading = group.sendTelemetry('rpm', 3000);

      expect(reading.deviceId).toBe('local-device-id');
      expect(reading.sensorId).toBe('rpm');
      expect(reading.value).toBe(3000);
      expect(reading.id).toBeDefined();
      expect(reading.isReplay).toBe(false);
    });

    it('should store the reading locally', () => {
      group._subscribe();
      group.sendTelemetry('pressure', 101.3);

      const readings = group.getTelemetry('local-device-id', 'pressure');
      expect(readings.length).toBe(1);
      expect(readings[0].value).toBe(101.3);
    });

    it('should include tags when provided', () => {
      group._subscribe();
      group.sendTelemetry('temp', 20, { tags: { zone: 'A' } });

      expect(ctx.emit).toHaveBeenCalledWith(
        'telemetry',
        expect.objectContaining({ tags: { zone: 'A' } }),
        { echo: false },
      );
    });
  });

  describe('getTelemetry', () => {
    it('should return empty array when no readings', () => {
      expect(group.getTelemetry()).toEqual([]);
    });

    it('should return all stored readings with no filter', () => {
      group._subscribe();
      ctx._fireMessage('telemetry', {
        id: 'r1', deviceId: 'dev-2', sensorId: 'temp', value: 18, timestamp: Date.now(), isReplay: false,
      });
      group.sendTelemetry('humidity', 60);

      expect(group.getTelemetry().length).toBe(2);
    });

    it('should filter by deviceId', () => {
      group._subscribe();
      ctx._fireMessage('telemetry', {
        id: 'r1', deviceId: 'dev-2', sensorId: 'temp', value: 18, timestamp: Date.now(), isReplay: false,
      });
      group.sendTelemetry('temp', 22);

      expect(group.getTelemetry('local-device-id').length).toBe(1);
      expect(group.getTelemetry('dev-2').length).toBe(1);
    });

    it('should filter by deviceId and sensorId', () => {
      group._subscribe();
      group.sendTelemetry('temp', 22);
      group.sendTelemetry('humidity', 60);

      expect(group.getTelemetry('local-device-id', 'temp').length).toBe(1);
      expect(group.getTelemetry('local-device-id', 'humidity').length).toBe(1);
    });
  });

  describe('sendCommand', () => {
    it('should emit a command to the room context', () => {
      group._subscribe();
      group.sendCommand('device-01', 'reboot').catch(() => {});

      expect(ctx.emit).toHaveBeenCalledWith(
        'commands',
        expect.objectContaining({
          targetDeviceId: 'device-01',
          command: 'reboot',
          status: 'pending',
        }),
        { echo: false },
      );
    });

    it('should return a promise', () => {
      group._subscribe();
      const p = group.sendCommand('device-01', 'ping');
      expect(p).toBeInstanceOf(Promise);
      p.catch(() => {});
    });

    it('should reject on timeout', async () => {
      group._subscribe();
      const p = group.sendCommand('device-01', 'slow');

      vi.advanceTimersByTime(6000);

      await expect(p).rejects.toThrow('timed out');
    });
  });

  describe('ackCommand', () => {
    it('should emit a _cmd_ack message to the room context', () => {
      group._subscribe();
      group.ackCommand('cmd-123', 'completed', { ok: true });

      expect(ctx.emit).toHaveBeenCalledWith(
        '_cmd_ack',
        expect.objectContaining({
          commandId: 'cmd-123',
          status: 'completed',
          result: { ok: true },
        }),
        { echo: false },
      );
    });
  });

  describe('incoming telemetry', () => {
    it('should emit "telemetry" event on incoming reading', () => {
      group._subscribe();
      const handler = vi.fn();
      group.on('telemetry', handler);

      ctx._fireMessage('telemetry', {
        id: 'incoming-1',
        deviceId: 'sensor-01',
        sensorId: 'temp',
        value: 25,
        timestamp: Date.now(),
        isReplay: false,
      });

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'incoming-1', sensorId: 'temp', value: 25 }),
      );
    });

    it('should deduplicate incoming readings with same id', () => {
      group._subscribe();
      const handler = vi.fn();
      group.on('telemetry', handler);

      const reading = { id: 'dup', deviceId: 'dev', sensorId: 'temp', value: 10, timestamp: Date.now(), isReplay: false };
      ctx._fireMessage('telemetry', reading);
      ctx._fireMessage('telemetry', reading);

      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('should buffer incoming readings in the telemetry store', () => {
      group._subscribe();
      ctx._fireMessage('telemetry', {
        id: 'buf-1',
        deviceId: 'sensor-01',
        sensorId: 'humidity',
        value: 70,
        timestamp: Date.now(),
        isReplay: false,
      });

      expect(group.getTelemetry('sensor-01', 'humidity').length).toBe(1);
    });
  });

  describe('incoming commands', () => {
    it('should emit "command" event when role is device and command targets local device', () => {
      group._subscribe();
      const handler = vi.fn();
      group.on('command', handler);

      ctx._fireMessage('commands', {
        id: 'cmd-1',
        targetDeviceId: 'local-device-id',
        command: 'reboot',
        status: 'pending',
        sentBy: 'ctrl',
        sentAt: Date.now(),
      });

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'cmd-1', command: 'reboot' }),
      );
    });

    it('should NOT emit "command" if targetDeviceId does not match local device', () => {
      group._subscribe();
      const handler = vi.fn();
      group.on('command', handler);

      ctx._fireMessage('commands', {
        id: 'cmd-2',
        targetDeviceId: 'other-device',
        command: 'reboot',
        status: 'pending',
        sentBy: 'ctrl',
        sentAt: Date.now(),
      });

      expect(handler).not.toHaveBeenCalled();
    });

    it('should NOT emit "command" when role is controller', () => {
      const controllerGroup = new DeviceGroup(
        'factory-floor',
        ctx,
        createControllerDevice(),
        createOptions({ role: 'controller', deviceId: 'controller-id' }),
        noop,
      );
      controllerGroup._subscribe();

      const handler = vi.fn();
      controllerGroup.on('command', handler);

      ctx._fireMessage('commands', {
        id: 'cmd-3',
        targetDeviceId: 'controller-id',
        command: 'ping',
        status: 'pending',
        sentBy: 'ctrl',
        sentAt: Date.now(),
      });

      expect(handler).not.toHaveBeenCalled();
      controllerGroup._cleanup();
    });
  });

  describe('incoming command acks', () => {
    it('should emit "commandAck" when an ack arrives for a known pending command', async () => {
      group._subscribe();
      const ackHandler = vi.fn();
      group.on('commandAck', ackHandler);

      const promise = group.sendCommand('device-01', 'ping');

      // Find the command id that was emitted
      const emittedCmd = (ctx.emit.mock.calls.find(c => c[0] === 'commands') as any)[1];
      const cmdId = emittedCmd.id;

      ctx._fireMessage('_cmd_ack', {
        commandId: cmdId,
        status: 'completed',
        result: { pong: true },
        ackedBy: 'device-01',
        ackedAt: Date.now(),
      });

      await promise;
      expect(ackHandler).toHaveBeenCalledWith(
        expect.objectContaining({ id: cmdId, status: 'completed' }),
      );
    });

    it('should not throw when ack arrives for unknown command', () => {
      group._subscribe();
      expect(() => {
        ctx._fireMessage('_cmd_ack', {
          commandId: 'unknown-cmd',
          status: 'completed',
          ackedBy: 'device-01',
          ackedAt: Date.now(),
        });
      }).not.toThrow();
    });
  });

  describe('presence events', () => {
    it('should emit deviceJoined on _handlePresenceJoin', () => {
      group._subscribe();
      const handler = vi.fn();
      group.on('deviceJoined', handler);

      group._handlePresenceJoin('actor-remote', {
        deviceId: 'sensor-01',
        role: 'device',
      });

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({ deviceId: 'sensor-01', isLocal: false }),
      );
    });

    it('should emit deviceLeft on _handlePresenceLeave', () => {
      group._subscribe();
      const leaveHandler = vi.fn();
      group.on('deviceLeft', leaveHandler);

      group._handlePresenceJoin('actor-remote', { deviceId: 'sensor-01', role: 'device' });
      group._handlePresenceLeave('actor-remote');

      expect(leaveHandler).toHaveBeenCalledWith(
        expect.objectContaining({ deviceId: 'sensor-01' }),
      );
    });

    it('should not emit deviceJoined for self', () => {
      group._subscribe();
      const handler = vi.fn();
      group.on('deviceJoined', handler);

      group._handlePresenceJoin('local-actor', { deviceId: 'local-device-id', role: 'device' });

      expect(handler).not.toHaveBeenCalled();
    });

    it('should not emit deviceLeft for unknown actor', () => {
      group._subscribe();
      const handler = vi.fn();
      group.on('deviceLeft', handler);

      group._handlePresenceLeave('unknown-actor');

      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe('getDevices', () => {
    it('should return empty initially', () => {
      group._subscribe();
      expect(group.getDevices().length).toBe(0);
    });

    it('should return all remote devices', () => {
      group._subscribe();
      group._handlePresenceJoin('actor-1', { deviceId: 'd1', role: 'device' });
      group._handlePresenceJoin('actor-2', { deviceId: 'd2', role: 'controller' });

      expect(group.getDevices().length).toBe(2);
    });
  });

  describe('getDevice', () => {
    it('should return a device by deviceId', () => {
      group._subscribe();
      group._handlePresenceJoin('actor-1', { deviceId: 'd1', role: 'device' });

      expect(group.getDevice('d1')?.actorTokenId).toBe('actor-1');
    });

    it('should return undefined for unknown deviceId', () => {
      expect(group.getDevice('nonexistent')).toBeUndefined();
    });
  });

  describe('_cleanup', () => {
    it('should unsubscribe from all topics', () => {
      group._subscribe();
      group._cleanup();

      expect(ctx.unsubscribe).toHaveBeenCalledWith('telemetry');
      expect(ctx.unsubscribe).toHaveBeenCalledWith('commands');
      expect(ctx.unsubscribe).toHaveBeenCalledWith('_cmd_ack');
    });

    it('should remove all event listeners', () => {
      group._subscribe();
      group.on('telemetry', vi.fn());
      group._cleanup();

      expect(group.listenerCount('telemetry')).toBe(0);
    });

    it('should dispose pending commands (reject them)', async () => {
      group._subscribe();
      const p = group.sendCommand('dev', 'slow');
      group._cleanup();

      await expect(p).rejects.toThrow();
    });
  });
});
