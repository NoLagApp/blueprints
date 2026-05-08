package main

import (
	"encoding/base64"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/charmbracelet/bubbles/textinput"
	"github.com/charmbracelet/bubbles/viewport"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"

	nolag "github.com/NoLagApp/nolag-go"
	"github.com/nolag/remote-terminal/pkg/protocol"
)

var (
	token    = flag.String("token", "", "NoLag actor token (required)")
	deviceID = flag.String("device", "", "Target device ID (optional, can connect later)")
	broker   = flag.String("broker", "wss://broker.nolag.app/ws", "NoLag broker URL")
	debug    = flag.Bool("debug", false, "Enable debug logging")
)

// Package-level client and room (needed because Bubbletea uses value semantics)
var (
	globalClient          *nolag.Client
	globalRoom            *nolag.Room
	globalPendingCommands = make(map[string]chan protocol.Response)
	globalPendingMu       sync.RWMutex
	globalDevices         = make(map[string]*Device)
	globalDevicesMu       sync.RWMutex
)

// Styles
var (
	titleStyle = lipgloss.NewStyle().
			Bold(true).
			Foreground(lipgloss.Color("#FAFAFA")).
			Background(lipgloss.Color("#7D56F4")).
			Padding(0, 1)

	statusConnected = lipgloss.NewStyle().
			Foreground(lipgloss.Color("#04B575")).
			Bold(true)

	statusDisconnected = lipgloss.NewStyle().
				Foreground(lipgloss.Color("#FF5F56")).
				Bold(true)

	statusConnecting = lipgloss.NewStyle().
				Foreground(lipgloss.Color("#FFBD2E")).
				Bold(true)

	promptStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color("#7D56F4")).
			Bold(true)

	outputStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color("#FAFAFA"))

	errorStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color("#FF5F56"))

	successStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color("#04B575"))

	infoStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color("#61AFEF"))

	dimStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color("#626262"))

	borderStyle = lipgloss.NewStyle().
			Border(lipgloss.RoundedBorder()).
			BorderForeground(lipgloss.Color("#7D56F4"))

	helpStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color("#626262"))

	deviceOnlineStyle = lipgloss.NewStyle().
				Foreground(lipgloss.Color("#04B575"))

	deviceOfflineStyle = lipgloss.NewStyle().
				Foreground(lipgloss.Color("#626262"))

	completionStyle = lipgloss.NewStyle().
			Background(lipgloss.Color("#3E4451")).
			Foreground(lipgloss.Color("#FAFAFA")).
			Padding(0, 1)

	completionSelectedStyle = lipgloss.NewStyle().
				Background(lipgloss.Color("#7D56F4")).
				Foreground(lipgloss.Color("#FAFAFA")).
				Padding(0, 1)
)

// Messages for bubbletea
type connectedMsg struct{ device string }
type disconnectedMsg struct{}
type reconnectingMsg struct{}
type errorMsg struct{ err error }
type responseMsg struct{ resp protocol.Response }
type statusMsg struct{ status protocol.DeviceStatus }
type tickMsg time.Time
type completionsMsg struct{ completions []string }
type commandResultMsg struct{ output string }

// Device represents a known device
type Device struct {
	ID       string
	Hostname string
	OS       string
	Arch     string
	Online   bool
	LastSeen time.Time
	WorkDir  string
}

// Model is the bubbletea model
type Model struct {
	// UI components
	input    textinput.Model
	viewport viewport.Model
	ready    bool

	// State
	output          []string
	connectionState string
	currentDevice   string
	width           int
	height          int

	// Command history
	history      []string
	historyIndex int

	// Tab completion
	completions      []string
	completionIndex  int
	showCompletions  bool
	completionPrefix string

	// Program reference for sending messages from callbacks
	program *tea.Program
}

func initialModel() Model {
	ti := textinput.New()
	ti.Placeholder = "Enter command... (type !help for commands)"
	ti.Focus()
	ti.CharLimit = 500
	ti.Width = 80

	return Model{
		input:           ti,
		output:          []string{},
		connectionState: "connecting",
		history:         []string{},
		historyIndex:    -1,
		completions:     []string{},
		completionIndex: 0,
	}
}

func (m *Model) SetProgram(p *tea.Program) {
	m.program = p
}

func (m Model) Init() tea.Cmd {
	return tea.Batch(
		textinput.Blink,
		m.connectToNoLag(),
		tickCmd(),
	)
}

func tickCmd() tea.Cmd {
	return tea.Tick(time.Second, func(t time.Time) tea.Msg {
		return tickMsg(t)
	})
}

func (m *Model) connectToNoLag() tea.Cmd {
	return func() tea.Msg {
		globalClient = nolag.New(*token, nolag.Options{
			URL:                  *broker,
			Reconnect:            true,
			ReconnectInterval:    5 * time.Second,
			MaxReconnectAttempts: 0,
			Debug:                *debug,
		})

		if err := globalClient.Connect(); err != nil {
			return errorMsg{err: err}
		}

		// If device specified, connect to it
		if *deviceID != "" {
			connectToDevice(*deviceID)
		}

		// Pass device through message so Update() can set it on the model
		return connectedMsg{device: *deviceID}
	}
}

// connectToDevice sets up the room and subscriptions (package-level function)
func connectToDevice(device string) {
	globalRoom = globalClient.SetApp(protocol.AppName).SetRoom(device)

	// Subscribe to responses
	globalRoom.Subscribe(protocol.TopicResponses, func(data any, meta nolag.MessageMeta) {
		// Response handling is done via pendingCommands map
		jsonData, _ := json.Marshal(data)
		var resp protocol.Response
		if err := json.Unmarshal(jsonData, &resp); err != nil {
			return
		}
		globalPendingMu.RLock()
		respChan, exists := globalPendingCommands[resp.CommandID]
		globalPendingMu.RUnlock()
		if exists {
			select {
			case respChan <- resp:
			default:
			}
		}
	})

	// Subscribe to status
	globalRoom.Subscribe(protocol.TopicStatus, func(data any, meta nolag.MessageMeta) {
		jsonData, _ := json.Marshal(data)
		var status protocol.DeviceStatus
		if err := json.Unmarshal(jsonData, &status); err != nil {
			return
		}
		globalDevicesMu.Lock()
		globalDevices[status.DeviceID] = &Device{
			ID:       status.DeviceID,
			Hostname: status.Hostname,
			OS:       status.OS,
			Arch:     status.Arch,
			Online:   true,
			LastSeen: time.Now(),
			WorkDir:  status.WorkDir,
		}
		globalDevicesMu.Unlock()
	})
}

func (m Model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	var cmds []tea.Cmd

	switch msg := msg.(type) {
	case tea.KeyMsg:
		switch msg.Type {
		case tea.KeyCtrlC:
			if globalClient != nil {
				globalClient.Close()
			}
			return m, tea.Quit

		case tea.KeyEsc:
			if m.showCompletions {
				m.showCompletions = false
				m.completions = []string{}
			} else {
				if globalClient != nil {
					globalClient.Close()
				}
				return m, tea.Quit
			}

		case tea.KeyEnter:
			if m.showCompletions && len(m.completions) > 0 {
				// Apply selected completion
				m.applyCompletion()
				m.showCompletions = false
				m.completions = []string{}
			} else {
				input := strings.TrimSpace(m.input.Value())
				if input != "" {
					// Add to history
					m.history = append(m.history, input)
					m.historyIndex = len(m.history)
					m.input.SetValue("")
					m.showCompletions = false
					return m, m.executeCommand(input)
				}
			}

		case tea.KeyUp:
			if m.showCompletions {
				if m.completionIndex > 0 {
					m.completionIndex--
				}
			} else {
				// History navigation
				if len(m.history) > 0 && m.historyIndex > 0 {
					m.historyIndex--
					m.input.SetValue(m.history[m.historyIndex])
					m.input.CursorEnd()
				}
			}

		case tea.KeyDown:
			if m.showCompletions {
				if m.completionIndex < len(m.completions)-1 {
					m.completionIndex++
				}
			} else {
				// History navigation
				if m.historyIndex < len(m.history)-1 {
					m.historyIndex++
					m.input.SetValue(m.history[m.historyIndex])
					m.input.CursorEnd()
				} else if m.historyIndex == len(m.history)-1 {
					m.historyIndex = len(m.history)
					m.input.SetValue("")
				}
			}

		case tea.KeyTab:
			// Request tab completion
			return m, m.requestCompletion()

		case tea.KeyPgUp:
			m.viewport.LineUp(5)

		case tea.KeyPgDown:
			m.viewport.LineDown(5)

		default:
			// Hide completions on any other key
			if m.showCompletions && msg.Type != tea.KeyTab {
				m.showCompletions = false
			}
		}

	case tea.WindowSizeMsg:
		m.width = msg.Width
		m.height = msg.Height

		headerHeight := 4
		footerHeight := 5
		if m.showCompletions {
			footerHeight += min(len(m.completions), 5) + 1
		}
		viewportHeight := msg.Height - headerHeight - footerHeight

		if !m.ready {
			m.viewport = viewport.New(msg.Width-4, viewportHeight)
			m.viewport.SetContent(strings.Join(m.output, "\n"))
			m.ready = true
		} else {
			m.viewport.Width = msg.Width - 4
			m.viewport.Height = viewportHeight
		}

		m.input.Width = msg.Width - 10

	case connectedMsg:
		m.connectionState = "connected"
		m.currentDevice = msg.device
		m.addOutput(successStyle.Render("✓ Connected to NoLag broker"))
		if m.currentDevice != "" {
			m.addOutput(infoStyle.Render(fmt.Sprintf("  Connected to device: %s", m.currentDevice)))
		} else {
			m.addOutput(infoStyle.Render("  No device selected. Use !connect <device> or !devices"))
		}
		m.addOutput("")
		m.addOutput(helpStyle.Render("Type !help for available commands"))
		m.addOutput("")

	case disconnectedMsg:
		m.connectionState = "disconnected"
		m.addOutput(errorStyle.Render("✗ Disconnected from broker"))

	case errorMsg:
		m.addOutput(errorStyle.Render(fmt.Sprintf("Error: %v", msg.err)))

	case commandResultMsg:
		m.addOutput(msg.output)

	case completionsMsg:
		if len(msg.completions) > 0 {
			m.completions = msg.completions
			m.completionIndex = 0
			m.showCompletions = true
		}

	case tickMsg:
		// Mark devices as offline if not seen recently
		globalDevicesMu.Lock()
		for _, dev := range globalDevices {
			if time.Since(dev.LastSeen) > 60*time.Second {
				dev.Online = false
			}
		}
		globalDevicesMu.Unlock()
		cmds = append(cmds, tickCmd())
	}

	// Update input
	var inputCmd tea.Cmd
	m.input, inputCmd = m.input.Update(msg)
	cmds = append(cmds, inputCmd)

	// Update viewport
	var vpCmd tea.Cmd
	m.viewport, vpCmd = m.viewport.Update(msg)
	cmds = append(cmds, vpCmd)

	return m, tea.Batch(cmds...)
}

func (m *Model) applyCompletion() {
	if len(m.completions) == 0 {
		return
	}

	completion := m.completions[m.completionIndex]
	currentInput := m.input.Value()

	// Find the last word/path being completed
	lastSpace := strings.LastIndex(currentInput, " ")
	var prefix string
	if lastSpace >= 0 {
		prefix = currentInput[:lastSpace+1]
	}

	// For paths, keep the directory part
	lastPart := currentInput[lastSpace+1:]
	lastSep := strings.LastIndexAny(lastPart, "/\\")
	if lastSep >= 0 {
		prefix += lastPart[:lastSep+1]
	}

	m.input.SetValue(prefix + completion)
	m.input.CursorEnd()
}

func (m *Model) requestCompletion() tea.Cmd {
	return func() tea.Msg {
		input := m.input.Value()
		if input == "" {
			return nil
		}

		// Get the last word for completion
		parts := strings.Fields(input)
		if len(parts) == 0 {
			return nil
		}

		lastWord := parts[len(parts)-1]

		// Check for local commands first
		if strings.HasPrefix(input, "!") && len(parts) == 1 {
			localCmds := []string{"!help", "!ping", "!info", "!clear", "!quit", "!devices", "!connect", "!download", "!upload", "!ls"}
			var matches []string
			for _, cmd := range localCmds {
				if strings.HasPrefix(cmd, input) {
					matches = append(matches, cmd)
				}
			}
			if len(matches) > 0 {
				return completionsMsg{completions: matches}
			}
		}

		// Request remote completions for paths
		if globalRoom == nil {
			return nil
		}

		cmd := protocol.Command{
			ID:        protocol.GenerateID(),
			Type:      protocol.CmdTypeComplete,
			Payload:   lastWord,
			Timestamp: time.Now().Unix(),
		}

		respChan := make(chan protocol.Response, 1)
		globalPendingMu.Lock()
		globalPendingCommands[cmd.ID] = respChan
		globalPendingMu.Unlock()

		defer func() {
			globalPendingMu.Lock()
			delete(globalPendingCommands, cmd.ID)
			globalPendingMu.Unlock()
		}()

		if err := globalRoom.Emit(protocol.TopicCommands, cmd); err != nil {
			return nil
		}

		select {
		case resp := <-respChan:
			if len(resp.Completions) > 0 {
				return completionsMsg{completions: resp.Completions}
			}
		case <-time.After(2 * time.Second):
		}

		return nil
	}
}

func (m *Model) executeCommand(input string) tea.Cmd {
	return func() tea.Msg {
		// Handle local commands
		switch {
		case input == "!quit" || input == "!exit":
			if globalClient != nil {
				globalClient.Close()
			}
			return tea.Quit()

		case input == "!clear":
			m.output = []string{}
			m.viewport.SetContent("")
			return commandResultMsg{output: infoStyle.Render("Output cleared")}

		case input == "!help":
			return commandResultMsg{output: m.getHelp()}

		case input == "!devices":
			return commandResultMsg{output: m.listDevices()}

		case strings.HasPrefix(input, "!connect "):
			device := strings.TrimPrefix(input, "!connect ")
			device = strings.TrimSpace(device)
			connectToDevice(device)
			m.currentDevice = device
			return commandResultMsg{output: successStyle.Render(fmt.Sprintf("Connected to device: %s", device))}

		case input == "!ping":
			return m.sendCommand(protocol.CmdTypePing, "")

		case input == "!info":
			return m.sendCommand(protocol.CmdTypeInfo, "")

		case input == "!ls":
			return m.sendCommand(protocol.CmdTypeListDir, "")

		case strings.HasPrefix(input, "!ls "):
			path := strings.TrimPrefix(input, "!ls ")
			return m.sendCommand(protocol.CmdTypeListDir, path)

		case strings.HasPrefix(input, "!download "):
			args := strings.TrimPrefix(input, "!download ")
			return m.downloadFile(args)

		case strings.HasPrefix(input, "!upload "):
			args := strings.TrimPrefix(input, "!upload ")
			return m.uploadFile(args)

		default:
			if m.currentDevice == "" {
				return commandResultMsg{output: errorStyle.Render("No device connected. Use !connect <device> first.")}
			}
			return m.sendCommand(protocol.CmdTypeShell, input)
		}
	}
}

func (m *Model) getHelp() string {
	help := `
` + titleStyle.Render("Remote Terminal Commands") + `

` + promptStyle.Render("Connection:") + `
  !devices          List known devices
  !connect <id>     Connect to a device

` + promptStyle.Render("Remote Commands:") + `
  !ping             Ping the device
  !info             Get system info
  !ls [path]        List directory
  <command>         Execute shell command

` + promptStyle.Render("File Transfer:") + `
  !download <remote> [local]   Download file from device
  !upload <local> <remote>     Upload file to device

` + promptStyle.Render("Local:") + `
  !clear            Clear output
  !help             Show this help
  !quit             Exit

` + promptStyle.Render("Navigation:") + `
  ↑/↓               Command history
  Tab               Auto-complete
  PgUp/PgDn         Scroll output
  Esc/Ctrl+C        Quit
`
	return help
}

func (m *Model) listDevices() string {
	globalDevicesMu.RLock()
	defer globalDevicesMu.RUnlock()

	if len(globalDevices) == 0 {
		return dimStyle.Render("No devices discovered yet. Devices will appear when they come online.")
	}

	var lines []string
	lines = append(lines, titleStyle.Render("Known Devices"))
	lines = append(lines, "")

	for _, dev := range globalDevices {
		status := deviceOfflineStyle.Render("○ offline")
		if dev.Online {
			status = deviceOnlineStyle.Render("● online")
		}

		current := ""
		if dev.ID == m.currentDevice {
			current = promptStyle.Render(" ← current")
		}

		line := fmt.Sprintf("  %s  %-20s %s/%s%s",
			status, dev.ID, dev.OS, dev.Arch, current)
		lines = append(lines, line)

		if dev.Hostname != "" && dev.Hostname != dev.ID {
			lines = append(lines, dimStyle.Render(fmt.Sprintf("              hostname: %s", dev.Hostname)))
		}
	}

	return strings.Join(lines, "\n")
}

func (m *Model) sendCommand(cmdType, payload string) tea.Msg {
	if globalRoom == nil {
		return commandResultMsg{output: errorStyle.Render("Not connected to any device")}
	}

	cmd := protocol.Command{
		ID:        protocol.GenerateID(),
		Type:      cmdType,
		Payload:   payload,
		Timestamp: time.Now().Unix(),
	}

	var cmdDisplay string
	if payload != "" {
		cmdDisplay = promptStyle.Render(fmt.Sprintf("$ %s", payload))
	} else {
		cmdDisplay = promptStyle.Render(fmt.Sprintf("$ !%s", cmdType))
	}

	respChan := make(chan protocol.Response, 1)
	globalPendingMu.Lock()
	globalPendingCommands[cmd.ID] = respChan
	globalPendingMu.Unlock()

	defer func() {
		globalPendingMu.Lock()
		delete(globalPendingCommands, cmd.ID)
		globalPendingMu.Unlock()
	}()

	if err := globalRoom.Emit(protocol.TopicCommands, cmd); err != nil {
		return commandResultMsg{output: cmdDisplay + "\n" + errorStyle.Render(fmt.Sprintf("Failed to send: %v", err))}
	}

	select {
	case resp := <-respChan:
		return commandResultMsg{output: m.formatResponse(cmdDisplay, resp)}
	case <-time.After(30 * time.Second):
		return commandResultMsg{output: cmdDisplay + "\n" + errorStyle.Render("⏱ Timeout waiting for response")}
	}
}

func (m *Model) downloadFile(args string) tea.Msg {
	parts := strings.Fields(args)
	if len(parts) < 1 {
		return commandResultMsg{output: errorStyle.Render("Usage: !download <remote_path> [local_path]")}
	}

	remotePath := parts[0]
	localPath := filepath.Base(remotePath)
	if len(parts) > 1 {
		localPath = parts[1]
	}

	if globalRoom == nil {
		return commandResultMsg{output: errorStyle.Render("Not connected to any device")}
	}

	cmdDisplay := promptStyle.Render(fmt.Sprintf("$ download %s → %s", remotePath, localPath))

	cmd := protocol.Command{
		ID:        protocol.GenerateID(),
		Type:      protocol.CmdTypeDownload,
		Payload:   remotePath,
		Timestamp: time.Now().Unix(),
	}

	respChan := make(chan protocol.Response, 1)
	globalPendingMu.Lock()
	globalPendingCommands[cmd.ID] = respChan
	globalPendingMu.Unlock()

	defer func() {
		globalPendingMu.Lock()
		delete(globalPendingCommands, cmd.ID)
		globalPendingMu.Unlock()
	}()

	if err := globalRoom.Emit(protocol.TopicCommands, cmd); err != nil {
		return commandResultMsg{output: cmdDisplay + "\n" + errorStyle.Render(fmt.Sprintf("Failed to send: %v", err))}
	}

	select {
	case resp := <-respChan:
		if resp.Status == "error" {
			return commandResultMsg{output: cmdDisplay + "\n" + errorStyle.Render(resp.Error)}
		}

		// Decode and save file
		decoded := make([]byte, base64.StdEncoding.DecodedLen(len(resp.Data)))
		n, err := base64.StdEncoding.Decode(decoded, resp.Data)
		if err != nil {
			return commandResultMsg{output: cmdDisplay + "\n" + errorStyle.Render(fmt.Sprintf("Failed to decode: %v", err))}
		}

		if err := os.WriteFile(localPath, decoded[:n], 0644); err != nil {
			return commandResultMsg{output: cmdDisplay + "\n" + errorStyle.Render(fmt.Sprintf("Failed to save: %v", err))}
		}

		return commandResultMsg{output: cmdDisplay + "\n" + successStyle.Render(fmt.Sprintf("✓ Downloaded %d bytes to %s", n, localPath))}

	case <-time.After(60 * time.Second):
		return commandResultMsg{output: cmdDisplay + "\n" + errorStyle.Render("⏱ Timeout")}
	}
}

func (m *Model) uploadFile(args string) tea.Msg {
	parts := strings.Fields(args)
	if len(parts) < 2 {
		return commandResultMsg{output: errorStyle.Render("Usage: !upload <local_path> <remote_path>")}
	}

	localPath := parts[0]
	remotePath := parts[1]

	if globalRoom == nil {
		return commandResultMsg{output: errorStyle.Render("Not connected to any device")}
	}

	cmdDisplay := promptStyle.Render(fmt.Sprintf("$ upload %s → %s", localPath, remotePath))

	// Read local file
	data, err := os.ReadFile(localPath)
	if err != nil {
		return commandResultMsg{output: cmdDisplay + "\n" + errorStyle.Render(fmt.Sprintf("Failed to read file: %v", err))}
	}

	// Check size
	if len(data) > 10*1024*1024 {
		return commandResultMsg{output: cmdDisplay + "\n" + errorStyle.Render("File too large (max 10MB)")}
	}

	// Encode as base64
	encoded := make([]byte, base64.StdEncoding.EncodedLen(len(data)))
	base64.StdEncoding.Encode(encoded, data)

	cmd := protocol.Command{
		ID:        protocol.GenerateID(),
		Type:      protocol.CmdTypeUpload,
		Payload:   remotePath,
		Data:      encoded,
		Timestamp: time.Now().Unix(),
	}

	respChan := make(chan protocol.Response, 1)
	globalPendingMu.Lock()
	globalPendingCommands[cmd.ID] = respChan
	globalPendingMu.Unlock()

	defer func() {
		globalPendingMu.Lock()
		delete(globalPendingCommands, cmd.ID)
		globalPendingMu.Unlock()
	}()

	if err := globalRoom.Emit(protocol.TopicCommands, cmd); err != nil {
		return commandResultMsg{output: cmdDisplay + "\n" + errorStyle.Render(fmt.Sprintf("Failed to send: %v", err))}
	}

	select {
	case resp := <-respChan:
		if resp.Status == "error" {
			return commandResultMsg{output: cmdDisplay + "\n" + errorStyle.Render(resp.Error)}
		}
		return commandResultMsg{output: cmdDisplay + "\n" + successStyle.Render(fmt.Sprintf("✓ Uploaded %d bytes to %s", len(data), remotePath))}

	case <-time.After(60 * time.Second):
		return commandResultMsg{output: cmdDisplay + "\n" + errorStyle.Render("⏱ Timeout")}
	}
}

func (m *Model) formatResponse(cmdDisplay string, resp protocol.Response) string {
	var parts []string
	parts = append(parts, cmdDisplay)

	if resp.Output != "" {
		parts = append(parts, outputStyle.Render(resp.Output))
	}

	if resp.Status == "error" && resp.Error != "" {
		parts = append(parts, errorStyle.Render(fmt.Sprintf("Error: %s", resp.Error)))
	}

	if resp.ExitCode != 0 {
		parts = append(parts, errorStyle.Render(fmt.Sprintf("[exit %d]", resp.ExitCode)))
	}

	parts = append(parts, "")
	return strings.Join(parts, "\n")
}

func (m *Model) addOutput(line string) {
	m.output = append(m.output, line)
	if m.ready {
		m.viewport.SetContent(strings.Join(m.output, "\n"))
		m.viewport.GotoBottom()
	}
}

func (m Model) View() string {
	if !m.ready {
		return "Initializing..."
	}

	// Header
	title := titleStyle.Render("Remote Terminal")
	statusIndicator := m.renderStatus()

	deviceInfo := ""
	if m.currentDevice != "" {
		globalDevicesMu.RLock()
		if dev, ok := globalDevices[m.currentDevice]; ok && dev.WorkDir != "" {
			deviceInfo = dimStyle.Render(fmt.Sprintf(" | %s (%s)", dev.WorkDir, dev.OS))
		}
		globalDevicesMu.RUnlock()
	}
	header := fmt.Sprintf("%s  %s%s\n\n", title, statusIndicator, deviceInfo)

	// Viewport
	viewportView := borderStyle.Width(m.width - 2).Render(m.viewport.View())

	// Completions popup
	completionsView := ""
	if m.showCompletions && len(m.completions) > 0 {
		var compLines []string
		maxShow := min(len(m.completions), 5)
		for i := 0; i < maxShow; i++ {
			if i == m.completionIndex {
				compLines = append(compLines, completionSelectedStyle.Render(m.completions[i]))
			} else {
				compLines = append(compLines, completionStyle.Render(m.completions[i]))
			}
		}
		if len(m.completions) > 5 {
			compLines = append(compLines, dimStyle.Render(fmt.Sprintf("  ... and %d more", len(m.completions)-5)))
		}
		completionsView = "\n" + strings.Join(compLines, "\n")
	}

	// Input
	promptText := ">"
	if m.currentDevice != "" {
		promptText = m.currentDevice + ">"
	}
	prompt := promptStyle.Render(promptText + " ")
	inputView := fmt.Sprintf("\n%s%s", prompt, m.input.View())

	// Footer
	footer := helpStyle.Render("\n  ctrl+c: quit • ↑↓: history • tab: complete • pgup/pgdn: scroll")

	return header + viewportView + completionsView + inputView + footer
}

func (m Model) renderStatus() string {
	switch m.connectionState {
	case "connected":
		if m.currentDevice != "" {
			return statusConnected.Render("● " + m.currentDevice)
		}
		return statusConnecting.Render("● no device")
	case "disconnected":
		return statusDisconnected.Render("● disconnected")
	default:
		return statusConnecting.Render("● connecting")
	}
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}

func main() {
	flag.Parse()

	if *token == "" {
		fmt.Println("Error: -token is required")
		os.Exit(1)
	}

	if *debug {
		// Write logs to file so they're visible even with TUI
		logFile, err := os.Create("debug.log")
		if err != nil {
			fmt.Println("Warning: Could not create debug.log:", err)
		} else {
			log.SetOutput(logFile)
			defer logFile.Close()
			log.Println("Debug logging enabled")
		}
	} else {
		log.SetOutput(os.NewFile(0, os.DevNull))
	}

	p := tea.NewProgram(
		initialModel(),
		tea.WithAltScreen(),
		tea.WithMouseCellMotion(),
	)

	if _, err := p.Run(); err != nil {
		fmt.Printf("Error running program: %v\n", err)
		os.Exit(1)
	}
}
