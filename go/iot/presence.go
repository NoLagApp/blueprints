package iot

import "sync"

// PresenceManager tracks remote devices via presence.
type PresenceManager struct {
	mu           sync.RWMutex
	localActorID string
	devices      map[string]*Device // keyed by deviceId
	byActor      map[string]string  // actorTokenId -> deviceId
}

func NewPresenceManager(localActorID string) *PresenceManager {
	return &PresenceManager{
		localActorID: localActorID,
		devices:      make(map[string]*Device),
		byActor:      make(map[string]string),
	}
}

// AddFromPresence adds or updates a device from presence data.
// Returns nil if the actor is the local device.
func (p *PresenceManager) AddFromPresence(actorTokenID string, data IoTPresenceData, joinedAt int64) *Device {
	if actorTokenID == p.localActorID {
		return nil
	}

	p.mu.Lock()
	defer p.mu.Unlock()

	if joinedAt == 0 {
		joinedAt = nowMs()
	}

	dev := &Device{
		DeviceID:     data.DeviceID,
		ActorTokenID: actorTokenID,
		DeviceName:   data.DeviceName,
		Role:         data.Role,
		Metadata:     data.Metadata,
		JoinedAt:     joinedAt,
		IsLocal:      false,
	}

	p.devices[dev.DeviceID] = dev
	p.byActor[actorTokenID] = dev.DeviceID
	return dev
}

// RemoveByActorID removes a device by actor token ID.
func (p *PresenceManager) RemoveByActorID(actorTokenID string) *Device {
	p.mu.Lock()
	defer p.mu.Unlock()

	deviceID, ok := p.byActor[actorTokenID]
	if !ok {
		return nil
	}

	dev := p.devices[deviceID]
	delete(p.devices, deviceID)
	delete(p.byActor, actorTokenID)
	return dev
}

// GetDevice returns a device by deviceId.
func (p *PresenceManager) GetDevice(deviceID string) *Device {
	p.mu.RLock()
	defer p.mu.RUnlock()
	return p.devices[deviceID]
}

// GetDeviceByActorID returns a device by actor token ID.
func (p *PresenceManager) GetDeviceByActorID(actorTokenID string) *Device {
	p.mu.RLock()
	defer p.mu.RUnlock()
	if deviceID, ok := p.byActor[actorTokenID]; ok {
		return p.devices[deviceID]
	}
	return nil
}

// GetAll returns all tracked devices.
func (p *PresenceManager) GetAll() []*Device {
	p.mu.RLock()
	defer p.mu.RUnlock()
	result := make([]*Device, 0, len(p.devices))
	for _, d := range p.devices {
		result = append(result, d)
	}
	return result
}

// Clear removes all tracked devices.
func (p *PresenceManager) Clear() {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.devices = make(map[string]*Device)
	p.byActor = make(map[string]string)
}
