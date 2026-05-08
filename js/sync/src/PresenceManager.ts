import type { SyncCollaborator, SyncPresenceData } from './types';

/**
 * PresenceManager — maps actorTokenId ↔ SyncCollaborator, filtering self.
 */
export class PresenceManager {
  private _collaborators = new Map<string, SyncCollaborator>();
  private _actorToUserId = new Map<string, string>();
  private _localActorId: string;

  constructor(localActorId: string) {
    this._localActorId = localActorId;
  }

  /**
   * Add or update a collaborator from presence data.
   * Returns the SyncCollaborator if it's a remote collaborator, null if it's self.
   */
  addFromPresence(actorTokenId: string, presence: SyncPresenceData, joinedAt?: number): SyncCollaborator | null {
    const isLocal = actorTokenId === this._localActorId;

    // Skip self
    if (isLocal) return null;

    const existing = this._actorToUserId.get(actorTokenId);
    const userId = presence.userId || existing || actorTokenId;

    const collaborator: SyncCollaborator = {
      userId,
      actorTokenId,
      username: presence.username,
      metadata: presence.metadata,
      joinedAt: joinedAt || Date.now(),
      isLocal: false,
    };

    this._collaborators.set(userId, collaborator);
    this._actorToUserId.set(actorTokenId, userId);

    return collaborator;
  }

  /**
   * Remove a collaborator by actorTokenId.
   * Returns the removed collaborator, or null if not found / is self.
   */
  removeByActorId(actorTokenId: string): SyncCollaborator | null {
    if (actorTokenId === this._localActorId) return null;

    const userId = this._actorToUserId.get(actorTokenId);
    if (!userId) return null;

    const collaborator = this._collaborators.get(userId) || null;
    this._collaborators.delete(userId);
    this._actorToUserId.delete(actorTokenId);

    return collaborator;
  }

  /**
   * Get a collaborator by userId.
   */
  getCollaborator(userId: string): SyncCollaborator | undefined {
    return this._collaborators.get(userId);
  }

  /**
   * Get a collaborator by actorTokenId.
   */
  getCollaboratorByActorId(actorTokenId: string): SyncCollaborator | undefined {
    const userId = this._actorToUserId.get(actorTokenId);
    return userId ? this._collaborators.get(userId) : undefined;
  }

  /**
   * Get all remote collaborators.
   */
  getAll(): SyncCollaborator[] {
    return Array.from(this._collaborators.values());
  }

  /**
   * Get the collaborators Map (readonly view).
   */
  get collaborators(): Map<string, SyncCollaborator> {
    return this._collaborators;
  }

  /**
   * Clear all tracked collaborators.
   */
  clear(): void {
    this._collaborators.clear();
    this._actorToUserId.clear();
  }
}
