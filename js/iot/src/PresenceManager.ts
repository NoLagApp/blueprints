import type { Device, IoTPresenceData } from './types';

/**
 * Maps actorTokenId ↔ Device, filtering self.
 */
export class PresenceManager {
  private _devices = new Map<string, Device>();
  private _actorToDeviceId = new Map<string, string>();
  private _localActorId: string;

  constructor(localActorId: string) {
    this._localActorId = localActorId;
  }

  /**
   * Add or update a device from presence data.
   * Returns the Device if it's a remote device, null if it's self.
   */
  addFromPresence(actorTokenId: string, presence: IoTPresenceData, joinedAt?: number): Device | null {
    const isLocal = actorTokenId === this._localActorId;

    // Skip self
    if (isLocal) return null;

    const existing = this._actorToDeviceId.get(actorTokenId);
    const deviceId = presence.deviceId || existing || actorTokenId;

    const device: Device = {
      deviceId,
      actorTokenId,
      deviceName: presence.deviceName,
      role: presence.role,
      metadata: presence.metadata,
      joinedAt: joinedAt ?? Date.now(),
      isLocal: false,
    };

    this._devices.set(deviceId, device);
    this._actorToDeviceId.set(actorTokenId, deviceId);

    return device;
  }

  /**
   * Remove a device by actorTokenId.
   * Returns the removed device, or null if not found / is self.
   */
  removeByActorId(actorTokenId: string): Device | null {
    if (actorTokenId === this._localActorId) return null;

    const deviceId = this._actorToDeviceId.get(actorTokenId);
    if (!deviceId) return null;

    const device = this._devices.get(deviceId) ?? null;
    this._devices.delete(deviceId);
    this._actorToDeviceId.delete(actorTokenId);

    return device;
  }

  /**
   * Get a device by deviceId.
   */
  getDevice(deviceId: string): Device | undefined {
    return this._devices.get(deviceId);
  }

  /**
   * Get a device by actorTokenId.
   */
  getDeviceByActorId(actorTokenId: string): Device | undefined {
    const deviceId = this._actorToDeviceId.get(actorTokenId);
    return deviceId ? this._devices.get(deviceId) : undefined;
  }

  /**
   * Get all remote devices.
   */
  getAll(): Device[] {
    return Array.from(this._devices.values());
  }

  /**
   * Get the devices Map (readonly view).
   */
  get devices(): Map<string, Device> {
    return this._devices;
  }

  /**
   * Clear all tracked devices.
   */
  clear(): void {
    this._devices.clear();
    this._actorToDeviceId.clear();
  }
}
