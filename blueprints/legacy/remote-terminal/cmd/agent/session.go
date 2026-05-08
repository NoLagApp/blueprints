package main

import (
	"encoding/base64"
	"io"
	"log"
	"os"
	"runtime"
	"sync"
	"time"

	"github.com/aymanbagabas/go-pty"
	nolag "github.com/NoLagApp/nolag-go"
	"github.com/nolag/remote-terminal/pkg/protocol"
)

// PTYSession represents an active PTY session
type PTYSession struct {
	ID      string
	pty     pty.Pty
	cmd     *pty.Cmd
	closeCh chan struct{}
	closed  bool
	mu      sync.Mutex
}

// SessionManager manages PTY sessions
type SessionManager struct {
	sessions map[string]*PTYSession
	mu       sync.RWMutex
	room     *nolag.Room
}

// NewSessionManager creates a new session manager
func NewSessionManager(room *nolag.Room) *SessionManager {
	return &SessionManager{
		sessions: make(map[string]*PTYSession),
		room:     room,
	}
}

// StartSession creates a new PTY session
func (m *SessionManager) StartSession(id string, cols, rows int) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	// Close existing session if any
	if existing, ok := m.sessions[id]; ok {
		existing.Close()
		delete(m.sessions, id)
	}

	// Determine shell to use
	var shellCmd string
	var shellArgs []string
	if runtime.GOOS == "windows" {
		// Use full path to PowerShell
		shellCmd = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"
		shellArgs = []string{"-NoLogo", "-NoExit"}
	} else {
		shellCmd = os.Getenv("SHELL")
		if shellCmd == "" {
			shellCmd = "/bin/sh"
		}
	}

	// Create PTY with the shell
	ptty, err := pty.New()
	if err != nil {
		return err
	}

	// Set initial size
	if err := ptty.Resize(cols, rows); err != nil {
		ptty.Close()
		return err
	}

	// Start the shell
	cmd := ptty.Command(shellCmd, shellArgs...)
	cmd.Dir = workDir
	cmd.Env = os.Environ()

	if err := cmd.Start(); err != nil {
		ptty.Close()
		return err
	}

	session := &PTYSession{
		ID:      id,
		pty:     ptty,
		cmd:     cmd,
		closeCh: make(chan struct{}),
	}

	m.sessions[id] = session

	// Start output reader goroutine
	go m.readOutput(session)

	// Start process watcher goroutine
	go m.watchProcess(session)

	log.Printf("Session %s started with %s", id, shellCmd)
	return nil
}

// readOutput reads from PTY and sends to client
func (m *SessionManager) readOutput(session *PTYSession) {
	buf := make([]byte, 4096)
	for {
		select {
		case <-session.closeCh:
			return
		default:
			// Set read deadline to allow checking closeCh
			n, err := session.pty.Read(buf)
			if err != nil {
				if err != io.EOF {
					log.Printf("Session %s read error: %v", session.ID, err)
				}
				m.EndSession(session.ID)
				return
			}

			if n > 0 {
				// Base64 encode and send
				encoded := base64.StdEncoding.EncodeToString(buf[:n])
				output := protocol.SessionOutput{
					SessionID: session.ID,
					Data:      encoded,
				}

				if err := m.room.Emit(protocol.TopicSessionOutput, output); err != nil {
					log.Printf("Failed to send session output: %v", err)
				}
			}
		}
	}
}

// watchProcess watches for process exit
func (m *SessionManager) watchProcess(session *PTYSession) {
	if session.cmd != nil {
		session.cmd.Wait()
	}
	// Give a moment for any final output
	time.Sleep(100 * time.Millisecond)
	m.EndSession(session.ID)
}

// SendInput sends input to a PTY session
func (m *SessionManager) SendInput(id string, data []byte) error {
	m.mu.RLock()
	session, ok := m.sessions[id]
	m.mu.RUnlock()

	if !ok {
		return nil // Session doesn't exist, ignore
	}

	_, err := session.pty.Write(data)
	return err
}

// Resize resizes a PTY session
func (m *SessionManager) Resize(id string, cols, rows int) error {
	m.mu.RLock()
	session, ok := m.sessions[id]
	m.mu.RUnlock()

	if !ok {
		return nil // Session doesn't exist, ignore
	}

	return session.pty.Resize(cols, rows)
}

// EndSession closes a PTY session
func (m *SessionManager) EndSession(id string) {
	m.mu.Lock()
	session, ok := m.sessions[id]
	if !ok {
		m.mu.Unlock()
		return
	}
	delete(m.sessions, id)
	m.mu.Unlock()

	session.Close()

	// Notify client that session is closed
	output := protocol.SessionOutput{
		SessionID: id,
		Closed:    true,
	}
	if err := m.room.Emit(protocol.TopicSessionOutput, output); err != nil {
		log.Printf("Failed to send session closed: %v", err)
	}

	log.Printf("Session %s ended", id)
}

// Close closes a PTY session (internal)
func (s *PTYSession) Close() {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.closed {
		return
	}
	s.closed = true

	close(s.closeCh)

	// Close PTY (this will also close the process)
	if s.pty != nil {
		s.pty.Close()
	}
}

// CloseAll closes all sessions
func (m *SessionManager) CloseAll() {
	m.mu.Lock()
	defer m.mu.Unlock()

	for id, session := range m.sessions {
		session.Close()
		delete(m.sessions, id)
	}
}
