package iot

// DeviceRole represents the role of a device in the IoT network.
type DeviceRole string

const (
	RoleDevice     DeviceRole = "device"
	RoleController DeviceRole = "controller"
)

// CommandStatus represents the lifecycle status of a command.
type CommandStatus string

const (
	StatusPending   CommandStatus = "pending"
	StatusAcked     CommandStatus = "acked"
	StatusCompleted CommandStatus = "completed"
	StatusFailed    CommandStatus = "failed"
	StatusTimeout   CommandStatus = "timeout"
)

// Device represents an IoT device tracked via presence.
type Device struct {
	DeviceID     string                 `json:"deviceId"`
	ActorTokenID string                 `json:"actorTokenId"`
	DeviceName   string                 `json:"deviceName,omitempty"`
	Role         DeviceRole             `json:"role"`
	Metadata     map[string]any         `json:"metadata,omitempty"`
	JoinedAt     int64                  `json:"joinedAt"`
	IsLocal      bool                   `json:"isLocal"`
}

// TelemetryReading represents a single sensor reading.
type TelemetryReading struct {
	ID        string         `json:"id"`
	DeviceID  string         `json:"deviceId"`
	SensorID  string         `json:"sensorId"`
	Value     any            `json:"value"`
	Unit      string         `json:"unit,omitempty"`
	Tags      map[string]string `json:"tags,omitempty"`
	Timestamp int64          `json:"timestamp"`
	IsReplay  bool           `json:"isReplay"`
}

// DeviceCommand represents a command sent to a device.
type DeviceCommand struct {
	ID             string         `json:"id"`
	TargetDeviceID string         `json:"targetDeviceId"`
	Command        string         `json:"command"`
	Params         map[string]any `json:"params,omitempty"`
	Status         CommandStatus  `json:"status"`
	SentBy         string         `json:"sentBy"`
	SentAt         int64          `json:"sentAt"`
	AckedAt        int64          `json:"ackedAt,omitempty"`
	CompletedAt    int64          `json:"completedAt,omitempty"`
	Result         any            `json:"result,omitempty"`
	Error          string         `json:"error,omitempty"`
}

// IoTPresenceData is the presence payload stored in NoLag.
type IoTPresenceData struct {
	DeviceID   string         `json:"deviceId"`
	DeviceName string         `json:"deviceName,omitempty"`
	Role       DeviceRole     `json:"role"`
	Metadata   map[string]any `json:"metadata,omitempty"`
}

// SendTelemetryOptions are options for sending telemetry.
type SendTelemetryOptions struct {
	Unit string
	Tags map[string]string
}
