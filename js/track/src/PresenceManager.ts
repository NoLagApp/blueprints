import type { TrackedAsset, TrackPresenceData } from './types';

/**
 * Maps actorTokenId ↔ TrackedAsset, filtering self.
 */
export class PresenceManager {
  private _assets = new Map<string, TrackedAsset>();
  private _actorToAssetId = new Map<string, string>();
  private _localActorId: string;

  constructor(localActorId: string) {
    this._localActorId = localActorId;
  }

  /**
   * Add or update an asset from presence data.
   * Returns the TrackedAsset if it's a remote asset, null if it's self.
   */
  addFromPresence(actorTokenId: string, presence: TrackPresenceData, joinedAt?: number): TrackedAsset | null {
    const isLocal = actorTokenId === this._localActorId;

    // Skip self
    if (isLocal) return null;

    const existing = this._actorToAssetId.get(actorTokenId);
    const assetId = presence.assetId || existing || actorTokenId;

    const asset: TrackedAsset = {
      assetId,
      actorTokenId,
      assetName: presence.assetName,
      metadata: presence.metadata,
      joinedAt: joinedAt || Date.now(),
      isLocal: false,
    };

    this._assets.set(assetId, asset);
    this._actorToAssetId.set(actorTokenId, assetId);

    return asset;
  }

  /**
   * Remove an asset by actorTokenId.
   * Returns the removed asset, or null if not found / is self.
   */
  removeByActorId(actorTokenId: string): TrackedAsset | null {
    if (actorTokenId === this._localActorId) return null;

    const assetId = this._actorToAssetId.get(actorTokenId);
    if (!assetId) return null;

    const asset = this._assets.get(assetId) || null;
    this._assets.delete(assetId);
    this._actorToAssetId.delete(actorTokenId);

    return asset;
  }

  /**
   * Get an asset by assetId.
   */
  getAsset(assetId: string): TrackedAsset | undefined {
    return this._assets.get(assetId);
  }

  /**
   * Get an asset by actorTokenId.
   */
  getAssetByActorId(actorTokenId: string): TrackedAsset | undefined {
    const assetId = this._actorToAssetId.get(actorTokenId);
    return assetId ? this._assets.get(assetId) : undefined;
  }

  /**
   * Get all remote assets.
   */
  getAll(): TrackedAsset[] {
    return Array.from(this._assets.values());
  }

  /**
   * Get the assets Map (readonly view).
   */
  get assets(): Map<string, TrackedAsset> {
    return this._assets;
  }

  /**
   * Clear all tracked assets.
   */
  clear(): void {
    this._assets.clear();
    this._actorToAssetId.clear();
  }
}
