import type { StreamViewer, StreamPresenceData } from './types';

export class PresenceManager {
  private _users = new Map<string, StreamViewer>();
  private _actorToViewerId = new Map<string, string>();
  private _localActorId: string;

  constructor(localActorId: string) {
    this._localActorId = localActorId;
  }

  addFromPresence(actorTokenId: string, presence: StreamPresenceData, joinedAt?: number): StreamViewer | null {
    if (actorTokenId === this._localActorId) return null;

    const existing = this._actorToViewerId.get(actorTokenId);
    const viewerId = presence.viewerId || existing || actorTokenId;

    const viewer: StreamViewer = {
      viewerId,
      actorTokenId,
      username: presence.username,
      avatar: presence.avatar,
      role: presence.role || 'viewer',
      metadata: presence.metadata,
      joinedAt: joinedAt || Date.now(),
      isLocal: false,
    };

    this._users.set(viewerId, viewer);
    this._actorToViewerId.set(actorTokenId, viewerId);
    return viewer;
  }

  removeByActorId(actorTokenId: string): StreamViewer | null {
    if (actorTokenId === this._localActorId) return null;
    const viewerId = this._actorToViewerId.get(actorTokenId);
    if (!viewerId) return null;
    const viewer = this._users.get(viewerId) || null;
    this._users.delete(viewerId);
    this._actorToViewerId.delete(actorTokenId);
    return viewer;
  }

  getUser(viewerId: string): StreamViewer | undefined {
    return this._users.get(viewerId);
  }

  getAll(): StreamViewer[] {
    return Array.from(this._users.values());
  }

  get users(): Map<string, StreamViewer> {
    return this._users;
  }

  clear(): void {
    this._users.clear();
    this._actorToViewerId.clear();
  }
}
