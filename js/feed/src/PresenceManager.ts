import type { FeedUser, FeedPresenceData } from './types';

/**
 * Maps actorTokenId <-> FeedUser, filtering self.
 */
export class PresenceManager {
  private _users = new Map<string, FeedUser>();
  private _actorToUserId = new Map<string, string>();
  private _localActorId: string;

  constructor(localActorId: string) {
    this._localActorId = localActorId;
  }

  /**
   * Add or update a user from presence data.
   * Returns the FeedUser if it is a remote user, null if it is self.
   */
  addFromPresence(actorTokenId: string, presence: FeedPresenceData, joinedAt?: number): FeedUser | null {
    const isLocal = actorTokenId === this._localActorId;

    // Skip self
    if (isLocal) return null;

    const existing = this._actorToUserId.get(actorTokenId);
    const userId = presence.userId || existing || actorTokenId;

    const user: FeedUser = {
      userId,
      actorTokenId,
      username: presence.username,
      avatar: presence.avatar,
      metadata: presence.metadata,
      joinedAt: joinedAt || Date.now(),
      isLocal: false,
    };

    this._users.set(userId, user);
    this._actorToUserId.set(actorTokenId, userId);

    return user;
  }

  /**
   * Remove a user by actorTokenId.
   * Returns the removed user, or null if not found / is self.
   */
  removeByActorId(actorTokenId: string): FeedUser | null {
    if (actorTokenId === this._localActorId) return null;

    const userId = this._actorToUserId.get(actorTokenId);
    if (!userId) return null;

    const user = this._users.get(userId) || null;
    this._users.delete(userId);
    this._actorToUserId.delete(actorTokenId);

    return user;
  }

  /**
   * Get a user by userId.
   */
  getUser(userId: string): FeedUser | undefined {
    return this._users.get(userId);
  }

  /**
   * Get a user by actorTokenId.
   */
  getUserByActorId(actorTokenId: string): FeedUser | undefined {
    const userId = this._actorToUserId.get(actorTokenId);
    return userId ? this._users.get(userId) : undefined;
  }

  /**
   * Get all remote users.
   */
  getAll(): FeedUser[] {
    return Array.from(this._users.values());
  }

  /**
   * Get the users Map (readonly view).
   */
  get users(): Map<string, FeedUser> {
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
