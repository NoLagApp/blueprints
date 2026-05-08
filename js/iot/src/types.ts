/**
 * @nolag/iot — Public types
 */

// ============ Options ============

export type DeviceRole = 'device' | 'controller';

export type CommandStatus = 'pending' | 'acked' | 'completed' | 'failed' | 'timeout';

export interface NoLagIoTOptions {
  /** Stable device identifier (generated if omitted) */
  deviceId?: string;
  /** Human-readable device name */
  deviceName?: string;
  /** Whether this client acts as a device or a controller (default: 'device') */
  role?: DeviceRole;
  /** Custom metadata attached to device presence */
  metadata?: Record<string, unknown>;
  /** NoLag app name (default: 'iot') */
  appName?: string;
  /** WebSocket URL override */
  url?: string;
  /** Max telemetry readings to retain per device/sensor key (default: 1000) */
  maxTelemetryPoints?: number;
  /** Command acknowledgement timeout in ms (default: 30000) */
  commandTimeout?: number;
  /** Enable debug logging (default: false) */
  debug?: boolean;
  /** Auto-reconnect on disconnect (default: true) */
  reconnect?: boolean;
  /** Initial groups to join after connect */
  groups?: string[];
}

/** Resolved options with defaults applied */
export interface ResolvedIoTOptions {
  deviceId: string;
  deviceName?: string;
  role: DeviceRole;
  metadata?: Record<string, unknown>;
  appName: string;
  url?: string;
  maxTelemetryPoints: number;
  commandTimeout: number;
  debug: boolean;
  reconnect: boolean;
  groups: string[];
}

// ============ Telemetry ============

export interface TelemetryReading {
  /** Client-generated unique reading ID */
  id: string;
  /** Device that produced this reading */
  deviceId: string;
  /** Sensor / metric identifier within the device */
  sensorId: string;
  /** Measured value */
  value: number | string | boolean | Record<string, unknown>;
  /** Optional unit label (e.g. "°C", "rpm", "%") */
  unit?: string;
  /** Arbitrary key/value tags for filtering */
  tags?: Record<string, string>;
  /** Unix timestamp in milliseconds */
  timestamp: number;
  /** True when this reading was delivered via replay */
  isReplay: boolean;
}

export interface SendTelemetryOptions {
  unit?: string;
  tags?: Record<string, string>;
}

// ============ Commands ============

export interface DeviceCommand {
  /** Client-generated unique command ID */
  id: string;
  /** Target device ID */
  targetDeviceId: string;
  /** Command name */
  command: string;
  /** Optional command parameters */
  params?: Record<string, unknown>;
  /** Current lifecycle status */
  status: CommandStatus;
  /** Actor/device ID that sent the command */
  sentBy: string;
  /** Timestamp when the command was dispatched */
  sentAt: number;
  /** Timestamp when the device acknowledged the command */
  ackedAt?: number;
  /** Timestamp when the command completed */
  completedAt?: number;
  /** Result payload from the device */
  result?: unknown;
  /** Error message if failed */
  error?: string;
}

// ============ Device ============

export interface Device {
  /** Stable device ID */
  deviceId: string;
  /** NoLag internal actor token ID */
  actorTokenId: string;
  /** Human-readable device name */
  deviceName?: string;
  /** Device role */
  role: DeviceRole;
  /** Custom metadata */
  metadata?: Record<string, unknown>;
  /** Timestamp when the device joined */
  joinedAt: number;
  /** Whether this is the local device */
  isLocal: boolean;
}

// ============ Presence Payload ============

/** Shape of data stored in NoLag presence for IoT devices */
export interface IoTPresenceData {
  [key: string]: unknown;
  deviceId: string;
  deviceName?: string;
  role: DeviceRole;
  metadata?: Record<string, unknown>;
}

// ============ Event Maps ============

export interface IoTClientEvents {
  connected: [];
  disconnected: [reason: string];
  reconnected: [];
  error: [error: Error];
  deviceOnline: [device: Device];
  deviceOffline: [device: Device];
}

export interface DeviceGroupEvents {
  telemetry: [reading: TelemetryReading];
  command: [command: DeviceCommand];
  commandAck: [command: DeviceCommand];
  deviceJoined: [device: Device];
  deviceLeft: [device: Device];
  replayStart: [];
  replayEnd: [];
}
