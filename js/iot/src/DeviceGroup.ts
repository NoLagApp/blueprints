import type { RoomContext } from '@nolag/js-sdk';
import { EventEmitter } from './EventEmitter';
import { PresenceManager } from './PresenceManager';
import { TelemetryStore } from './TelemetryStore';
import { CommandManager } from './CommandManager';
import { generateId } from './utils';
import { TOPIC_TELEMETRY, TOPIC_COMMANDS, TOPIC_CMD_ACK } from './constants';
import type {
  DeviceGroupEvents,
  TelemetryReading,
  SendTelemetryOptions,
  DeviceCommand,
  Device,
  IoTPresenceData,
  ResolvedIoTOptions,
  CommandStatus,
} from './types';

/**
 * DeviceGroup — a single IoT group for telemetry streaming and command dispatch.
 *
 * Created via `NoLagIoT.joinGroup(name)`. Do not instantiate directly.
 */
export class DeviceGroup extends EventEmitter<DeviceGroupEvents> {
  /** Group name */
  readonly name: string;

  private _roomContext: RoomContext;
  private _localDevice: Device;
  private _options: ResolvedIoTOptions;
  private _presenceManager: PresenceManager;
  private _telemetryStore: TelemetryStore;
  private _commandManager: CommandManager;
  private _log: (...args: unknown[]) => void;

  /** @internal */
  constructor(
    name: string,
    roomContext: RoomContext,
    localDevice: Device,
    options: ResolvedIoTOptions,
    log: (...args: unknown[]) => void,
  ) {
    super();
    this.name = name;
    this._roomContext = roomContext;
    this._localDevice = localDevice;
    this._options = options;
    this._log = log;

    this._presenceManager = new PresenceManager(localDevice.actorTokenId);
    this._telemetryStore = new TelemetryStore(options.maxTelemetryPoints);
    this._commandManager = new CommandManager(options.commandTimeout);
  }

  // ============ Public Properties ============

  /** All remote devices currently in this group */
  get devices(): Map<string, Device> {
    return this._presenceManager.devices;
  }

  // ============ Telemetry ============

  /**
   * Publish a telemetry reading from this device.
   */
  sendTelemetry(
    sensorId: string,
    value: TelemetryReading['value'],
    opts: SendTelemetryOptions = {},
  ): TelemetryReading {
    const reading: TelemetryReading = {
      id: generateId(),
      deviceId: this._localDevice.deviceId,
      sensorId,
      value,
      unit: opts.unit,
      tags: opts.tags,
      timestamp: Date.now(),
      isReplay: false,
    };

    this._log('Sending telemetry:', sensorId, '=', value);
    this._roomContext.emit(TOPIC_TELEMETRY, reading, { echo: false });

    // Store locally so the sender also has it in the buffer
    this._telemetryStore.add(reading);

    return reading;
  }

  /**
   * Retrieve buffered telemetry readings, optionally filtered by device/sensor.
   */
  getTelemetry(deviceId?: string, sensorId?: string): TelemetryReading[] {
    return this._telemetryStore.getAll(deviceId, sensorId);
  }

  // ============ Commands ============

  /**
   * Dispatch a command to a target device.
   * Resolves when the device acks the command, rejects on failure or timeout.
   */
  sendCommand(
    targetDeviceId: string,
    command: string,
    params?: Record<string, unknown>,
  ): Promise<DeviceCommand> {
    this._log('Sending command:', command, '→', targetDeviceId);

    const promise = this._commandManager.send(
      targetDeviceId,
      command,
      params,
      this._localDevice.deviceId,
      this._options.commandTimeout,
    );

    // We need the command id to publish it — grab it from pending after send
    const pending = this._commandManager.getPending();
    const cmd = pending[pending.length - 1];
    if (cmd) {
      this._roomContext.emit(TOPIC_COMMANDS, cmd, { echo: false });
    }

    return promise;
  }

  /**
   * Acknowledge a command on the device side.
   * Typically called by the device after receiving a command event.
   */
  ackCommand(
    commandId: string,
    status: 'acked' | 'completed' | 'failed',
    result?: unknown,
  ): void {
    this._log('Acking command:', commandId, status);

    const ack = {
      commandId,
      status,
      result,
      ackedBy: this._localDevice.deviceId,
      ackedAt: Date.now(),
    };

    this._roomContext.emit(TOPIC_CMD_ACK, ack, { echo: false });

    // Also settle locally if this device is the one that sent the command
    this._commandManager.ack(commandId, status, result);
  }

  // ============ Devices ============

  /**
   * Get all remote devices in this group.
   */
  getDevices(): Device[] {
    return this._presenceManager.getAll();
  }

  /**
   * Get a specific device by deviceId.
   */
  getDevice(deviceId: string): Device | undefined {
    return this._presenceManager.getDevice(deviceId);
  }

  // ============ Internal (called by NoLagIoT) ============

  /** @internal Subscribe to all group topics and attach listeners */
  _subscribe(): void {
    this._log('Group subscribe:', this.name);

    this._roomContext.subscribe(TOPIC_TELEMETRY);
    this._roomContext.subscribe(TOPIC_COMMANDS);
    this._roomContext.subscribe(TOPIC_CMD_ACK);

    this._roomContext.on(TOPIC_TELEMETRY, (data: unknown) => {
      this._handleIncomingTelemetry(data);
    });

    this._roomContext.on(TOPIC_COMMANDS, (data: unknown) => {
      this._handleIncomingCommand(data);
    });

    this._roomContext.on(TOPIC_CMD_ACK, (data: unknown) => {
      this._handleIncomingCmdAck(data);
    });
  }

  /** @internal Set presence and fetch existing group members */
  _activate(): void {
    this._log('Group activate:', this.name);
    this._setPresence();

    this._roomContext.fetchPresence().then((actors) => {
      this._log('Group presence fetched:', this.name, actors.length, 'actors');
      for (const actor of actors) {
        if (actor.presence) {
          const device = this._presenceManager.addFromPresence(
            actor.actorTokenId,
            actor.presence as IoTPresenceData,
            actor.joinedAt,
          );
          if (device) {
            this.emit('deviceJoined', device);
          }
        }
      }
    }).catch((err) => {
      this._log('Failed to fetch group presence:', err);
    });
  }

  /** @internal Re-set presence after reconnect */
  _updateLocalPresence(): void {
    this._setPresence();
  }

  /** @internal Handle a presence:join event */
  _handlePresenceJoin(actorTokenId: string, presenceData: IoTPresenceData): void {
    const device = this._presenceManager.addFromPresence(actorTokenId, presenceData);
    if (device) {
      this._log('Device joined group:', this.name, device.deviceId);
      this.emit('deviceJoined', device);
    }
  }

  /** @internal Handle a presence:leave event */
  _handlePresenceLeave(actorTokenId: string): void {
    const device = this._presenceManager.removeByActorId(actorTokenId);
    if (device) {
      this._log('Device left group:', this.name, device.deviceId);
      this.emit('deviceLeft', device);
    }
  }

  /** @internal Handle a presence:update event */
  _handlePresenceUpdate(actorTokenId: string, presenceData: IoTPresenceData): void {
    this._presenceManager.addFromPresence(actorTokenId, presenceData);
  }

  /** @internal Unsubscribe and clean up */
  _cleanup(): void {
    this._log('Group cleanup:', this.name);

    this._roomContext.unsubscribe(TOPIC_TELEMETRY);
    this._roomContext.unsubscribe(TOPIC_COMMANDS);
    this._roomContext.unsubscribe(TOPIC_CMD_ACK);

    this._roomContext.off(TOPIC_TELEMETRY);
    this._roomContext.off(TOPIC_COMMANDS);
    this._roomContext.off(TOPIC_CMD_ACK);

    this._commandManager.dispose();
    this._presenceManager.clear();
    this.removeAllListeners();
  }

  // ============ Private ============

  private _handleIncomingTelemetry(data: unknown): void {
    const reading = data as TelemetryReading;
    this._log('Received telemetry:', reading.sensorId, '=', reading.value, 'from', reading.deviceId);

    const isNew = this._telemetryStore.add(reading);
    if (!isNew) return; // duplicate — skip

    this.emit('telemetry', reading);
  }

  private _handleIncomingCommand(data: unknown): void {
    const cmd = data as DeviceCommand;

    // Only devices process incoming commands targeted at them
    if (this._options.role === 'controller') return;
    if (cmd.targetDeviceId !== this._localDevice.deviceId) return;

    this._log('Received command:', cmd.command, 'from', cmd.sentBy);
    this.emit('command', cmd);
  }

  private _handleIncomingCmdAck(data: unknown): void {
    const ack = data as {
      commandId: string;
      status: 'acked' | 'completed' | 'failed';
      result?: unknown;
      ackedBy: string;
      ackedAt: number;
    };

    this._log('Received command ack:', ack.commandId, ack.status);

    const cmd = this._commandManager.ack(ack.commandId, ack.status, ack.result);
    if (cmd) {
      this.emit('commandAck', cmd);
    }
  }

  private _setPresence(): void {
    const presenceData: IoTPresenceData = {
      deviceId: this._localDevice.deviceId,
      deviceName: this._localDevice.deviceName,
      role: this._localDevice.role,
      metadata: this._localDevice.metadata,
    };
    this._roomContext.setPresence(presenceData);
  }
}
