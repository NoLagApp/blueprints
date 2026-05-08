import type { Peer, SignalPresenceData } from './types';

/**
 * Maps actorTokenId ↔ Peer, filtering self.
 */
export class PeerManager {
  private _peers = new Map<string, Peer>();
  private _actorToPeerId = new Map<string, string>();
  private _localActorId: string;

  constructor(localActorId: string) {
    this._localActorId = localActorId;
  }

  /**
   * Add or update a peer from presence data.
   * Returns the Peer if it's a remote peer, null if it's self.
   */
  addFromPresence(actorTokenId: string, presence: SignalPresenceData, joinedAt?: number): Peer | null {
    const isLocal = actorTokenId === this._localActorId;

    // Skip self
    if (isLocal) return null;

    const existing = this._actorToPeerId.get(actorTokenId);
    const peerId = presence.peerId || existing || actorTokenId;

    const peer: Peer = {
      peerId,
      actorTokenId,
      connectionState: 'new',
      metadata: presence.metadata,
      joinedAt: joinedAt || Date.now(),
      isLocal: false,
    };

    this._peers.set(peerId, peer);
    this._actorToPeerId.set(actorTokenId, peerId);

    return peer;
  }

  /**
   * Remove a peer by actorTokenId.
   * Returns the removed peer, or null if not found / is self.
   */
  removeByActorId(actorTokenId: string): Peer | null {
    if (actorTokenId === this._localActorId) return null;

    const peerId = this._actorToPeerId.get(actorTokenId);
    if (!peerId) return null;

    const peer = this._peers.get(peerId) || null;
    this._peers.delete(peerId);
    this._actorToPeerId.delete(actorTokenId);

    return peer;
  }

  /**
   * Get a peer by peerId.
   */
  getPeer(peerId: string): Peer | undefined {
    return this._peers.get(peerId);
  }

  /**
   * Get a peer by actorTokenId.
   */
  getPeerByActorId(actorTokenId: string): Peer | undefined {
    const peerId = this._actorToPeerId.get(actorTokenId);
    return peerId ? this._peers.get(peerId) : undefined;
  }

  /**
   * Get all remote peers.
   */
  getAll(): Peer[] {
    return Array.from(this._peers.values());
  }

  /**
   * Get the peers Map (readonly view).
   */
  get peers(): Map<string, Peer> {
    return this._peers;
  }

  /**
   * Clear all tracked peers.
   */
  clear(): void {
    this._peers.clear();
    this._actorToPeerId.clear();
  }
}
