package iot

const (
	DefaultAppName            = "iot"
	DefaultMaxTelemetryPoints = 1000
	DefaultCommandTimeout     = 30000 // ms

	TopicTelemetry = "telemetry"
	TopicCommands  = "commands"
	TopicCmdAck    = "_cmd_ack"

	LobbyID = "online"
)
