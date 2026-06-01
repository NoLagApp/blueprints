package iot

import "sync"

// HandlerFunc is a generic event handler.
type HandlerFunc func(args ...any)

// Emitter is a simple typed event emitter.
type Emitter struct {
	mu       sync.RWMutex
	handlers map[string][]HandlerFunc
}

func NewEmitter() *Emitter {
	return &Emitter{handlers: make(map[string][]HandlerFunc)}
}

func (e *Emitter) On(event string, handler HandlerFunc) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.handlers[event] = append(e.handlers[event], handler)
}

func (e *Emitter) Off(event string) {
	e.mu.Lock()
	defer e.mu.Unlock()
	delete(e.handlers, event)
}

func (e *Emitter) Emit(event string, args ...any) {
	e.mu.RLock()
	handlers := make([]HandlerFunc, len(e.handlers[event]))
	copy(handlers, e.handlers[event])
	e.mu.RUnlock()

	for _, h := range handlers {
		h(args...)
	}
}

func (e *Emitter) RemoveAllListeners() {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.handlers = make(map[string][]HandlerFunc)
}
