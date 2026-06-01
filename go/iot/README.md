# NoLag IoT SDK for Go

IoT device telemetry and command dispatch SDK built on top of the [NoLag Go SDK](https://github.com/NoLagApp/go-sdk).

## Installation

```bash
go get github.com/NoLagApp/nolag-iot-go
```

## Setup

Before using the SDK, you need a NoLag project with the IoT blueprint:

1. **Create a Project** in the [NoLag Dashboard](https://app.nolag.app)
2. **Create an App** from the `nolag-iot-sdk` blueprint — this sets up the required rooms, topics, and lobby
3. **Create Actors** to get access tokens for your devices and controllers

The IoT blueprint creates:
- **Room:** `factory-floor` (or custom groups)
- **Topics:** `telemetry`, `commands`, `_cmd_ack`
- **Lobby:** `online` for global presence tracking

## Quick Start

```go
package main

import (
    "fmt"
    "time"

    iot "github.com/NoLagApp/nolag-iot-go"
)

func main() {
    // Create and connect a device
    device := iot.New("your-actor-token", iot.NoLagIoTOptions{
        DeviceID:   "temp-sensor-01",
        DeviceName: "Temperature Sensor",
        Role:       iot.RoleDevice,
        AppName:    "your-app-slug",
    })

    if err := device.Connect(); err != nil {
        panic(err)
    }
    defer device.Disconnect()

    // Join a device group
    group, _ := device.JoinGroup("factory-floor")

    // Send telemetry
    group.SendTelemetry("temperature", 23.5, iot.SendTelemetryOptions{
        Unit: "°C",
        Tags: map[string]string{"location": "north-wing"},
    })

    time.Sleep(60 * time.Second)
}
```

## Concepts

| Concept | Description |
|---------|-------------|
| **Device** | An entity that produces telemetry and/or receives commands |
| **Controller** | An entity that observes telemetry and dispatches commands |
| **Group** | A room where devices gather (e.g., "factory-floor") |
| **Telemetry** | Time-series sensor readings streamed in real-time |
| **Command** | A remote action with acknowledgement tracking |
| **Presence** | Automatic online/offline device tracking |

## Device Roles

```go
iot.RoleDevice     // Produces telemetry, receives commands
iot.RoleController // Sends commands, observes telemetry
```

## Configuration

```go
client := iot.New("your-actor-token", iot.NoLagIoTOptions{
    DeviceID:           "sensor-01",       // Auto-generated if empty
    DeviceName:         "Temperature Sensor",
    Role:               iot.RoleDevice,    // or iot.RoleController
    Metadata:           map[string]any{"firmware": "v2.1"},
    AppName:            "your-app-slug",   // Default: "iot"
    URL:                "wss://broker.nolag.app/ws",
    MaxTelemetryPoints: 1000,              // Buffer size per device/sensor
    CommandTimeout:     30000,             // Command ack timeout (ms)
    Debug:              false,
    Reconnect:          true,
    Groups:             []string{"factory-floor"}, // Auto-join on connect
})
```

## Telemetry

### Sending (Device)

```go
group, _ := device.JoinGroup("factory-floor")

// Simple reading
group.SendTelemetry("temperature", 23.5)

// With unit and tags
group.SendTelemetry("humidity", 65.2, iot.SendTelemetryOptions{
    Unit: "%",
    Tags: map[string]string{"zone": "A"},
})
```

### Receiving (Controller)

```go
group, _ := controller.JoinGroup("factory-floor")

group.On("telemetry", func(args ...any) {
    reading := args[0].(iot.TelemetryReading)
    fmt.Printf("[%s] %s = %v %s\n",
        reading.DeviceID, reading.SensorID, reading.Value, reading.Unit)
})
```

### Buffered Readings

```go
// Get all readings from a specific device/sensor
readings := group.GetTelemetry("sensor-01", "temperature")

// Get all readings from a device (any sensor)
readings := group.GetTelemetry("sensor-01", "")

// Get all readings (any device, any sensor)
readings := group.GetTelemetry("", "")
```

## Commands

### Sending (Controller)

```go
group, _ := controller.JoinGroup("factory-floor")

// Send command and wait for acknowledgement
cmd, ackCh := group.SendCommand("motor-01", "set-speed", map[string]any{
    "target_rpm": 1500,
})
fmt.Printf("Sent command: %s\n", cmd.ID)

// Wait for device to acknowledge
acked := <-ackCh
switch acked.Status {
case iot.StatusCompleted:
    fmt.Printf("Command completed: %v\n", acked.Result)
case iot.StatusFailed:
    fmt.Printf("Command failed: %s\n", acked.Error)
case iot.StatusTimeout:
    fmt.Println("Command timed out")
}
```

### Receiving & Acknowledging (Device)

```go
group, _ := device.JoinGroup("factory-floor")

group.On("command", func(args ...any) {
    cmd := args[0].(iot.DeviceCommand)
    fmt.Printf("Received command: %s (params: %v)\n", cmd.Command, cmd.Params)

    // Process the command...
    result := map[string]any{"actual_rpm": 1500}

    // Acknowledge
    group.AckCommand(cmd.ID, iot.StatusCompleted, result)
})
```

### Command Ack Events (Controller)

```go
group.On("commandAck", func(args ...any) {
    cmd := args[0].(iot.DeviceCommand)
    fmt.Printf("Command %s: status=%s\n", cmd.ID, cmd.Status)
})
```

### Custom Timeout

```go
// 5-second timeout for this command
cmd, ackCh := group.SendCommand("device-01", "ping", nil, 5000)
```

## Presence

Devices automatically broadcast their presence when joining a group.

### Device Join/Leave Events (per group)

```go
group.On("deviceJoined", func(args ...any) {
    dev := args[0].(iot.Device)
    fmt.Printf("Device joined: %s (role: %s)\n", dev.DeviceID, dev.Role)
})

group.On("deviceLeft", func(args ...any) {
    dev := args[0].(iot.Device)
    fmt.Printf("Device left: %s\n", dev.DeviceID)
})
```

### Global Online/Offline Events

```go
client.On("deviceOnline", func(args ...any) {
    dev := args[0].(iot.Device)
    fmt.Printf("Online: %s\n", dev.DeviceID)
})

client.On("deviceOffline", func(args ...any) {
    dev := args[0].(iot.Device)
    fmt.Printf("Offline: %s\n", dev.DeviceID)
})
```

### Listing Devices in a Group

```go
devices := group.Devices()
for _, dev := range devices {
    fmt.Printf("  %s (%s) — %s\n", dev.DeviceID, dev.DeviceName, dev.Role)
}

// Get a specific device
motor := group.GetDevice("motor-01")
```

## Group Management

```go
// Join a group (idempotent — returns same instance if already joined)
group, err := client.JoinGroup("factory-floor")

// Leave a group
client.LeaveGroup("factory-floor")

// List all joined groups
groups := client.GetGroups()

// Get a specific group
group := client.GetGroup("factory-floor")
```

## Connection Events

```go
client.On("connected", func(args ...any) {
    fmt.Println("Connected to NoLag")
})

client.On("disconnected", func(args ...any) {
    reason := args[0].(string)
    fmt.Printf("Disconnected: %s\n", reason)
})
```

## Full Example

```go
package main

import (
    "fmt"
    "os"
    "os/signal"
    "time"

    iot "github.com/NoLagApp/nolag-iot-go"
)

func main() {
    // --- Device ---
    device := iot.New(os.Getenv("DEVICE_TOKEN"), iot.NoLagIoTOptions{
        DeviceID: "temp-sensor-01",
        Role:     iot.RoleDevice,
        AppName:  "my-iot-app",
        Groups:   []string{"factory-floor"},
    })
    if err := device.Connect(); err != nil {
        panic(err)
    }
    defer device.Disconnect()

    group := device.GetGroup("factory-floor")

    // Listen for commands
    group.On("command", func(args ...any) {
        cmd := args[0].(iot.DeviceCommand)
        fmt.Printf("Command: %s\n", cmd.Command)
        group.AckCommand(cmd.ID, iot.StatusCompleted, nil)
    })

    // Send telemetry every 5 seconds
    go func() {
        for {
            group.SendTelemetry("temperature", 22.5+float64(time.Now().Second()%10)/10.0, iot.SendTelemetryOptions{
                Unit: "°C",
            })
            time.Sleep(5 * time.Second)
        }
    }()

    // Wait for interrupt
    sig := make(chan os.Signal, 1)
    signal.Notify(sig, os.Interrupt)
    <-sig
}
```

## Type Reference

```go
// Client
iot.NoLagIoT            // Main IoT client
iot.NoLagIoTOptions     // Client configuration
iot.DeviceGroup         // Group operations (telemetry, commands, presence)

// Roles
iot.RoleDevice          // "device"
iot.RoleController      // "controller"

// Telemetry
iot.TelemetryReading    // A sensor reading
iot.SendTelemetryOptions // Options for SendTelemetry
iot.TelemetryStore      // Time-series buffer

// Commands
iot.DeviceCommand       // A command with lifecycle tracking
iot.CommandStatus       // pending, acked, completed, failed, timeout
iot.CommandManager      // Command dispatch manager

// Presence
iot.Device              // Device info from presence
iot.IoTPresenceData     // Presence payload
iot.PresenceManager     // Device presence tracker
```

## Command Status Lifecycle

```
pending → acked → completed
                ↘ failed
        → timeout
```

| Status | Description |
|--------|-------------|
| `StatusPending` | Command sent, waiting for device |
| `StatusAcked` | Device acknowledged receipt |
| `StatusCompleted` | Device finished executing |
| `StatusFailed` | Device reported failure |
| `StatusTimeout` | No response within timeout |

## Requirements

- Go 1.21+
- [NoLag Go SDK](https://github.com/NoLagApp/go-sdk) v1.0.0+

## License

MIT
