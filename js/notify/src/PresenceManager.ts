import type { NotifyPresenceData } from './types';

export interface NotifyUser {
  userId: string;
  actorTokenId: string;
  metadata?: Record<string, unknown>;
  joinedAt: number;
}

/**
 * Maps actorTokenId to NotifyUser for global presence tracking.
 */
export class PresenceManager {
  private _users = new Map<string, NotifyUser>();
  private _actorToUserId = new Map<string, string>();

  /**
   * Add or update a user from presence data.
   * Returns the NotifyUser, or null if presence data is invalid.
   */
  addFromPresence(actorTokenId: string, presenceData: NotifyPresenceData, joinedAt?: number): NotifyUser | null {
    if (!presenceData?.userId) return null;

    const existing = this._actorToUserId.get(actorTokenId);
    const userId = presenceData.userId || existing || actorTokenId;

    const user: NotifyUser = {
      userId,
      actorTokenId,
      metadata: presenceData.metadata,
      joinedAt: joinedAt || Date.now(),
    };

    this._users.set(userId, user);
    this._actorToUserId.set(actorTokenId, userId);

    return user;
  }

  /**
   * Remove a user by actorTokenId.
   * Returns the removed user, or null if not found.
   */
  removeByActorId(actorTokenId: string): NotifyUser | null {
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
  getUser(userId: string): NotifyUser | undefined {
    return this._users.get(userId);
  }

  /**
   * Get a user by actorTokenId.
   */
  getUserByActorId(actorTokenId: string): NotifyUser | undefined {
    const userId = this._actorToUserId.get(actorTokenId);
    return userId ? this._users.get(userId) : undefined;
  }

  /**
   * Get all tracked users.
   */
  getAll(): NotifyUser[] {
    return Array.from(this._users.values());
  }

  /**
   * Clear all tracked users.
   */
  clear(): void {
    this._users.clear();
    this._actorToUserId.clear();
  }
}
