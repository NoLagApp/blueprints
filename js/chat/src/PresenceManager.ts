import type { ChatUser, ChatPresenceData } from './types';

/**
 * Maps actorTokenId ↔ ChatUser, filtering self.
 */
export class PresenceManager {
  private _users = new Map<string, ChatUser>();
  private _actorToUserId = new Map<string, string>();
  private _localActorId: string;

  constructor(localActorId: string) {
    this._localActorId = localActorId;
  }

  /**
   * Add or update a user from presence data.
   * Returns the ChatUser if it's a remote user, null if it's self.
   */
  addFromPresence(actorTokenId: string, presence: ChatPresenceData, joinedAt?: number): ChatUser | null {
    const isLocal = actorTokenId === this._localActorId;

    // Skip self
    if (isLocal) return null;

    const existing = this._actorToUserId.get(actorTokenId);
    const userId = presence.userId || existing || actorTokenId;

    const user: ChatUser = {
      userId,
      actorTokenId,
      username: presence.username,
      avatar: presence.avatar,
      metadata: presence.metadata,
      status: presence.status || 'online',
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
  removeByActorId(actorTokenId: string): ChatUser | null {
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
  getUser(userId: string): ChatUser | undefined {
    return this._users.get(userId);
  }

  /**
   * Get a user by actorTokenId.
   */
  getUserByActorId(actorTokenId: string): ChatUser | undefined {
    const userId = this._actorToUserId.get(actorTokenId);
    return userId ? this._users.get(userId) : undefined;
  }

  /**
   * Get all remote users.
   */
  getAll(): ChatUser[] {
    return Array.from(this._users.values());
  }

  /**
   * Get the users Map (readonly view).
   */
  get users(): Map<string, ChatUser> {
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
