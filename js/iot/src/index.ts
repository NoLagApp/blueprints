/**
 * @nolag/iot
 * IoT device telemetry and command dispatch SDK for Node.js
 */

export { NoLagIoT } from './NoLagIoT';
export { DeviceGroup } from './DeviceGroup';
export { TelemetryStore } from './TelemetryStore';
export { CommandManager } from './CommandManager';
export { PresenceManager } from './PresenceManager';
export { EventEmitter } from './EventEmitter';

export type {
  NoLagIoTOptions,
  ResolvedIoTOptions,
  DeviceRole,
  CommandStatus,
  TelemetryReading,
  SendTelemetryOptions,
  DeviceCommand,
  Device,
  IoTPresenceData,
  IoTClientEvents,
  DeviceGroupEvents,
} from './types';
