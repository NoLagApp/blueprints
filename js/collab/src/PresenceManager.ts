import type { CollabUser, CollabPresenceData, UserStatus } from './types';

/**
 * PresenceManager — maps actorTokenId ↔ CollabUser, filtering self.
 */
export class PresenceManager {
  private _users = new Map<string, CollabUser>();
  private _actorToUserId = new Map<string, string>();
  private _localActorId: string;

  constructor(localActorId: string) {
    this._localActorId = localActorId;
  }

  /**
   * Add or update a user from presence data.
   * Returns the CollabUser if it is a remote user, null if it is self.
   */
  addFromPresence(actorTokenId: string, presence: CollabPresenceData, joinedAt?: number): CollabUser | null {
    const isLocal = actorTokenId === this._localActorId;

    // Skip self
    if (isLocal) return null;

    const existing = this._actorToUserId.get(actorTokenId);
    const userId = presence.userId || existing || actorTokenId;

    const user: CollabUser = {
      userId,
      actorTokenId,
      username: presence.username,
      avatar: presence.avatar,
      color: presence.color,
      status: presence.status ?? 'active',
      metadata: presence.metadata,
      joinedAt: joinedAt ?? Date.now(),
      isLocal: false,
    };

    this._users.set(userId, user);
    this._actorToUserId.set(actorTokenId, userId);

    return user;
  }

  /**
   * Remove a user by actorTokenId.
   * Returns the removed CollabUser, or null if not found / is self.
   */
  removeByActorId(actorTokenId: string): CollabUser | null {
    if (actorTokenId === this._localActorId) return null;

    const userId = this._actorToUserId.get(actorTokenId);
    if (!userId) return null;

    const user = this._users.get(userId) ?? null;
    this._users.delete(userId);
    this._actorToUserId.delete(actorTokenId);

    return user;
  }

  /**
   * Update only the status field for an existing user.
   */
  updateStatus(actorTokenId: string, status: UserStatus): CollabUser | null {
    const userId = this._actorToUserId.get(actorTokenId);
    if (!userId) return null;

    const user = this._users.get(userId);
    if (!user) return null;

    const updated: CollabUser = { ...user, status };
    this._users.set(userId, updated);
    return updated;
  }

  /**
   * Get a user by userId.
   */
  getUser(userId: string): CollabUser | undefined {
    return this._users.get(userId);
  }

  /**
   * Get a user by actorTokenId.
   */
  getUserByActorId(actorTokenId: string): CollabUser | undefined {
    const userId = this._actorToUserId.get(actorTokenId);
    return userId ? this._users.get(userId) : undefined;
  }

  /**
   * Get all remote users.
   */
  getAll(): CollabUser[] {
    return Array.from(this._users.values());
  }

  /**
   * Get the users Map (readonly view).
   */
  get users(): Map<string, CollabUser> {
    return this._users;
  }

  /**
   * Clear all tracked users.
   */
  clear(): void {
    this._users.clear();
    this._actorToUserId.clear();
  }
}
