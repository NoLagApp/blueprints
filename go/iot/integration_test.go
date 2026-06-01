//go:build integration

// Self-contained integration tests for the NoLag Go IoT SDK.
//
// These tests manage the full lifecycle:
//   1. Delete any existing app (free tier = 1 app limit)
//   2. Create a new app from the nolag-iot-sdk blueprint
//   3. Create actor tokens for devices/controllers
//   4. Run all IoT tests
//   5. Clean up (delete actors, delete app)
//
// Run:
//   NOLAG_API_KEY=nlg_live_xxx.secret go test -v -tags=integration -timeout 180s
//
// Optional:
//   NOLAG_BROKER_URL  — broker URL (default: wss://broker.nolag.app/ws)
//   NOLAG_API_URL     — API base URL (default: https://api.nolag.app/v1)

package iot

import (
	"context"
	"fmt"
	"log"
	"os"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	nolag "github.com/NoLagApp/go-sdk"
)

// ── Test configuration ──────────────────────────────────────────────

var (
	tAPIKey    = os.Getenv("NOLAG_API_KEY")
	tBrokerURL = getEnv("NOLAG_BROKER_URL", "wss://broker.nolag.app/ws")
	tAPIURL   = getEnv("NOLAG_API_URL", "https://api.nolag.app/v1")

	// Populated by TestMain
	tAPI       *nolag.API
	tAppID     string
	tAppSlug   string
	tToken1    string // device role
	tToken2    string // controller role
	tToken3    string // second device
	tActor1ID  string
	tActor2ID  string
	tActor3ID  string
)

func getEnv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

// ── TestMain: setup & teardown ──────────────────────────────────────

func TestMain(m *testing.M) {
	if tAPIKey == "" {
		log.Println("NOLAG_API_KEY not set, skipping integration tests")
		os.Exit(0)
	}

	ctx := context.Background()
	tAPI = nolag.NewAPI(tAPIKey, nolag.APIOptions{BaseURL: tAPIURL})

	// Delete any existing apps (free tier = 1 app limit)
	apps, err := tAPI.Apps.List(ctx, nil)
	if err != nil {
		log.Fatalf("Failed to list apps: %v", err)
	}
	for _, app := range apps.Data {
		log.Printf("Deleting existing app: %s (%s)", app.Name, app.AppID)
		if err := tAPI.Apps.Delete(ctx, app.AppID); err != nil {
			log.Fatalf("Failed to delete app %s: %v", app.AppID, err)
		}
	}

	// Create app from IoT blueprint
	app, err := tAPI.Apps.Create(ctx, nolag.AppCreate{
		Name:        "Go IoT Integration Test",
		BlueprintID: "nolag-iot-sdk",
	})
	if err != nil {
		log.Fatalf("Failed to create IoT app: %v", err)
	}
	tAppID = app.AppID
	tAppSlug = app.Slug
	log.Printf("Created IoT app: %s (slug: %s)", tAppID, tAppSlug)

	// Wait for app provisioning
	time.Sleep(1 * time.Second)

	// Verify rooms were created from blueprint
	rooms, err := tAPI.Rooms.List(ctx, tAppID)
	if err != nil {
		log.Fatalf("Failed to list rooms: %v", err)
	}
	foundFactory := false
	for _, r := range rooms {
		if r.Slug == "factory-floor" {
			foundFactory = true
			log.Printf("Room: %s (topics: %v)", r.Slug, r.Topics)
		}
	}
	if !foundFactory {
		log.Fatal("Expected factory-floor room from blueprint")
	}

	// Create actor tokens
	actor1, err := tAPI.Actors.Create(ctx, nolag.ActorCreate{
		Name:      fmt.Sprintf("iot-device-%d", time.Now().Unix()),
		ActorType: nolag.ActorDevice,
	})
	if err != nil {
		log.Fatalf("Failed to create actor 1: %v", err)
	}
	tToken1 = actor1.AccessToken
	tActor1ID = actor1.ActorTokenID
	log.Printf("Created device actor: %s", tActor1ID)

	actor2, err := tAPI.Actors.Create(ctx, nolag.ActorCreate{
		Name:      fmt.Sprintf("iot-controller-%d", time.Now().Unix()),
		ActorType: nolag.ActorDevice,
	})
	if err != nil {
		log.Fatalf("Failed to create actor 2: %v", err)
	}
	tToken2 = actor2.AccessToken
	tActor2ID = actor2.ActorTokenID
	log.Printf("Created controller actor: %s", tActor2ID)

	actor3, err := tAPI.Actors.Create(ctx, nolag.ActorCreate{
		Name:      fmt.Sprintf("iot-device2-%d", time.Now().Unix()),
		ActorType: nolag.ActorDevice,
	})
	if err != nil {
		log.Fatalf("Failed to create actor 3: %v", err)
	}
	tToken3 = actor3.AccessToken
	tActor3ID = actor3.ActorTokenID
	log.Printf("Created device2 actor: %s", tActor3ID)

	// Wait for actor provisioning
	time.Sleep(1 * time.Second)

	// Run tests
	code := m.Run()

	// Cleanup
	cleanupCtx := context.Background()
	for _, id := range []string{tActor1ID, tActor2ID, tActor3ID} {
		if err := tAPI.Actors.Delete(cleanupCtx, id); err != nil {
			log.Printf("Warning: cleanup actor %s: %v", id, err)
		}
	}
	if err := tAPI.Apps.Delete(cleanupCtx, tAppID); err != nil {
		log.Printf("Warning: cleanup app: %v", err)
	}
	log.Println("Cleaned up test resources")

	os.Exit(code)
}

// ── Helpers ─────────────────────────────────────────────────────────

func newIoT(t *testing.T, token string, role DeviceRole, deviceID string) *NoLagIoT {
	t.Helper()
	return New(token, NoLagIoTOptions{
		DeviceID:   deviceID,
		DeviceName: deviceID,
		Role:       role,
		AppName:    tAppSlug,
		URL:        tBrokerURL,
		Debug:      false,
		Reconnect:  false,
		CommandTimeout: 10000,
	})
}

func connectIoT(t *testing.T, token string, role DeviceRole, deviceID string) *NoLagIoT {
	t.Helper()
	client := newIoT(t, token, role, deviceID)
	if err := client.Connect(); err != nil {
		t.Fatalf("IoT connect failed: %v", err)
	}
	return client
}

// ═══════════════════════════════════════════════════════════════════
// BLUEPRINT VALIDATION
// ═══════════════════════════════════════════════════════════════════

func TestIoT_BlueprintCreated(t *testing.T) {
	ctx := context.Background()

	// Verify app exists
	app, err := tAPI.Apps.Get(ctx, tAppID)
	if err != nil {
		t.Fatalf("get app: %v", err)
	}
	if app.BlueprintID != "nolag-iot-sdk" {
		t.Fatalf("expected blueprintId nolag-iot-sdk, got %s", app.BlueprintID)
	}

	// Verify rooms
	rooms, err := tAPI.Rooms.List(ctx, tAppID)
	if err != nil {
		t.Fatalf("list rooms: %v", err)
	}

	var factory *nolag.RoomResource
	for i := range rooms {
		if rooms[i].Slug == "factory-floor" {
			factory = &rooms[i]
		}
	}
	if factory == nil {
		t.Fatal("factory-floor room not found")
	}

	// Verify topics
	topicSet := make(map[string]bool)
	for _, topic := range factory.Topics {
		topicSet[topic] = true
	}
	for _, expected := range []string{"telemetry", "commands", "_cmd_ack"} {
		if !topicSet[expected] {
			t.Errorf("missing topic %s in factory-floor room", expected)
		}
	}
	t.Logf("blueprint OK: app=%s room=%s topics=%v", app.Slug, factory.Slug, factory.Topics)
}

// ═══════════════════════════════════════════════════════════════════
// CONNECTION & DEVICE IDENTITY
// ═══════════════════════════════════════════════════════════════════

func TestIoT_ConnectDevice(t *testing.T) {
	dev := connectIoT(t, tToken1, RoleDevice, "sensor-01")
	defer dev.Disconnect()

	if !dev.Connected() {
		t.Fatal("device not connected")
	}
	if dev.LocalDevice() == nil {
		t.Fatal("local device not set")
	}
	if dev.LocalDevice().DeviceID != "sensor-01" {
		t.Fatalf("expected deviceId sensor-01, got %s", dev.LocalDevice().DeviceID)
	}
	if dev.LocalDevice().Role != RoleDevice {
		t.Fatalf("expected role device, got %s", dev.LocalDevice().Role)
	}
	if !dev.LocalDevice().IsLocal {
		t.Fatal("expected isLocal=true")
	}
	t.Logf("device: id=%s actor=%s role=%s", dev.LocalDevice().DeviceID, dev.LocalDevice().ActorTokenID, dev.LocalDevice().Role)
}

func TestIoT_ConnectController(t *testing.T) {
	ctrl := connectIoT(t, tToken2, RoleController, "dashboard-01")
	defer ctrl.Disconnect()

	if !ctrl.Connected() {
		t.Fatal("controller not connected")
	}
	if ctrl.LocalDevice().Role != RoleController {
		t.Fatalf("expected role controller, got %s", ctrl.LocalDevice().Role)
	}
}

func TestIoT_AutoDeviceID(t *testing.T) {
	client := New(tToken1, NoLagIoTOptions{
		AppName:   tAppSlug,
		URL:       tBrokerURL,
		Reconnect: false,
	})
	if err := client.Connect(); err != nil {
		t.Fatal(err)
	}
	defer client.Disconnect()

	if client.LocalDevice().DeviceID == "" {
		t.Fatal("auto-generated deviceId should not be empty")
	}
	if len(client.LocalDevice().DeviceID) < 10 {
		t.Fatalf("auto deviceId too short: %s", client.LocalDevice().DeviceID)
	}
	t.Logf("auto deviceId: %s", client.LocalDevice().DeviceID)
}

func TestIoT_DisconnectEvents(t *testing.T) {
	dev := connectIoT(t, tToken1, RoleDevice, "event-test")

	var connected, disconnected atomic.Bool
	dev.On("connected", func(args ...any) { connected.Store(true) })
	// connected already fired during Connect(), re-check
	dev.On("disconnected", func(args ...any) { disconnected.Store(true) })

	dev.Disconnect()
	time.Sleep(100 * time.Millisecond)

	if !disconnected.Load() {
		t.Error("disconnected event not fired")
	}
}

// ═══════════════════════════════════════════════════════════════════
// GROUP MANAGEMENT
// ═══════════════════════════════════════════════════════════════════

func TestIoT_JoinGroup(t *testing.T) {
	dev := connectIoT(t, tToken1, RoleDevice, "group-test")
	defer dev.Disconnect()

	group, err := dev.JoinGroup("factory-floor")
	if err != nil {
		t.Fatalf("join group: %v", err)
	}
	if group.Name() != "factory-floor" {
		t.Fatalf("expected name factory-floor, got %s", group.Name())
	}
	if len(dev.GetGroups()) != 1 {
		t.Fatalf("expected 1 group, got %d", len(dev.GetGroups()))
	}
}

func TestIoT_JoinGroupIdempotent(t *testing.T) {
	dev := connectIoT(t, tToken1, RoleDevice, "idem-test")
	defer dev.Disconnect()

	g1, _ := dev.JoinGroup("factory-floor")
	g2, _ := dev.JoinGroup("factory-floor")
	if g1 != g2 {
		t.Fatal("joinGroup should be idempotent (return same instance)")
	}
}

func TestIoT_LeaveGroup(t *testing.T) {
	dev := connectIoT(t, tToken1, RoleDevice, "leave-test")
	defer dev.Disconnect()

	dev.JoinGroup("factory-floor")
	if len(dev.GetGroups()) != 1 {
		t.Fatal("expected 1 group after join")
	}

	dev.LeaveGroup("factory-floor")
	if len(dev.GetGroups()) != 0 {
		t.Fatal("expected 0 groups after leave")
	}
}

func TestIoT_AutoJoinGroups(t *testing.T) {
	client := New(tToken1, NoLagIoTOptions{
		DeviceID:  "auto-join-test",
		AppName:   tAppSlug,
		URL:       tBrokerURL,
		Reconnect: false,
		Groups:    []string{"factory-floor"},
	})
	if err := client.Connect(); err != nil {
		t.Fatal(err)
	}
	defer client.Disconnect()

	if len(client.GetGroups()) != 1 {
		t.Fatalf("expected 1 auto-joined group, got %d", len(client.GetGroups()))
	}
	if client.GetGroup("factory-floor") == nil {
		t.Fatal("factory-floor should be auto-joined")
	}
}

// ═══════════════════════════════════════════════════════════════════
// TELEMETRY
// ═══════════════════════════════════════════════════════════════════

func TestIoT_SendTelemetry(t *testing.T) {
	dev := connectIoT(t, tToken1, RoleDevice, "sensor-temp")
	defer dev.Disconnect()

	group, _ := dev.JoinGroup("factory-floor")

	reading := group.SendTelemetry("temperature", 23.5, SendTelemetryOptions{
		Unit: "°C",
		Tags: map[string]string{"location": "north"},
	})

	if reading == nil {
		t.Fatal("reading should not be nil")
	}
	if reading.SensorID != "temperature" {
		t.Fatalf("expected sensorId temperature, got %s", reading.SensorID)
	}
	if reading.Value != 23.5 {
		t.Fatalf("expected value 23.5, got %v", reading.Value)
	}
	if reading.Unit != "°C" {
		t.Fatalf("expected unit °C, got %s", reading.Unit)
	}
	if reading.DeviceID != "sensor-temp" {
		t.Fatalf("expected deviceId sensor-temp, got %s", reading.DeviceID)
	}
	t.Logf("sent telemetry: id=%s sensor=%s value=%v unit=%s", reading.ID, reading.SensorID, reading.Value, reading.Unit)
}

func TestIoT_ReceiveTelemetry(t *testing.T) {
	dev := connectIoT(t, tToken1, RoleDevice, "sensor-rx")
	ctrl := connectIoT(t, tToken2, RoleController, "ctrl-rx")
	defer dev.Disconnect()
	defer ctrl.Disconnect()

	devGroup, _ := dev.JoinGroup("factory-floor")
	ctrlGroup, _ := ctrl.JoinGroup("factory-floor")
	time.Sleep(500 * time.Millisecond)

	done := make(chan TelemetryReading, 1)
	ctrlGroup.On("telemetry", func(args ...any) {
		if len(args) > 0 {
			if r, ok := args[0].(TelemetryReading); ok {
				if r.DeviceID == "sensor-rx" {
					done <- r
				}
			}
		}
	})

	devGroup.SendTelemetry("humidity", 65.2, SendTelemetryOptions{Unit: "%"})

	select {
	case r := <-done:
		if r.SensorID != "humidity" {
			t.Fatalf("expected sensorId humidity, got %s", r.SensorID)
		}
		t.Logf("received telemetry: device=%s sensor=%s value=%v", r.DeviceID, r.SensorID, r.Value)
	case <-time.After(10 * time.Second):
		t.Fatal("timeout waiting for telemetry")
	}
}

func TestIoT_TelemetryBuffer(t *testing.T) {
	dev := connectIoT(t, tToken1, RoleDevice, "sensor-buf")
	defer dev.Disconnect()

	group, _ := dev.JoinGroup("factory-floor")

	// Send multiple readings
	for i := 0; i < 5; i++ {
		group.SendTelemetry("temp", float64(20+i))
	}

	readings := group.GetTelemetry("sensor-buf", "temp")
	if len(readings) != 5 {
		t.Fatalf("expected 5 buffered readings, got %d", len(readings))
	}
	t.Logf("buffered %d readings", len(readings))
}

func TestIoT_TelemetryMultiSensor(t *testing.T) {
	dev := connectIoT(t, tToken1, RoleDevice, "multi-sensor")
	defer dev.Disconnect()

	group, _ := dev.JoinGroup("factory-floor")

	group.SendTelemetry("temp", 22.0)
	group.SendTelemetry("humidity", 55.0)
	group.SendTelemetry("pressure", 1013.0)

	all := group.GetTelemetry("multi-sensor", "")
	if len(all) != 3 {
		t.Fatalf("expected 3 readings across sensors, got %d", len(all))
	}

	tempOnly := group.GetTelemetry("multi-sensor", "temp")
	if len(tempOnly) != 1 {
		t.Fatalf("expected 1 temp reading, got %d", len(tempOnly))
	}
}

func TestIoT_RapidTelemetry(t *testing.T) {
	dev := connectIoT(t, tToken1, RoleDevice, "rapid-sensor")
	ctrl := connectIoT(t, tToken2, RoleController, "rapid-ctrl")
	defer dev.Disconnect()
	defer ctrl.Disconnect()

	devGroup, _ := dev.JoinGroup("factory-floor")
	ctrlGroup, _ := ctrl.JoinGroup("factory-floor")
	time.Sleep(500 * time.Millisecond)

	msgCount := 10
	var received atomic.Int32
	done := make(chan bool, 1)

	ctrlGroup.On("telemetry", func(args ...any) {
		if len(args) > 0 {
			if r, ok := args[0].(TelemetryReading); ok {
				if r.DeviceID == "rapid-sensor" {
					if received.Add(1) >= int32(msgCount) {
						select {
						case done <- true:
						default:
						}
					}
				}
			}
		}
	})

	for i := 0; i < msgCount; i++ {
		devGroup.SendTelemetry("counter", i)
	}

	select {
	case <-done:
		t.Logf("received %d/%d rapid telemetry readings", received.Load(), msgCount)
	case <-time.After(10 * time.Second):
		t.Fatalf("timeout: received %d/%d", received.Load(), msgCount)
	}
}

// ═══════════════════════════════════════════════════════════════════
// COMMANDS
// ═══════════════════════════════════════════════════════════════════

func TestIoT_SendAndReceiveCommand(t *testing.T) {
	dev := connectIoT(t, tToken1, RoleDevice, "actuator-01")
	ctrl := connectIoT(t, tToken2, RoleController, "controller-01")
	defer dev.Disconnect()
	defer ctrl.Disconnect()

	devGroup, _ := dev.JoinGroup("factory-floor")
	ctrlGroup, _ := ctrl.JoinGroup("factory-floor")
	time.Sleep(500 * time.Millisecond)

	// Device listens for commands
	cmdReceived := make(chan DeviceCommand, 1)
	devGroup.On("command", func(args ...any) {
		if len(args) > 0 {
			if cmd, ok := args[0].(DeviceCommand); ok {
				cmdReceived <- cmd
			}
		}
	})

	// Controller sends command
	cmd, ackCh := ctrlGroup.SendCommand("actuator-01", "set-speed", map[string]any{"rpm": 1500})
	if cmd.Status != StatusPending {
		t.Fatalf("expected pending status, got %s", cmd.Status)
	}
	t.Logf("sent command: id=%s target=%s cmd=%s", cmd.ID, cmd.TargetDeviceID, cmd.Command)

	// Device receives command
	select {
	case received := <-cmdReceived:
		if received.Command != "set-speed" {
			t.Fatalf("expected command set-speed, got %s", received.Command)
		}
		if received.SentBy != "controller-01" {
			t.Fatalf("expected sentBy controller-01, got %s", received.SentBy)
		}
		t.Logf("device received command: %s from %s", received.Command, received.SentBy)

		// Device acks the command
		devGroup.AckCommand(received.ID, StatusCompleted, map[string]any{"actual_rpm": 1500})
	case <-time.After(10 * time.Second):
		t.Fatal("timeout waiting for command on device")
	}

	// Controller receives ack
	select {
	case acked := <-ackCh:
		if acked.Status != StatusCompleted {
			t.Fatalf("expected completed status, got %s", acked.Status)
		}
		t.Logf("command acked: status=%s", acked.Status)
	case <-time.After(10 * time.Second):
		t.Fatal("timeout waiting for command ack")
	}
}

func TestIoT_CommandAckEvent(t *testing.T) {
	dev := connectIoT(t, tToken1, RoleDevice, "ack-device")
	ctrl := connectIoT(t, tToken2, RoleController, "ack-ctrl")
	defer dev.Disconnect()
	defer ctrl.Disconnect()

	devGroup, _ := dev.JoinGroup("factory-floor")
	ctrlGroup, _ := ctrl.JoinGroup("factory-floor")
	time.Sleep(500 * time.Millisecond)

	// Listen for commandAck event
	ackEvent := make(chan DeviceCommand, 1)
	ctrlGroup.On("commandAck", func(args ...any) {
		if len(args) > 0 {
			if cmd, ok := args[0].(DeviceCommand); ok {
				ackEvent <- cmd
			}
		}
	})

	// Device auto-acks commands
	devGroup.On("command", func(args ...any) {
		if len(args) > 0 {
			if cmd, ok := args[0].(DeviceCommand); ok {
				devGroup.AckCommand(cmd.ID, StatusAcked, nil)
			}
		}
	})

	ctrlGroup.SendCommand("ack-device", "ping", nil)

	select {
	case cmd := <-ackEvent:
		if cmd.Status != StatusAcked {
			t.Fatalf("expected acked, got %s", cmd.Status)
		}
		t.Logf("commandAck event: id=%s status=%s", cmd.ID, cmd.Status)
	case <-time.After(10 * time.Second):
		t.Fatal("timeout waiting for commandAck event")
	}
}

func TestIoT_CommandTimeout(t *testing.T) {
	ctrl := connectIoT(t, tToken2, RoleController, "timeout-ctrl")
	defer ctrl.Disconnect()

	group, _ := ctrl.JoinGroup("factory-floor")
	time.Sleep(300 * time.Millisecond)

	// Send command to non-existent device with short timeout
	_, ackCh := group.SendCommand("nonexistent-device", "ping", nil, 2000)

	select {
	case cmd := <-ackCh:
		if cmd.Status != StatusTimeout {
			t.Fatalf("expected timeout status, got %s", cmd.Status)
		}
		t.Logf("command timed out as expected: %s", cmd.Error)
	case <-time.After(5 * time.Second):
		t.Fatal("test timeout - command timeout didn't fire")
	}
}

// ═══════════════════════════════════════════════════════════════════
// PRESENCE
// ═══════════════════════════════════════════════════════════════════

func TestIoT_DevicePresenceJoin(t *testing.T) {
	ctrl := connectIoT(t, tToken2, RoleController, "presence-ctrl")
	defer ctrl.Disconnect()

	ctrlGroup, _ := ctrl.JoinGroup("factory-floor")
	time.Sleep(500 * time.Millisecond)

	// Listen for deviceJoined
	joined := make(chan Device, 1)
	ctrlGroup.On("deviceJoined", func(args ...any) {
		if len(args) > 0 {
			if dev, ok := args[0].(Device); ok {
				if dev.DeviceID == "late-joiner" {
					joined <- dev
				}
			}
		}
	})

	// Now connect a device
	dev := connectIoT(t, tToken1, RoleDevice, "late-joiner")
	defer dev.Disconnect()
	dev.JoinGroup("factory-floor")

	select {
	case d := <-joined:
		if d.DeviceID != "late-joiner" {
			t.Fatalf("expected deviceId late-joiner, got %s", d.DeviceID)
		}
		if d.Role != RoleDevice {
			t.Fatalf("expected role device, got %s", d.Role)
		}
		t.Logf("device joined: id=%s role=%s", d.DeviceID, d.Role)
	case <-time.After(5 * time.Second):
		t.Fatal("timeout waiting for deviceJoined event")
	}
}

func TestIoT_DevicePresenceLeave(t *testing.T) {
	ctrl := connectIoT(t, tToken2, RoleController, "leave-ctrl")
	defer ctrl.Disconnect()

	ctrlGroup, _ := ctrl.JoinGroup("factory-floor")
	time.Sleep(500 * time.Millisecond)

	// Connect a device
	dev := connectIoT(t, tToken1, RoleDevice, "leaver")
	dev.JoinGroup("factory-floor")
	time.Sleep(500 * time.Millisecond)

	// Listen for deviceLeft
	left := make(chan Device, 1)
	ctrlGroup.On("deviceLeft", func(args ...any) {
		if len(args) > 0 {
			if d, ok := args[0].(Device); ok {
				if d.DeviceID == "leaver" {
					left <- d
				}
			}
		}
	})

	// Disconnect device
	dev.Disconnect()

	select {
	case d := <-left:
		t.Logf("device left: id=%s", d.DeviceID)
	case <-time.After(5 * time.Second):
		t.Fatal("timeout waiting for deviceLeft event")
	}
}

func TestIoT_GlobalOnlineOffline(t *testing.T) {
	ctrl := connectIoT(t, tToken2, RoleController, "global-ctrl")
	defer ctrl.Disconnect()
	ctrl.JoinGroup("factory-floor")
	time.Sleep(500 * time.Millisecond)

	online := make(chan Device, 1)
	ctrl.On("deviceOnline", func(args ...any) {
		if len(args) > 0 {
			if d, ok := args[0].(Device); ok {
				if d.DeviceID == "global-sensor" {
					online <- d
				}
			}
		}
	})

	dev := connectIoT(t, tToken1, RoleDevice, "global-sensor")
	dev.JoinGroup("factory-floor")

	select {
	case d := <-online:
		t.Logf("deviceOnline: %s (role: %s)", d.DeviceID, d.Role)
	case <-time.After(5 * time.Second):
		t.Fatal("timeout waiting for deviceOnline")
	}

	dev.Disconnect()
}

// ═══════════════════════════════════════════════════════════════════
// TELEMETRY STORE (unit-level)
// ═══════════════════════════════════════════════════════════════════

func TestIoT_TelemetryStoreDedup(t *testing.T) {
	store := NewTelemetryStore(100)

	reading := TelemetryReading{ID: "r1", DeviceID: "d1", SensorID: "s1", Value: 42}
	ok1 := store.Add(reading)
	ok2 := store.Add(reading)

	if !ok1 {
		t.Fatal("first add should return true")
	}
	if ok2 {
		t.Fatal("duplicate add should return false")
	}
	if store.Size() != 1 {
		t.Fatalf("expected size 1, got %d", store.Size())
	}
}

func TestIoT_TelemetryStoreCapacity(t *testing.T) {
	store := NewTelemetryStore(3)

	for i := 0; i < 5; i++ {
		store.Add(TelemetryReading{
			ID: fmt.Sprintf("r%d", i), DeviceID: "d1", SensorID: "s1", Value: i,
		})
	}

	if store.Size() != 3 {
		t.Fatalf("expected size 3 (capped), got %d", store.Size())
	}

	// Oldest should be evicted
	if store.Has("r0") || store.Has("r1") {
		t.Fatal("oldest readings should be evicted")
	}
	if !store.Has("r2") || !store.Has("r3") || !store.Has("r4") {
		t.Fatal("newest readings should be present")
	}
}

func TestIoT_TelemetryStoreGetLatest(t *testing.T) {
	store := NewTelemetryStore(100)
	store.Add(TelemetryReading{ID: "r1", DeviceID: "d1", SensorID: "temp", Value: 20})
	store.Add(TelemetryReading{ID: "r2", DeviceID: "d1", SensorID: "temp", Value: 25})

	latest := store.GetLatest("d1", "temp")
	if latest == nil || latest.Value != 25 {
		t.Fatalf("expected latest value 25, got %v", latest)
	}
}

// ═══════════════════════════════════════════════════════════════════
// COMMAND MANAGER (unit-level)
// ═══════════════════════════════════════════════════════════════════

func TestIoT_CommandManagerSendAck(t *testing.T) {
	cm := NewCommandManager(5000)

	cmd, ackCh := cm.Send("dev-1", "reboot", nil, "ctrl-1")
	if cmd.Status != StatusPending {
		t.Fatalf("expected pending, got %s", cmd.Status)
	}
	if len(cm.GetPending()) != 1 {
		t.Fatalf("expected 1 pending, got %d", len(cm.GetPending()))
	}

	result := cm.Ack(cmd.ID, StatusCompleted, "ok")
	if result == nil {
		t.Fatal("ack should return command")
	}
	if result.Status != StatusCompleted {
		t.Fatalf("expected completed, got %s", result.Status)
	}

	select {
	case acked := <-ackCh:
		if acked.Status != StatusCompleted {
			t.Fatalf("expected completed from channel, got %s", acked.Status)
		}
	case <-time.After(1 * time.Second):
		t.Fatal("ack channel should resolve immediately")
	}

	if len(cm.GetPending()) != 0 {
		t.Fatalf("expected 0 pending after ack, got %d", len(cm.GetPending()))
	}
}

func TestIoT_CommandManagerDispose(t *testing.T) {
	cm := NewCommandManager(30000)
	_, ackCh := cm.Send("dev-1", "test", nil, "ctrl-1")

	cm.Dispose()

	select {
	case cmd := <-ackCh:
		if cmd.Status != StatusFailed {
			t.Fatalf("expected failed after dispose, got %s", cmd.Status)
		}
	case <-time.After(1 * time.Second):
		t.Fatal("dispose should resolve pending commands")
	}
}

// ═══════════════════════════════════════════════════════════════════
// PRESENCE MANAGER (unit-level)
// ═══════════════════════════════════════════════════════════════════

func TestIoT_PresenceManagerAddRemove(t *testing.T) {
	pm := NewPresenceManager("local-actor")

	// Should skip local actor
	dev := pm.AddFromPresence("local-actor", IoTPresenceData{DeviceID: "local"}, 0)
	if dev != nil {
		t.Fatal("should skip local actor")
	}

	// Add remote device
	remote := pm.AddFromPresence("remote-actor", IoTPresenceData{
		DeviceID:   "remote-1",
		DeviceName: "Remote Sensor",
		Role:       RoleDevice,
	}, 0)
	if remote == nil {
		t.Fatal("should add remote device")
	}
	if remote.DeviceID != "remote-1" {
		t.Fatalf("expected deviceId remote-1, got %s", remote.DeviceID)
	}

	// Get by ID
	got := pm.GetDevice("remote-1")
	if got == nil {
		t.Fatal("should find by deviceId")
	}

	// Get by actor ID
	gotByActor := pm.GetDeviceByActorID("remote-actor")
	if gotByActor == nil {
		t.Fatal("should find by actorTokenId")
	}

	// Remove
	removed := pm.RemoveByActorID("remote-actor")
	if removed == nil {
		t.Fatal("should return removed device")
	}
	if pm.GetDevice("remote-1") != nil {
		t.Fatal("device should be gone after remove")
	}
}

// ═══════════════════════════════════════════════════════════════════
// END-TO-END: FULL WORKFLOW
// ═══════════════════════════════════════════════════════════════════

func TestIoT_FullWorkflow(t *testing.T) {
	// Set up: 1 controller + 2 devices
	ctrl := connectIoT(t, tToken2, RoleController, "ctrl-main")
	dev1 := connectIoT(t, tToken1, RoleDevice, "temp-sensor")
	dev2 := connectIoT(t, tToken3, RoleDevice, "motor-01")
	defer ctrl.Disconnect()
	defer dev1.Disconnect()
	defer dev2.Disconnect()

	ctrlGroup, _ := ctrl.JoinGroup("factory-floor")
	dev1Group, _ := dev1.JoinGroup("factory-floor")
	dev2Group, _ := dev2.JoinGroup("factory-floor")
	time.Sleep(1 * time.Second)

	// ── Step 1: Devices send telemetry ──
	var telemetryCount atomic.Int32
	var mu sync.Mutex
	var receivedSensors []string
	done := make(chan bool, 1)

	ctrlGroup.On("telemetry", func(args ...any) {
		if len(args) > 0 {
			if r, ok := args[0].(TelemetryReading); ok {
				mu.Lock()
				receivedSensors = append(receivedSensors, r.SensorID)
				mu.Unlock()
				if telemetryCount.Add(1) >= 3 {
					select {
					case done <- true:
					default:
					}
				}
			}
		}
	})

	dev1Group.SendTelemetry("temperature", 24.5, SendTelemetryOptions{Unit: "°C"})
	dev1Group.SendTelemetry("humidity", 62.0, SendTelemetryOptions{Unit: "%"})
	dev2Group.SendTelemetry("rpm", 1200)

	select {
	case <-done:
		mu.Lock()
		t.Logf("controller received %d telemetry readings: %v", len(receivedSensors), receivedSensors)
		mu.Unlock()
	case <-time.After(10 * time.Second):
		t.Fatalf("timeout: received %d/3 telemetry", telemetryCount.Load())
	}

	// ── Step 2: Controller sends command to motor ──
	cmdDone := make(chan DeviceCommand, 1)
	dev2Group.On("command", func(args ...any) {
		if len(args) > 0 {
			if cmd, ok := args[0].(DeviceCommand); ok {
				// Motor processes command and acks
				dev2Group.AckCommand(cmd.ID, StatusCompleted, map[string]any{"new_rpm": 1500})
				cmdDone <- cmd
			}
		}
	})

	cmd, ackCh := ctrlGroup.SendCommand("motor-01", "set-speed", map[string]any{"target_rpm": 1500})
	t.Logf("sent command: %s to %s", cmd.Command, cmd.TargetDeviceID)

	// Wait for device to receive
	select {
	case received := <-cmdDone:
		t.Logf("motor received command: %s (params: %v)", received.Command, received.Params)
	case <-time.After(10 * time.Second):
		t.Fatal("timeout waiting for command on device")
	}

	// Wait for ack
	select {
	case acked := <-ackCh:
		if acked.Status != StatusCompleted {
			t.Fatalf("expected completed, got %s", acked.Status)
		}
		t.Logf("command completed: result=%v", acked.Result)
	case <-time.After(10 * time.Second):
		t.Fatal("timeout waiting for command ack")
	}

	t.Log("full IoT workflow passed")
}
