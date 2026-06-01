package iot

import (
	"fmt"
	"sync"
	"time"
)

// CommandManager tracks command dispatch and acknowledgements.
type CommandManager struct {
	mu             sync.RWMutex
	commands       map[string]*DeviceCommand
	pending        map[string]chan *DeviceCommand // commandId -> ack channel
	defaultTimeout time.Duration
}

func NewCommandManager(defaultTimeoutMs int) *CommandManager {
	if defaultTimeoutMs <= 0 {
		defaultTimeoutMs = DefaultCommandTimeout
	}
	return &CommandManager{
		commands:       make(map[string]*DeviceCommand),
		pending:        make(map[string]chan *DeviceCommand),
		defaultTimeout: time.Duration(defaultTimeoutMs) * time.Millisecond,
	}
}

// Send creates a command and returns a channel that resolves when acked.
func (m *CommandManager) Send(targetDeviceID, command string, params map[string]any, sentBy string, timeoutMs ...int) (*DeviceCommand, chan *DeviceCommand) {
	cmd := &DeviceCommand{
		ID:             generateID("cmd"),
		TargetDeviceID: targetDeviceID,
		Command:        command,
		Params:         params,
		Status:         StatusPending,
		SentBy:         sentBy,
		SentAt:         nowMs(),
	}

	timeout := m.defaultTimeout
	if len(timeoutMs) > 0 && timeoutMs[0] > 0 {
		timeout = time.Duration(timeoutMs[0]) * time.Millisecond
	}

	ackChan := make(chan *DeviceCommand, 1)

	m.mu.Lock()
	m.commands[cmd.ID] = cmd
	m.pending[cmd.ID] = ackChan
	m.mu.Unlock()

	// Start timeout goroutine
	go func() {
		time.Sleep(timeout)
		m.mu.Lock()
		if ch, ok := m.pending[cmd.ID]; ok {
			cmd.Status = StatusTimeout
			cmd.Error = fmt.Sprintf("command %s timed out after %v", cmd.ID, timeout)
			delete(m.pending, cmd.ID)
			m.mu.Unlock()
			ch <- cmd
			close(ch)
		} else {
			m.mu.Unlock()
		}
	}()

	return cmd, ackChan
}

// Ack acknowledges a command. Returns the updated command or nil if not found.
func (m *CommandManager) Ack(commandID string, status CommandStatus, result any) *DeviceCommand {
	m.mu.Lock()
	defer m.mu.Unlock()

	cmd, ok := m.commands[commandID]
	if !ok {
		return nil
	}

	now := nowMs()
	cmd.Status = status
	cmd.Result = result

	switch status {
	case StatusAcked:
		cmd.AckedAt = now
	case StatusCompleted:
		cmd.CompletedAt = now
	case StatusFailed:
		cmd.CompletedAt = now
		if errStr, ok := result.(string); ok {
			cmd.Error = errStr
		}
	}

	if ch, ok := m.pending[commandID]; ok {
		delete(m.pending, commandID)
		ch <- cmd
		close(ch)
	}

	return cmd
}

// Get retrieves a command by ID.
func (m *CommandManager) Get(commandID string) *DeviceCommand {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.commands[commandID]
}

// GetPending returns all pending commands.
func (m *CommandManager) GetPending() []*DeviceCommand {
	m.mu.RLock()
	defer m.mu.RUnlock()
	var result []*DeviceCommand
	for id := range m.pending {
		if cmd, ok := m.commands[id]; ok {
			result = append(result, cmd)
		}
	}
	return result
}

// Dispose rejects all pending commands and cleans up.
func (m *CommandManager) Dispose() {
	m.mu.Lock()
	defer m.mu.Unlock()
	for id, ch := range m.pending {
		if cmd, ok := m.commands[id]; ok {
			cmd.Status = StatusFailed
			cmd.Error = "disposed"
			ch <- cmd
			close(ch)
		}
		delete(m.pending, id)
	}
}
