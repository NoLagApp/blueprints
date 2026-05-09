# @nolag/iot

IoT device SDK for [NoLag](https://nolag.app) — telemetry, command dispatch, and device management.

## How It Works with NoLag

NoLag is a real-time messaging platform that handles WebSocket connections, message routing, persistence, and scaling. This SDK wraps the low-level [@nolag/js-sdk](https://www.npmjs.com/package/@nolag/js-sdk) and gives you a purpose-built IoT API — publish telemetry, send commands to devices, and track acknowledgements — without managing topics or subscriptions yourself.

### Getting Your Token

1. Sign up at [nolag.app](https://nolag.app)
2. Create a new **project** in the portal
3. Choose the **IoT** blueprint when creating an app — this pre-configures the topics (`telemetry`, `commands`, `_cmd_ack`) and settings your IoT system needs
4. Go to the app's **Tokens** page and generate an **actor token**
5. Use that token when connecting with this SDK

Each token identifies a unique device or controller (actor) in NoLag. The blueprint handles all the infrastructure setup — you just build your device logic or dashboard.

## Install

```bash
npm install @nolag/js-sdk @nolag/iot
```

## Quick Start

```typescript
import { NoLagIoT } from "@nolag/iot";

// --- Device: sends telemetry, receives commands ---
const device = new NoLagIoT("DEVICE_TOKEN", {
  deviceName: "Sensor #7",
  role: "device",
});

await device.connect();

const group = device.joinGroup("warehouse-a");

// Publish sensor readings
setInterval(() => {
  group.sendTelemetry("temperature", 22.5, { unit: "°C" });
  group.sendTelemetry("humidity", 65, { unit: "%" });
}, 5000);

// Respond to commands
group.on("command", (cmd) => {
  console.log(`Command: ${cmd.command}`, cmd.params);
  group.ackCommand(cmd.id, "completed", { success: true });
});

// --- Controller: monitors telemetry, sends commands ---
const controller = new NoLagIoT("CONTROLLER_TOKEN", {
  deviceName: "Dashboard",
  role: "controller",
});

await controller.connect();

const controlGroup = controller.joinGroup("warehouse-a");

// Monitor telemetry
controlGroup.on("telemetry", (reading) => {
  console.log(`${reading.deviceId}/${reading.sensorId}: ${reading.value}${reading.unit}`);
});

// Send a command to a device
const cmd = await controlGroup.sendCommand("sensor-7", "calibrate", {
  offset: 0.5,
});

controlGroup.on("commandAck", (ack) => {
  console.log(`Command ${ack.id}: ${ack.status}`);
});
```

## API Reference

### `NoLagIoT`

#### Constructor

```typescript
const iot = new NoLagIoT(token: string, options?: NoLagIoTOptions);
```

**Options:**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `deviceId` | `string` | auto-generated | Unique device ID |
| `deviceName` | `string` | — | Display name |
| `role` | `DeviceRole` | `'device'` | `'device'` or `'controller'` |
| `metadata` | `Record<string, unknown>` | — | Custom device data |
| `groups` | `string[]` | — | Auto-join these groups on connect |
| `maxTelemetryPoints` | `number` | `1000` | Max telemetry points in memory |
| `commandTimeout` | `number` | `30000` | Command ack timeout (ms) |
| `debug` | `boolean` | `false` | Enable debug logging |
| `reconnect` | `boolean` | `true` | Auto-reconnect on disconnect |

#### Methods

| Method | Returns | Description |
|--------|---------|-------------|
| `connect()` | `Promise<void>` | Connect to NoLag |
| `disconnect()` | `void` | Disconnect |
| `joinGroup(name)` | `DeviceGroup` | Join a device group |
| `leaveGroup(name)` | `void` | Leave a group |
| `getGroups()` | `DeviceGroup[]` | Get all joined groups |
| `getOnlineDevices()` | `Device[]` | Get online devices |

#### Events

| Event | Payload | Description |
|-------|---------|-------------|
| `connected` | — | Connected |
| `disconnected` | — | Disconnected |
| `reconnected` | — | Reconnected |
| `error` | `Error` | Error |
| `deviceOnline` | `Device` | Device came online |
| `deviceOffline` | `Device` | Device went offline |

### `DeviceGroup`

#### Methods

| Method | Returns | Description |
|--------|---------|-------------|
| `sendTelemetry(sensorId, value, opts?)` | `TelemetryReading` | Publish a sensor reading |
| `getTelemetry(deviceId?, sensorId?)` | `TelemetryReading[]` | Get cached telemetry |
| `sendCommand(targetDeviceId, command, params?)` | `Promise<DeviceCommand>` | Send a command |
| `ackCommand(commandId, status, result?)` | `void` | Acknowledge a command |
| `getDevices()` | `Device[]` | Get devices in this group |
| `getDevice(deviceId)` | `Device \| undefined` | Get a specific device |

#### Events

| Event | Payload | Description |
|-------|---------|-------------|
| `telemetry` | `TelemetryReading` | Telemetry received |
| `command` | `DeviceCommand` | Command received (devices) |
| `commandAck` | `DeviceCommand` | Command acknowledged |
| `deviceJoined` | `Device` | Device joined group |
| `deviceLeft` | `Device` | Device left group |
| `replayStart` / `replayEnd` | — | Telemetry replay |

## Types

```typescript
interface TelemetryReading {
  id: string;
  deviceId: string;
  sensorId: string;
  value: number | string | boolean | Record<string, unknown>;
  unit?: string;
  tags?: Record<string, string>;
  timestamp: number;
  isReplay: boolean;
}

interface DeviceCommand {
  id: string;
  targetDeviceId: string;
  command: string;
  params?: Record<string, unknown>;
  status: CommandStatus;
  sentBy: string;
  sentAt: number;
  ackedAt?: number;
  completedAt?: number;
  result?: unknown;
  error?: string;
}

type CommandStatus = "pending" | "acked" | "completed" | "failed" | "timeout";

interface Device {
  deviceId: string;
  actorTokenId: string;
  deviceName?: string;
  role: DeviceRole;
  metadata?: Record<string, unknown>;
  joinedAt: number;
  isLocal: boolean;
}

type DeviceRole = "device" | "controller";
```

## License

MIT
