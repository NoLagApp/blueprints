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

The app owns one core NoLag client; wrappers attach to it. Any number of
wrapper SDKs (iot, chat, dash, ...) can share the same connection as long as
each uses its own app.

```typescript
import { NoLag } from "@nolag/js-sdk";
import { NoLagIoT } from "@nolag/iot";

// One client for the whole app. In a browser, use a token provider so the
// SDK can mint fresh short-lived client tokens from your backend.
const client = NoLag(async () => (await (await fetch("/api/nolag-token")).json()).token);

// --- Device: sends telemetry, receives commands ---
const device = new NoLagIoT({ client, deviceName: "Sensor #7", role: "device" });

await client.connect();   // the app owns the connection
await device.ready();     // wrapper setup done (identity, presence, groups)

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

// Teardown: the wrapper releases its handlers and topics (and cancels any
// pending command timeouts); the app closes the socket.
device.detach();
client.disconnect();
```

A controller shares the same pattern — construct with `{ client, role: "controller" }`,
`await controller.ready()`, then monitor telemetry and dispatch commands:

```typescript
const controlGroup = controller.joinGroup("warehouse-a");

controlGroup.on("telemetry", (reading) => {
  console.log(`${reading.deviceId}/${reading.sensorId}: ${reading.value}${reading.unit}`);
});

// Resolves when the target device acks; rejects on failure or timeout
const cmd = await controlGroup.sendCommand("sensor-7", "calibrate", { offset: 0.5 });
console.log(`Command ${cmd.id}: ${cmd.status}`);
```

## Lifecycle

- **Construction = attach.** The wrapper wires its handlers onto the injected
  client immediately. If the client is already connected, setup runs on the
  next microtask; otherwise it runs when the client's `connect` event fires.
- **`ready()`** resolves once the first setup completed (identity, online
  lobby, configured groups). Auth failures surface via your own
  `await client.connect()`, not via `ready()`.
- **Reconnects are automatic.** The wrapper re-applies device presence to every
  joined group (persistent presence) and reconciles the online-device list,
  emitting only real deltas.
- **`detach()`** removes exactly this wrapper's handlers and topics, cancels any
  pending command-timeout timers, and never touches the socket. It is terminal:
  construct a new instance to re-attach. Detach while the client is still
  connected so server-side unsubscribes go through. In frameworks, call it from
  your dispose hook (`onUnmounted`, HMR dispose).
- **One wrapper per (client, app).** Sharing a client across wrappers of
  DIFFERENT apps is the intended pattern; two wrappers on the same app would
  collide on topics and presence (the SDK warns if you do this).

## API Reference

### `NoLagIoT`

#### Constructor

```typescript
const iot = new NoLagIoT(options: NoLagIoTOptions);
```

**Options:**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `client` | `NoLagSocket` | *required* | The injected core NoLag client |
| `deviceId` | `string` | auto-generated | Unique device ID |
| `deviceName` | `string` | — | Display name |
| `role` | `DeviceRole` | `'device'` | `'device'` or `'controller'` |
| `metadata` | `Record<string, unknown>` | — | Custom device data |
| `appName` | `string` | `'iot'` | NoLag app for topic prefixes |
| `groups` | `string[]` | — | Auto-join these groups on connect |
| `maxTelemetryPoints` | `number` | `1000` | Max telemetry points in memory |
| `commandTimeout` | `number` | `30000` | Command ack timeout (ms) |
| `debug` | `boolean` | `false` | Enable debug logging |

#### Methods

| Method | Returns | Description |
|--------|---------|-------------|
| `ready()` | `Promise<void>` | Resolves when wrapper setup completed |
| `detach()` | `void` | Release handlers, topics, and command timers (terminal; never closes the socket) |
| `joinGroup(name)` | `DeviceGroup` | Join a device group |
| `leaveGroup(name)` | `void` | Leave a group |
| `getGroups()` | `DeviceGroup[]` | Get all joined groups |
| `getOnlineDevices()` | `Device[]` | Get online devices |

#### Properties

| Property | Type | Description |
|----------|------|-------------|
| `connected` | `boolean` | Whether currently connected |
| `localDevice` | `Device \| null` | The local device |
| `groups` | `Map<string, DeviceGroup>` | All joined groups |

#### Events

| Event | Payload | Description |
|-------|---------|-------------|
| `connected` | — | First setup completed |
| `disconnected` | `reason` | Disconnected |
| `reconnecting` | — | The client is re-establishing the connection |
| `reconnected` | — | Setup restored after a reconnect |
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
