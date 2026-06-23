package iot

import "testing"

// Persistent Presence E2E (go iot consumer): a sleeping device advertises
// persistent + wake, and parsePresenceData round-trips persistent/wake/status.
func TestPersistentPresenceRoundTrip(t *testing.T) {
	// The presence payload a persistent device advertises / the broker returns.
	presence := map[string]any{
		"deviceId":   "sensor-1",
		"role":       "device",
		"persistent": true,
		"wake":       map[string]any{"url": "http://localhost:9999/wake"},
		"status":     "offline",
	}

	d := parsePresenceData(presence)
	if d == nil {
		t.Fatal("parsePresenceData returned nil")
	}
	if !d.Persistent {
		t.Fatal("persistent flag not parsed")
	}
	if d.Wake == nil || d.Wake.URL != "http://localhost:9999/wake" {
		t.Fatalf("wake not parsed: %+v", d.Wake)
	}
	if d.Status != "offline" {
		t.Fatalf("status: want offline, got %q", d.Status)
	}
}
