package iot

import "sync"

// TelemetryStore is a time-series buffer for telemetry readings.
// Readings are bucketed by deviceId/sensorId, each bucket capped at maxPoints.
type TelemetryStore struct {
	mu        sync.RWMutex
	maxPoints int
	buckets   map[string][]TelemetryReading // key: deviceId/sensorId
	seen      map[string]bool               // dedup by reading ID
}

func NewTelemetryStore(maxPoints int) *TelemetryStore {
	if maxPoints <= 0 {
		maxPoints = DefaultMaxTelemetryPoints
	}
	return &TelemetryStore{
		maxPoints: maxPoints,
		buckets:   make(map[string][]TelemetryReading),
		seen:      make(map[string]bool),
	}
}

func bucketKey(deviceID, sensorID string) string {
	return deviceID + "/" + sensorID
}

// Add stores a reading. Returns false if duplicate ID.
func (s *TelemetryStore) Add(reading TelemetryReading) bool {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.seen[reading.ID] {
		return false
	}
	s.seen[reading.ID] = true

	key := bucketKey(reading.DeviceID, reading.SensorID)
	bucket := s.buckets[key]
	bucket = append(bucket, reading)
	if len(bucket) > s.maxPoints {
		// Remove oldest, clean up seen map
		delete(s.seen, bucket[0].ID)
		bucket = bucket[1:]
	}
	s.buckets[key] = bucket
	return true
}

// GetAll returns readings, optionally filtered by deviceId and/or sensorId.
func (s *TelemetryStore) GetAll(deviceID, sensorID string) []TelemetryReading {
	s.mu.RLock()
	defer s.mu.RUnlock()

	var result []TelemetryReading
	for key, bucket := range s.buckets {
		if deviceID != "" && sensorID != "" {
			if key != bucketKey(deviceID, sensorID) {
				continue
			}
		}
		for _, r := range bucket {
			if deviceID != "" && r.DeviceID != deviceID {
				continue
			}
			if sensorID != "" && r.SensorID != sensorID {
				continue
			}
			result = append(result, r)
		}
	}
	return result
}

// GetLatest returns the most recent reading for a device/sensor pair.
func (s *TelemetryStore) GetLatest(deviceID, sensorID string) *TelemetryReading {
	s.mu.RLock()
	defer s.mu.RUnlock()

	key := bucketKey(deviceID, sensorID)
	bucket := s.buckets[key]
	if len(bucket) == 0 {
		return nil
	}
	r := bucket[len(bucket)-1]
	return &r
}

// Has checks if a reading ID exists.
func (s *TelemetryStore) Has(id string) bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.seen[id]
}

// Size returns total readings across all buckets.
func (s *TelemetryStore) Size() int {
	s.mu.RLock()
	defer s.mu.RUnlock()
	total := 0
	for _, bucket := range s.buckets {
		total += len(bucket)
	}
	return total
}

// Clear removes all readings.
func (s *TelemetryStore) Clear() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.buckets = make(map[string][]TelemetryReading)
	s.seen = make(map[string]bool)
}
