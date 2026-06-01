package iot

import (
	"sync"

	nolag "github.com/NoLagApp/go-sdk"
)

// DeviceGroup manages telemetry, commands, and presence for a named group (room).
type DeviceGroup struct {
	*Emitter

	name             string
	iot              *NoLagIoT
	room             *nolag.Room
	store            *TelemetryStore
	commands         *CommandManager
	presence         *PresenceManager
	receivedCommands sync.Map // commandId -> sentBy (for ack routing)
}

func newDeviceGroup(name string, iot *NoLagIoT) *DeviceGroup {
	g := &DeviceGroup{
		Emitter:  NewEmitter(),
		name:     name,
		iot:      iot,
		store:    NewTelemetryStore(iot.options.MaxTelemetryPoints),
		commands: NewCommandManager(iot.options.CommandTimeout),
		presence: NewPresenceManager(iot.client.ActorID()),
	}
	return g
}

// Name returns the group name.
func (g *DeviceGroup) Name() string { return g.name }

// Devices returns all remote devices in this group.
func (g *DeviceGroup) Devices() []*Device { return g.presence.GetAll() }

// GetDevice returns a specific device by deviceId.
func (g *DeviceGroup) GetDevice(deviceID string) *Device { return g.presence.GetDevice(deviceID) }

// subscribe sets up the room context and subscribes to topics.
func (g *DeviceGroup) subscribe() error {
	g.room = g.iot.client.SetApp(g.iot.options.AppName).SetRoom(g.name)

	// Subscribe to telemetry
	if err := g.room.Subscribe(TopicTelemetry, func(data any, meta nolag.MessageMeta) {
		g.handleTelemetry(data, meta)
	}); err != nil {
		return err
	}

	// Subscribe to commands (devices filter by their own deviceId)
	cmdOpts := nolag.SubscribeOptions{}
	if g.iot.options.Role == RoleDevice {
		cmdOpts.Filters = []any{g.iot.localDevice.DeviceID}
	}
	if err := g.room.Subscribe(TopicCommands, func(data any, meta nolag.MessageMeta) {
		g.handleCommand(data, meta)
	}, cmdOpts); err != nil {
		return err
	}

	// Subscribe to command acks (controllers filter by their own deviceId)
	ackOpts := nolag.SubscribeOptions{}
	if g.iot.options.Role == RoleController {
		ackOpts.Filters = []any{g.iot.localDevice.DeviceID}
	}
	if err := g.room.Subscribe(TopicCmdAck, func(data any, meta nolag.MessageMeta) {
		g.handleCmdAck(data, meta)
	}, ackOpts); err != nil {
		return err
	}

	// Set presence
	g.room.SetPresence(map[string]any{
		"deviceId":   g.iot.localDevice.DeviceID,
		"deviceName": g.iot.localDevice.DeviceName,
		"role":       string(g.iot.localDevice.Role),
		"metadata":   g.iot.localDevice.Metadata,
	})

	return nil
}

// unsubscribe cleans up subscriptions.
func (g *DeviceGroup) unsubscribe() {
	if g.room != nil {
		g.room.Unsubscribe(TopicTelemetry)
		g.room.Unsubscribe(TopicCommands)
		g.room.Unsubscribe(TopicCmdAck)
	}
	g.commands.Dispose()
	g.presence.Clear()
	g.store.Clear()
}

// SendTelemetry publishes a sensor reading.
func (g *DeviceGroup) SendTelemetry(sensorID string, value any, opts ...SendTelemetryOptions) *TelemetryReading {
	reading := TelemetryReading{
		ID:        generateID("tel"),
		DeviceID:  g.iot.localDevice.DeviceID,
		SensorID:  sensorID,
		Value:     value,
		Timestamp: nowMs(),
	}
	if len(opts) > 0 {
		reading.Unit = opts[0].Unit
		reading.Tags = opts[0].Tags
	}

	g.store.Add(reading)

	g.room.Emit(TopicTelemetry, map[string]any{
		"id":        reading.ID,
		"deviceId":  reading.DeviceID,
		"sensorId":  reading.SensorID,
		"value":     reading.Value,
		"unit":      reading.Unit,
		"tags":      reading.Tags,
		"timestamp": reading.Timestamp,
	})

	return &reading
}

// GetTelemetry returns buffered readings, optionally filtered.
func (g *DeviceGroup) GetTelemetry(deviceID, sensorID string) []TelemetryReading {
	return g.store.GetAll(deviceID, sensorID)
}

// SendCommand dispatches a command to a target device and returns a channel for the ack.
func (g *DeviceGroup) SendCommand(targetDeviceID, command string, params map[string]any, timeoutMs ...int) (*DeviceCommand, <-chan *DeviceCommand) {
	cmd, ackCh := g.commands.Send(targetDeviceID, command, params, g.iot.localDevice.DeviceID, timeoutMs...)

	g.room.Emit(TopicCommands, map[string]any{
		"id":             cmd.ID,
		"targetDeviceId": cmd.TargetDeviceID,
		"command":        cmd.Command,
		"params":         cmd.Params,
		"sentBy":         cmd.SentBy,
		"sentAt":         cmd.SentAt,
	}, nolag.EmitOptions{Filter: targetDeviceID})

	return cmd, ackCh
}

// AckCommand acknowledges a received command.
// The ack is filtered by the sender's deviceId so only the command originator receives it.
func (g *DeviceGroup) AckCommand(commandID string, status CommandStatus, result any) {
	// Look up who sent the command to route the ack back
	filter := ""
	if sentBy, ok := g.receivedCommands.Load(commandID); ok {
		filter = sentBy.(string)
		g.receivedCommands.Delete(commandID)
	}

	g.room.Emit(TopicCmdAck, map[string]any{
		"commandId": commandID,
		"status":    string(status),
		"result":    result,
	}, nolag.EmitOptions{Filter: filter})
}

func (g *DeviceGroup) handleTelemetry(data any, meta nolag.MessageMeta) {
	m, ok := data.(map[string]any)
	if !ok {
		return
	}

	reading := TelemetryReading{
		ID:        stringVal(m, "id"),
		DeviceID:  stringVal(m, "deviceId"),
		SensorID:  stringVal(m, "sensorId"),
		Value:     m["value"],
		Unit:      stringVal(m, "unit"),
		Timestamp: int64Val(m, "timestamp"),
		IsReplay:  meta.IsReplay,
	}
	if tags, ok := m["tags"].(map[string]any); ok {
		reading.Tags = make(map[string]string)
		for k, v := range tags {
			if s, ok := v.(string); ok {
				reading.Tags[k] = s
			}
		}
	}

	g.store.Add(reading)
	g.Emit("telemetry", reading)
}

func (g *DeviceGroup) handleCommand(data any, meta nolag.MessageMeta) {
	m, ok := data.(map[string]any)
	if !ok {
		return
	}

	cmd := DeviceCommand{
		ID:             stringVal(m, "id"),
		TargetDeviceID: stringVal(m, "targetDeviceId"),
		Command:        stringVal(m, "command"),
		Status:         StatusPending,
		SentBy:         stringVal(m, "sentBy"),
		SentAt:         int64Val(m, "sentAt"),
	}
	if params, ok := m["params"].(map[string]any); ok {
		cmd.Params = params
	}

	// Store sentBy for ack routing
	g.receivedCommands.Store(cmd.ID, cmd.SentBy)

	g.Emit("command", cmd)
}

func (g *DeviceGroup) handleCmdAck(data any, meta nolag.MessageMeta) {
	m, ok := data.(map[string]any)
	if !ok {
		return
	}

	commandID := stringVal(m, "commandId")
	status := CommandStatus(stringVal(m, "status"))
	result := m["result"]

	cmd := g.commands.Ack(commandID, status, result)
	if cmd != nil {
		g.Emit("commandAck", *cmd)
	}
}

// handlePresenceJoin processes a device joining the group.
func (g *DeviceGroup) handlePresenceJoin(actorTokenID string, presenceData map[string]any) {
	data := parsePresenceData(presenceData)
	if data == nil {
		return
	}
	dev := g.presence.AddFromPresence(actorTokenID, *data, 0)
	if dev != nil {
		g.Emit("deviceJoined", *dev)
	}
}

// handlePresenceLeave processes a device leaving the group.
func (g *DeviceGroup) handlePresenceLeave(actorTokenID string) {
	dev := g.presence.RemoveByActorID(actorTokenID)
	if dev != nil {
		g.Emit("deviceLeft", *dev)
	}
}

func parsePresenceData(m map[string]any) *IoTPresenceData {
	if m == nil {
		return nil
	}
	data := &IoTPresenceData{
		DeviceID:   stringVal(m, "deviceId"),
		DeviceName: stringVal(m, "deviceName"),
		Role:       DeviceRole(stringVal(m, "role")),
	}
	if data.DeviceID == "" {
		return nil
	}
	if meta, ok := m["metadata"].(map[string]any); ok {
		data.Metadata = meta
	}
	return data
}

func stringVal(m map[string]any, key string) string {
	if v, ok := m[key].(string); ok {
		return v
	}
	return ""
}

func int64Val(m map[string]any, key string) int64 {
	switch v := m[key].(type) {
	case int64:
		return v
	case float64:
		return int64(v)
	case int:
		return int64(v)
	case uint64:
		return int64(v)
	}
	return 0
}
