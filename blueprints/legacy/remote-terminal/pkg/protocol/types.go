package protocol

import (
	"crypto/rand"
	"encoding/hex"
)

// Command types
const (
	CmdTypeShell      = "shell"      // Execute shell command
	CmdTypeInfo       = "info"       // Get system info
	CmdTypePing       = "ping"       // Ping device
	CmdTypeKill       = "kill"       // Kill running process
	CmdTypeComplete   = "complete"   // Tab completion request
	CmdTypeUpload     = "upload"     // Upload file to device
	CmdTypeDownload   = "download"   // Download file from device
	CmdTypeListDir    = "listdir"    // List directory contents

	// Interactive session commands
	CmdTypeSessionStart  = "session_start"  // Start interactive PTY session
	CmdTypeSessionInput  = "session_input"  // Send input to PTY session
	CmdTypeSessionResize = "session_resize" // Resize PTY session
	CmdTypeSessionEnd    = "session_end"    // End PTY session
)

// Topics
const (
	TopicCommands      = "commands"
	TopicResponses     = "responses"
	TopicStatus        = "status"
	TopicDiscovery     = "discovery"      // For device discovery
	TopicSessionOutput = "session_output" // PTY session output stream
)

// App name for NoLag scoping
const AppName = "remote-terminal"

// Command represents a command sent from client to agent
type Command struct {
	ID        string `json:"id"`
	Type      string `json:"type"`
	Payload   string `json:"payload"`
	Data      []byte `json:"data,omitempty"`      // For file transfers
	Timestamp int64  `json:"timestamp"`           // Unix timestamp (avoid msgpack extension issues)
}

// Response represents a response from agent to client
type Response struct {
	CommandID   string   `json:"commandId"`
	Status      string   `json:"status"` // "success", "error", "running"
	Output      string   `json:"output"`
	Error       string   `json:"error,omitempty"`
	ExitCode    int      `json:"exitCode"`
	Data        []byte   `json:"data,omitempty"`        // For file downloads
	Completions []string `json:"completions,omitempty"` // For tab completion
}

// DeviceStatus represents periodic status updates from agent
type DeviceStatus struct {
	DeviceID  string `json:"deviceId"`
	Hostname  string `json:"hostname"`
	OS        string `json:"os"`
	Arch      string `json:"arch"`
	Online    bool   `json:"online"`
	Timestamp int64  `json:"timestamp"` // Unix timestamp
	WorkDir   string `json:"workDir,omitempty"`
}

// FileInfo represents file information for directory listings
type FileInfo struct {
	Name    string `json:"name"`
	Size    int64  `json:"size"`
	IsDir   bool   `json:"isDir"`
	ModTime int64  `json:"modTime"` // Unix timestamp
}

// SessionStartPayload is the payload for session_start command
type SessionStartPayload struct {
	Cols int `json:"cols"`
	Rows int `json:"rows"`
}

// SessionInputPayload is the payload for session_input command
type SessionInputPayload struct {
	SessionID string `json:"sessionId"`
	Data      string `json:"data"` // Base64 encoded input
}

// SessionResizePayload is the payload for session_resize command
type SessionResizePayload struct {
	SessionID string `json:"sessionId"`
	Cols      int    `json:"cols"`
	Rows      int    `json:"rows"`
}

// SessionEndPayload is the payload for session_end command
type SessionEndPayload struct {
	SessionID string `json:"sessionId"`
}

// SessionOutput represents output from a PTY session
type SessionOutput struct {
	SessionID string `json:"sessionId"`
	Data      string `json:"data"`             // Base64 encoded output
	Closed    bool   `json:"closed,omitempty"` // True when session ended
}

// SessionStarted is sent as response when a session starts
type SessionStarted struct {
	SessionID string `json:"sessionId"`
}

// GenerateID creates a unique command ID
func GenerateID() string {
	bytes := make([]byte, 8)
	rand.Read(bytes)
	return hex.EncodeToString(bytes)
}
