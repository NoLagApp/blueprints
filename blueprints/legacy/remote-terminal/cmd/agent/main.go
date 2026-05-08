package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"flag"
	"fmt"
	"io/fs"
	"log"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"time"

	nolag "github.com/NoLagApp/nolag-go"
	"github.com/nolag/remote-terminal/pkg/protocol"
)

var (
	token    = flag.String("token", "", "NoLag actor token (required)")
	apiKey   = flag.String("apikey", "", "NoLag API key (required for dynamic room creation)")
	appID    = flag.String("appid", "", "NoLag App ID (required for dynamic room creation)")
	deviceID = flag.String("device", "", "Device ID (defaults to hostname)")
	broker   = flag.String("broker", "wss://broker.nolag.app/ws", "NoLag broker URL")
	apiURL   = flag.String("api", "https://api.nolag.app/v1", "NoLag API URL")
	debug    = flag.Bool("debug", false, "Enable debug logging")
)

var workDir string
var sessionManager *SessionManager

func main() {
	flag.Parse()

	if *token == "" {
		log.Fatal("Error: -token is required")
	}

	if *apiKey == "" {
		log.Fatal("Error: -apikey is required for dynamic room creation")
	}

	if *appID == "" {
		log.Fatal("Error: -appid is required for dynamic room creation")
	}

	// Default device ID to hostname
	if *deviceID == "" {
		hostname, err := os.Hostname()
		if err != nil {
			log.Fatal("Failed to get hostname:", err)
		}
		*deviceID = hostname
	}

	// Initialize working directory
	var err error
	workDir, err = os.Getwd()
	if err != nil {
		workDir = "/"
	}

	log.Printf("Starting remote-terminal agent...")
	log.Printf("Device ID: %s", *deviceID)
	log.Printf("Working directory: %s", workDir)

	// Create the room dynamically via API (topics inherited from App)
	api := nolag.NewAPI(*apiKey, nolag.APIOptions{
		BaseURL: *apiURL,
	})

	log.Printf("Creating room '%s' for this device...", *deviceID)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	_, err = api.Rooms.Create(ctx, *appID, nolag.RoomCreate{
		Name: "Device: " + *deviceID,
		Slug: *deviceID,
	})
	cancel()
	if err != nil {
		// Room might already exist, which is fine
		log.Printf("Room creation: %v (may already exist)", err)
	} else {
		log.Printf("Room '%s' created successfully", *deviceID)
	}


	// Create NoLag client
	client := nolag.New(*token, nolag.Options{
		URL:                  *broker,
		Reconnect:            true,
		ReconnectInterval:    5 * time.Second,
		MaxReconnectAttempts: 0, // infinite
		Debug:                *debug,
	})

	// Connection events
	client.On("connected", func(args ...any) {
		log.Println("Connected to NoLag broker")
	})

	client.On("disconnected", func(args ...any) {
		log.Println("Disconnected from NoLag broker")
	})

	client.On("reconnecting", func(args ...any) {
		log.Println("Reconnecting...")
	})

	client.On("error", func(args ...any) {
		if len(args) > 0 {
			log.Printf("Error: %v", args[0])
		}
	})

	// Connect
	if err := client.Connect(); err != nil {
		log.Fatal("Failed to connect:", err)
	}

	// Create room for this device
	room := client.SetApp(protocol.AppName).SetRoom(*deviceID)

	// Initialize session manager
	sessionManager = NewSessionManager(room)

	// Subscribe to commands
	err = room.Subscribe(protocol.TopicCommands, func(data any, meta nolag.MessageMeta) {
		handleCommand(room, data, meta)
	})
	if err != nil {
		log.Fatal("Failed to subscribe to commands:", err)
	}
	log.Println("Subscribed to commands topic")


	// Start status broadcaster
	go broadcastStatus(room)

	// Wait for shutdown
	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)
	<-sigChan

	log.Println("Shutting down...")
	sessionManager.CloseAll()
	client.Close()
}

func handleCommand(room *nolag.Room, data any, meta nolag.MessageMeta) {
	// Parse command
	jsonData, err := json.Marshal(data)
	if err != nil {
		log.Printf("Failed to marshal command data: %v", err)
		return
	}

	var cmd protocol.Command
	if err := json.Unmarshal(jsonData, &cmd); err != nil {
		log.Printf("Failed to parse command: %v", err)
		return
	}

	log.Printf("Received command [%s]: %s - %s", cmd.ID, cmd.Type, cmd.Payload)

	var response protocol.Response
	response.CommandID = cmd.ID

	switch cmd.Type {
	case protocol.CmdTypeShell:
		output, exitCode, err := executeShell(cmd.Payload)
		response.Output = output
		response.ExitCode = exitCode
		if err != nil {
			response.Status = "error"
			response.Error = err.Error()
		} else {
			response.Status = "success"
		}

	case protocol.CmdTypePing:
		response.Status = "success"
		response.Output = "pong"

	case protocol.CmdTypeInfo:
		response.Status = "success"
		response.Output = getSystemInfo()

	case protocol.CmdTypeComplete:
		completions := getCompletions(cmd.Payload)
		response.Status = "success"
		response.Completions = completions

	case protocol.CmdTypeListDir:
		path := cmd.Payload
		if path == "" {
			path = workDir
		}
		output, err := listDirectory(path)
		if err != nil {
			response.Status = "error"
			response.Error = err.Error()
		} else {
			response.Status = "success"
			response.Output = output
		}

	case protocol.CmdTypeDownload:
		data, err := downloadFile(cmd.Payload)
		if err != nil {
			response.Status = "error"
			response.Error = err.Error()
		} else {
			response.Status = "success"
			response.Data = data
			response.Output = fmt.Sprintf("Downloaded %d bytes", len(data))
		}

	case protocol.CmdTypeUpload:
		err := uploadFile(cmd.Payload, cmd.Data)
		if err != nil {
			response.Status = "error"
			response.Error = err.Error()
		} else {
			response.Status = "success"
			response.Output = fmt.Sprintf("Uploaded %d bytes to %s", len(cmd.Data), cmd.Payload)
		}

	case protocol.CmdTypeSessionStart:
		handleSessionStart(room, cmd)
		return // Response handled separately

	case protocol.CmdTypeSessionInput:
		handleSessionInput(cmd)
		return // No response needed

	case protocol.CmdTypeSessionResize:
		handleSessionResize(cmd)
		return // No response needed

	case protocol.CmdTypeSessionEnd:
		handleSessionEnd(cmd)
		return // No response needed

	default:
		response.Status = "error"
		response.Error = "unknown command type: " + cmd.Type
	}

	// Send response
	if err := room.Emit(protocol.TopicResponses, response); err != nil {
		log.Printf("Failed to send response: %v", err)
	}
}

func executeShell(command string) (string, int, error) {
	var cmd *exec.Cmd

	// Handle cd command specially
	if strings.HasPrefix(command, "cd ") {
		newDir := strings.TrimPrefix(command, "cd ")
		newDir = strings.TrimSpace(newDir)

		// Expand ~ to home directory
		if strings.HasPrefix(newDir, "~") {
			home, _ := os.UserHomeDir()
			newDir = strings.Replace(newDir, "~", home, 1)
		}

		// Make absolute if relative
		if !filepath.IsAbs(newDir) {
			newDir = filepath.Join(workDir, newDir)
		}

		// Clean the path
		newDir = filepath.Clean(newDir)

		// Check if directory exists
		info, err := os.Stat(newDir)
		if err != nil {
			return "", 1, fmt.Errorf("cd: %s: No such file or directory", newDir)
		}
		if !info.IsDir() {
			return "", 1, fmt.Errorf("cd: %s: Not a directory", newDir)
		}

		workDir = newDir
		return fmt.Sprintf("Changed directory to %s", workDir), 0, nil
	}

	if runtime.GOOS == "windows" {
		cmd = exec.Command("cmd", "/C", command)
	} else {
		cmd = exec.Command("sh", "-c", command)
	}

	cmd.Dir = workDir
	cmd.Env = os.Environ() // Explicitly inherit environment
	output, err := cmd.CombinedOutput()

	exitCode := 0
	if err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok {
			exitCode = exitErr.ExitCode()
		} else {
			exitCode = 1
		}
	}

	return string(output), exitCode, err
}

func getSystemInfo() string {
	hostname, _ := os.Hostname()
	wd, _ := os.Getwd()

	info := fmt.Sprintf(`Hostname: %s
OS: %s
Architecture: %s
CPUs: %d
Working Directory: %s
Go Version: %s`,
		hostname,
		runtime.GOOS,
		runtime.GOARCH,
		runtime.NumCPU(),
		wd,
		runtime.Version(),
	)
	return info
}

func getCompletions(partial string) []string {
	var completions []string

	// If empty, return nothing
	if partial == "" {
		return completions
	}

	// Split into directory and prefix
	dir := filepath.Dir(partial)
	prefix := filepath.Base(partial)

	// Handle relative paths
	if !filepath.IsAbs(dir) {
		dir = filepath.Join(workDir, dir)
	}

	// If partial ends with separator, list that directory
	if strings.HasSuffix(partial, string(filepath.Separator)) || strings.HasSuffix(partial, "/") {
		dir = partial
		if !filepath.IsAbs(dir) {
			dir = filepath.Join(workDir, dir)
		}
		prefix = ""
	}

	// Read directory
	entries, err := os.ReadDir(dir)
	if err != nil {
		return completions
	}

	for _, entry := range entries {
		name := entry.Name()
		if prefix == "" || strings.HasPrefix(strings.ToLower(name), strings.ToLower(prefix)) {
			completion := name
			if entry.IsDir() {
				completion += string(filepath.Separator)
			}
			completions = append(completions, completion)
		}
	}

	// Limit to 20 completions
	if len(completions) > 20 {
		completions = completions[:20]
	}

	return completions
}

func listDirectory(path string) (string, error) {
	if !filepath.IsAbs(path) {
		path = filepath.Join(workDir, path)
	}

	entries, err := os.ReadDir(path)
	if err != nil {
		return "", err
	}

	var lines []string
	for _, entry := range entries {
		info, err := entry.Info()
		if err != nil {
			continue
		}

		// Format: permissions size date name
		perm := info.Mode().String()
		size := info.Size()
		modTime := info.ModTime().Format("Jan 02 15:04")
		name := entry.Name()
		if entry.IsDir() {
			name += "/"
		}

		line := fmt.Sprintf("%s %10d %s %s", perm, size, modTime, name)
		lines = append(lines, line)
	}

	return strings.Join(lines, "\n"), nil
}

func downloadFile(path string) ([]byte, error) {
	if !filepath.IsAbs(path) {
		path = filepath.Join(workDir, path)
	}

	// Check file size (limit to 10MB)
	info, err := os.Stat(path)
	if err != nil {
		return nil, err
	}
	if info.Size() > 10*1024*1024 {
		return nil, fmt.Errorf("file too large (max 10MB)")
	}

	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}

	// Encode as base64 for safe transport
	encoded := make([]byte, base64.StdEncoding.EncodedLen(len(data)))
	base64.StdEncoding.Encode(encoded, data)

	return encoded, nil
}

func uploadFile(path string, data []byte) error {
	if !filepath.IsAbs(path) {
		path = filepath.Join(workDir, path)
	}

	// Decode from base64
	decoded := make([]byte, base64.StdEncoding.DecodedLen(len(data)))
	n, err := base64.StdEncoding.Decode(decoded, data)
	if err != nil {
		return fmt.Errorf("failed to decode file data: %w", err)
	}
	decoded = decoded[:n]

	// Create directory if needed
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, fs.ModePerm); err != nil {
		return fmt.Errorf("failed to create directory: %w", err)
	}

	// Write file
	if err := os.WriteFile(path, decoded, 0644); err != nil {
		return fmt.Errorf("failed to write file: %w", err)
	}

	return nil
}

func broadcastStatus(room *nolag.Room) {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()

	// Send initial status
	sendStatus(room)

	for range ticker.C {
		sendStatus(room)
	}
}

func sendStatus(room *nolag.Room) {
	hostname, _ := os.Hostname()

	status := protocol.DeviceStatus{
		DeviceID:  *deviceID,
		Hostname:  hostname,
		OS:        runtime.GOOS,
		Arch:      runtime.GOARCH,
		Online:    true,
		Timestamp: time.Now().Unix(),
		WorkDir:   workDir,
	}

	if err := room.Emit(protocol.TopicStatus, status); err != nil {
		log.Printf("Failed to send status: %v", err)
	}
}

func handleSessionStart(room *nolag.Room, cmd protocol.Command) {
	// Parse payload
	var payload protocol.SessionStartPayload
	if err := json.Unmarshal([]byte(cmd.Payload), &payload); err != nil {
		// Send error response
		response := protocol.Response{
			CommandID: cmd.ID,
			Status:    "error",
			Error:     "invalid session_start payload: " + err.Error(),
		}
		room.Emit(protocol.TopicResponses, response)
		return
	}

	// Default size if not specified
	if payload.Cols == 0 {
		payload.Cols = 80
	}
	if payload.Rows == 0 {
		payload.Rows = 24
	}

	// Start session using command ID as session ID
	sessionID := cmd.ID
	if err := sessionManager.StartSession(sessionID, payload.Cols, payload.Rows); err != nil {
		response := protocol.Response{
			CommandID: cmd.ID,
			Status:    "error",
			Error:     "failed to start session: " + err.Error(),
		}
		room.Emit(protocol.TopicResponses, response)
		return
	}

	// Send success response with session ID
	response := protocol.Response{
		CommandID: cmd.ID,
		Status:    "success",
		Output:    sessionID, // Return session ID in output
	}
	room.Emit(protocol.TopicResponses, response)
}

func handleSessionInput(cmd protocol.Command) {
	// Parse payload
	var payload protocol.SessionInputPayload
	if err := json.Unmarshal([]byte(cmd.Payload), &payload); err != nil {
		log.Printf("Invalid session_input payload: %v", err)
		return
	}

	// Decode base64 input
	data, err := base64.StdEncoding.DecodeString(payload.Data)
	if err != nil {
		log.Printf("Invalid base64 in session_input: %v", err)
		return
	}

	// Send input to session
	if err := sessionManager.SendInput(payload.SessionID, data); err != nil {
		log.Printf("Failed to send input to session %s: %v", payload.SessionID, err)
	}
}

func handleSessionResize(cmd protocol.Command) {
	// Parse payload
	var payload protocol.SessionResizePayload
	if err := json.Unmarshal([]byte(cmd.Payload), &payload); err != nil {
		log.Printf("Invalid session_resize payload: %v", err)
		return
	}

	// Resize session
	if err := sessionManager.Resize(payload.SessionID, payload.Cols, payload.Rows); err != nil {
		log.Printf("Failed to resize session %s: %v", payload.SessionID, err)
	}
}

func handleSessionEnd(cmd protocol.Command) {
	// Parse payload
	var payload protocol.SessionEndPayload
	if err := json.Unmarshal([]byte(cmd.Payload), &payload); err != nil {
		log.Printf("Invalid session_end payload: %v", err)
		return
	}

	// End session
	sessionManager.EndSession(payload.SessionID)
}
