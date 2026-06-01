// Package iot provides an IoT device telemetry and command dispatch SDK
// built on top of the NoLag Go SDK.
//
// It mirrors the functionality of @nolag/iot (the JS IoT SDK).
//
// Key concepts:
//   - Devices: entities with roles (device/controller) producing/consuming telemetry and commands
//   - Groups: rooms where devices gather (e.g., "factory-floor")
//   - Telemetry: time-series sensor readings streamed in real-time
//   - Commands: remote actions with ack tracking
//   - Presence: automatic online/offline tracking
package iot

import (
	"fmt"
	"sync"

	nolag "github.com/NoLagApp/go-sdk"
)

// NoLagIoTOptions configures the IoT client.
type NoLagIoTOptions struct {
	DeviceID           string
	DeviceName         string
	Role               DeviceRole
	Metadata           map[string]any
	AppName            string // Default: "iot"
	URL                string // Broker URL override
	MaxTelemetryPoints int    // Per device/sensor buffer (default: 1000)
	CommandTimeout     int    // ms (default: 30000)
	Debug              bool
	Reconnect          bool
	Groups             []string // Auto-join groups after connect
}

// NoLagIoT is the high-level IoT client wrapping the NoLag Go SDK.
type NoLagIoT struct {
	*Emitter

	client      *nolag.Client
	options     NoLagIoTOptions
	localDevice *Device

	mu     sync.RWMutex
	groups map[string]*DeviceGroup
}

// New creates a new IoT client.
func New(token string, opts ...NoLagIoTOptions) *NoLagIoT {
	options := NoLagIoTOptions{
		Role:               RoleDevice,
		AppName:            DefaultAppName,
		MaxTelemetryPoints: DefaultMaxTelemetryPoints,
		CommandTimeout:     DefaultCommandTimeout,
		Reconnect:          true,
	}
	if len(opts) > 0 {
		o := opts[0]
		if o.DeviceID != "" {
			options.DeviceID = o.DeviceID
		}
		if o.DeviceName != "" {
			options.DeviceName = o.DeviceName
		}
		if o.Role != "" {
			options.Role = o.Role
		}
		if o.Metadata != nil {
			options.Metadata = o.Metadata
		}
		if o.AppName != "" {
			options.AppName = o.AppName
		}
		if o.URL != "" {
			options.URL = o.URL
		}
		if o.MaxTelemetryPoints > 0 {
			options.MaxTelemetryPoints = o.MaxTelemetryPoints
		}
		if o.CommandTimeout > 0 {
			options.CommandTimeout = o.CommandTimeout
		}
		options.Debug = o.Debug
		options.Reconnect = o.Reconnect
		if o.Groups != nil {
			options.Groups = o.Groups
		}
	}

	if options.DeviceID == "" {
		options.DeviceID = generateID("dev")
	}

	clientOpts := nolag.Options{
		Reconnect:         options.Reconnect,
		Debug:             options.Debug,
		HeartbeatInterval: -1,
	}
	if options.URL != "" {
		clientOpts.URL = options.URL
	}

	return &NoLagIoT{
		Emitter: NewEmitter(),
		client:  nolag.New(token, clientOpts),
		options: options,
		groups:  make(map[string]*DeviceGroup),
	}
}

// Connect establishes a connection to the NoLag broker and sets up presence.
func (iot *NoLagIoT) Connect() error {
	if err := iot.client.Connect(); err != nil {
		return fmt.Errorf("iot connect: %w", err)
	}

	iot.localDevice = &Device{
		DeviceID:     iot.options.DeviceID,
		ActorTokenID: iot.client.ActorID(),
		DeviceName:   iot.options.DeviceName,
		Role:         iot.options.Role,
		Metadata:     iot.options.Metadata,
		JoinedAt:     nowMs(),
		IsLocal:      true,
	}

	// Set up presence event handlers
	iot.client.On("presence:join", func(args ...any) {
		if len(args) == 0 {
			return
		}
		actor, ok := args[0].(nolag.ActorPresence)
		if !ok {
			return
		}
		presData := parsePresenceData(actor.Presence)
		if presData == nil || actor.ActorTokenID == iot.client.ActorID() {
			return
		}

		dev := &Device{
			DeviceID:     presData.DeviceID,
			ActorTokenID: actor.ActorTokenID,
			DeviceName:   presData.DeviceName,
			Role:         presData.Role,
			Metadata:     presData.Metadata,
			JoinedAt:     nowMs(),
		}
		iot.Emit("deviceOnline", *dev)

		// Notify all groups
		iot.mu.RLock()
		for _, g := range iot.groups {
			g.handlePresenceJoin(actor.ActorTokenID, actor.Presence)
		}
		iot.mu.RUnlock()
	})

	iot.client.On("presence:leave", func(args ...any) {
		if len(args) == 0 {
			return
		}
		actor, ok := args[0].(nolag.ActorPresence)
		if !ok {
			return
		}

		iot.mu.RLock()
		for _, g := range iot.groups {
			g.handlePresenceLeave(actor.ActorTokenID)
		}
		iot.mu.RUnlock()

		presData := parsePresenceData(actor.Presence)
		if presData != nil {
			dev := &Device{
				DeviceID:     presData.DeviceID,
				ActorTokenID: actor.ActorTokenID,
				DeviceName:   presData.DeviceName,
				Role:         presData.Role,
			}
			iot.Emit("deviceOffline", *dev)
		}
	})

	// Auto-join groups
	for _, groupName := range iot.options.Groups {
		if _, err := iot.JoinGroup(groupName); err != nil {
			return fmt.Errorf("auto-join group %s: %w", groupName, err)
		}
	}

	iot.Emit("connected")
	return nil
}

// Disconnect closes the connection and cleans up.
func (iot *NoLagIoT) Disconnect() {
	iot.mu.Lock()
	for name, g := range iot.groups {
		g.unsubscribe()
		delete(iot.groups, name)
	}
	iot.mu.Unlock()

	iot.client.Close()
	iot.Emit("disconnected", "manual")
}

// Connected returns true if connected to the broker.
func (iot *NoLagIoT) Connected() bool {
	return iot.client.Status() == nolag.StatusConnected
}

// LocalDevice returns the local device info.
func (iot *NoLagIoT) LocalDevice() *Device {
	return iot.localDevice
}

// Client returns the underlying NoLag client (for advanced usage).
func (iot *NoLagIoT) Client() *nolag.Client {
	return iot.client
}

// JoinGroup joins a device group (room). Idempotent.
func (iot *NoLagIoT) JoinGroup(name string) (*DeviceGroup, error) {
	iot.mu.Lock()
	if g, ok := iot.groups[name]; ok {
		iot.mu.Unlock()
		return g, nil
	}

	g := newDeviceGroup(name, iot)
	iot.groups[name] = g
	iot.mu.Unlock()

	if err := g.subscribe(); err != nil {
		iot.mu.Lock()
		delete(iot.groups, name)
		iot.mu.Unlock()
		return nil, fmt.Errorf("join group %s: %w", name, err)
	}

	return g, nil
}

// LeaveGroup leaves a device group.
func (iot *NoLagIoT) LeaveGroup(name string) {
	iot.mu.Lock()
	if g, ok := iot.groups[name]; ok {
		g.unsubscribe()
		delete(iot.groups, name)
	}
	iot.mu.Unlock()
}

// GetGroups returns all joined groups.
func (iot *NoLagIoT) GetGroups() []*DeviceGroup {
	iot.mu.RLock()
	defer iot.mu.RUnlock()
	result := make([]*DeviceGroup, 0, len(iot.groups))
	for _, g := range iot.groups {
		result = append(result, g)
	}
	return result
}

// GetGroup returns a specific group by name.
func (iot *NoLagIoT) GetGroup(name string) *DeviceGroup {
	iot.mu.RLock()
	defer iot.mu.RUnlock()
	return iot.groups[name]
}
