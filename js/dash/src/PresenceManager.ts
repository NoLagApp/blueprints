import type { DashboardViewer, DashPresenceData } from './types';

export class PresenceManager {
  private _users = new Map<string, DashboardViewer>();
  private _actorToViewerId = new Map<string, string>();
  private _localActorId: string;

  constructor(localActorId: string) {
    this._localActorId = localActorId;
  }

  addFromPresence(actorTokenId: string, presence: DashPresenceData, joinedAt?: number): DashboardViewer | null {
    if (actorTokenId === this._localActorId) return null;
    const viewerId = presence.viewerId || this._actorToViewerId.get(actorTokenId) || actorTokenId;
    const viewer: DashboardViewer = { viewerId, actorTokenId, username: presence.username, metadata: presence.metadata, joinedAt: joinedAt || Date.now(), isLocal: false };
    this._users.set(viewerId, viewer);
    this._actorToViewerId.set(actorTokenId, viewerId);
    return viewer;
  }

  removeByActorId(actorTokenId: string): DashboardViewer | null {
    if (actorTokenId === this._localActorId) return null;
    const viewerId = this._actorToViewerId.get(actorTokenId);
    if (!viewerId) return null;
    const viewer = this._users.get(viewerId) || null;
    this._users.delete(viewerId);
    this._actorToViewerId.delete(actorTokenId);
    return viewer;
  }

  getAll(): DashboardViewer[] { return Array.from(this._users.values()); }
  get users(): Map<string, DashboardViewer> { return this._users; }
  clear(): void { this._users.clear(); this._actorToViewerId.clear(); }
}
