import type { NoLagOptions, LobbyPresenceEvent, LobbyPresenceState, LobbyContext, ActorPresence } from '@nolag/js-sdk';
import { NoLag } from '@nolag/js-sdk';
import { EventEmitter } from './EventEmitter';
import { FeedChannel } from './FeedChannel';
import { generateId, createLogger } from './utils';
import { DEFAULT_APP_NAME, DEFAULT_MAX_POST_CACHE, DEFAULT_MAX_COMMENT_CACHE, LOBBY_ID } from './constants';
import type { NoLagFeedOptions, ResolvedFeedOptions, FeedClientEvents, FeedUser, FeedPresenceData } from './types';

type NoLagClient = ReturnType<typeof NoLag>;

export class NoLagFeed extends EventEmitter<FeedClientEvents> {
  private _token: string;
  private _options: ResolvedFeedOptions;
  private _client: NoLagClient | null = null;
  private _localUser: FeedUser | null = null;
  private _channels = new Map<string, FeedChannel>();
  private _lobby: LobbyContext | null = null;
  private _onlineUsers = new Map<string, FeedUser>();
  private _actorToUserId = new Map<string, string>();
  private _userId: string;
  private _activeChannel: string | null = null;
  private _log: (...args: unknown[]) => void;

  constructor(token: string, options: NoLagFeedOptions) {
    super();
    this._token = token;
    this._userId = generateId();
    this._options = {
      username: options.username, avatar: options.avatar, metadata: options.metadata,
      appName: options.appName ?? DEFAULT_APP_NAME, url: options.url,
      maxPostCache: options.maxPostCache ?? DEFAULT_MAX_POST_CACHE,
      maxCommentCache: options.maxCommentCache ?? DEFAULT_MAX_COMMENT_CACHE,
      debug: options.debug ?? false, reconnect: options.reconnect ?? true, channels: options.channels ?? [],
    };
    this._log = createLogger('NoLagFeed', this._options.debug);
  }

  get connected(): boolean { return this._client?.connected ?? false; }
  get localUser(): FeedUser | null { return this._localUser; }
  get channels(): Map<string, FeedChannel> { return this._channels; }

  async connect(): Promise<void> {
    const clientOptions: NoLagOptions = { debug: this._options.debug, reconnect: this._options.reconnect };
    if (this._options.url) clientOptions.url = this._options.url;
    this._client = NoLag(this._token, clientOptions);

    this._client.on('connect', () => { if (this._channels.size > 0) { this._restoreChannels(); this.emit('reconnected'); } });
    this._client.on('disconnect', (reason: string) => this.emit('disconnected', reason));
    this._client.on('reconnect', () => {});
    this._client.on('error', (error: Error) => this.emit('error', error));
    this._client.on('replay:start', (data: unknown) => { for (const ch of this._channels.values()) ch._handleReplayStart((data as any).count); });
    this._client.on('replay:end', (data: unknown) => { for (const ch of this._channels.values()) ch._handleReplayEnd((data as any).replayed); });

    await this._client.connect();

    this._client.on('presence:join', (data: ActorPresence) => this._handleRoomPresenceJoin(data));
    this._client.on('presence:leave', (data: ActorPresence) => this._handleRoomPresenceLeave(data));
    this._client.on('presence:update', (data: ActorPresence) => this._handleRoomPresenceUpdate(data));

    this._localUser = {
      userId: this._userId, actorTokenId: this._client.actorId!, username: this._options.username,
      avatar: this._options.avatar, metadata: this._options.metadata, joinedAt: Date.now(), isLocal: true,
    };

    await this._setupLobby();
    for (const name of this._options.channels) this._subscribeChannel(name);
    this.emit('connected');
    setTimeout(() => { if (this._lobby && this._client?.connected) this._lobby.fetchPresence().then((s) => this._hydrateOnlineUsers(s)).catch(() => {}); }, 2000);
  }

  disconnect(): void {
    for (const name of [...this._channels.keys()]) this.leaveChannel(name);
    this._lobby?.unsubscribe(); this._lobby = null;
    this._client?.disconnect(); this._client = null;
    this._onlineUsers.clear(); this._actorToUserId.clear(); this._localUser = null;
  }

  joinChannel(name: string): FeedChannel {
    if (!this._client || !this._localUser) throw new Error('Not connected — call connect() first');
    if (this._activeChannel && this._activeChannel !== name) { this._channels.get(this._activeChannel)?._deactivate(); }
    let ch = this._channels.get(name);
    if (!ch) ch = this._subscribeChannel(name);
    this._activeChannel = name;
    ch._activate();
    return ch;
  }

  leaveChannel(name: string): void {
    const ch = this._channels.get(name);
    if (!ch) return;
    ch._cleanup();
    this._channels.delete(name);
    if (this._activeChannel === name) this._activeChannel = null;
  }

  getOnlineUsers(): FeedUser[] { return Array.from(this._onlineUsers.values()); }

  private _subscribeChannel(name: string): FeedChannel {
    if (!this._client || !this._localUser) throw new Error('Not connected');
    const roomContext = this._client.setApp(this._options.appName).setRoom(name);
    const ch = new FeedChannel(name, roomContext, this._localUser, this._options, createLogger(`FeedChannel:${name}`, this._options.debug));
    this._channels.set(name, ch);
    ch._subscribe();
    return ch;
  }

  private _handleRoomPresenceJoin(data: ActorPresence): void {
    if (data.actorTokenId === this._localUser?.actorTokenId) return;
    const pd = data.presence as unknown as FeedPresenceData;
    if (!pd?.userId) return;
    const user = this._presenceToUser(data.actorTokenId, pd);
    this._actorToUserId.set(data.actorTokenId, user.userId);
    if (!this._onlineUsers.has(user.userId)) { this._onlineUsers.set(user.userId, user); this.emit('userOnline', user); }
    const room = this._activeChannel ? this._channels.get(this._activeChannel) : undefined;
    if (room) room._handlePresenceJoin(data.actorTokenId, pd);
  }

  private _handleRoomPresenceLeave(data: ActorPresence): void {
    if (data.actorTokenId === this._localUser?.actorTokenId) return;
    const room = this._activeChannel ? this._channels.get(this._activeChannel) : undefined;
    if (room) room._handlePresenceLeave(data.actorTokenId);
  }

  private _handleRoomPresenceUpdate(data: ActorPresence): void {
    if (data.actorTokenId === this._localUser?.actorTokenId) return;
    const pd = data.presence as unknown as FeedPresenceData;
    if (!pd?.userId) return;
    const room = this._activeChannel ? this._channels.get(this._activeChannel) : undefined;
    if (room) room._handlePresenceUpdate(data.actorTokenId, pd);
  }

  private async _setupLobby(): Promise<void> {
    if (!this._client) return;
    this._lobby = this._client.setApp(this._options.appName).setLobby(LOBBY_ID);
    const lh = (type: 'join' | 'leave' | 'update') => (data: unknown) => {
      const e = data as LobbyPresenceEvent;
      if (type === 'join') this._handleLobbyJoin(e);
      else if (type === 'leave') this._handleLobbyLeave(e);
    };
    this._client.on('lobbyPresence:join', lh('join'));
    this._client.on('lobbyPresence:leave', lh('leave'));
    this._client.on('lobbyPresence:update', lh('update'));
    try { const s = await this._lobby.subscribe(); this._hydrateOnlineUsers(s); } catch {}
  }

  private _handleLobbyJoin(event: LobbyPresenceEvent): void {
    const { actorId, data } = event;
    if (actorId === this._localUser?.actorTokenId) return;
    const pd = data as unknown as FeedPresenceData;
    if (!pd.userId) return;
    const user = this._presenceToUser(actorId, pd);
    this._actorToUserId.set(actorId, user.userId);
    if (!this._onlineUsers.has(user.userId)) { this._onlineUsers.set(user.userId, user); this.emit('userOnline', user); }
  }

  private _handleLobbyLeave(event: LobbyPresenceEvent): void {
    const { actorId, data } = event;
    if (actorId === this._localUser?.actorTokenId) return;
    const pd = data as unknown as FeedPresenceData;
    const userId = pd?.userId || this._actorToUserId.get(actorId);
    if (userId) { const user = this._onlineUsers.get(userId); if (user) { this._onlineUsers.delete(userId); this._actorToUserId.delete(actorId); this.emit('userOffline', user); } }
  }

  private _hydrateOnlineUsers(state: LobbyPresenceState): void {
    for (const roomId of Object.keys(state)) {
      for (const actorId of Object.keys(state[roomId])) {
        if (actorId === this._localUser?.actorTokenId) continue;
        const raw = state[roomId][actorId] as Record<string, unknown>;
        const pd = (raw?.presence ?? raw) as unknown as FeedPresenceData;
        if (pd?.userId) {
          const user = this._presenceToUser(actorId, pd);
          this._actorToUserId.set(actorId, user.userId);
          if (!this._onlineUsers.has(user.userId)) { this._onlineUsers.set(user.userId, user); this.emit('userOnline', user); }
        }
      }
    }
  }

  private _presenceToUser(actorTokenId: string, data: FeedPresenceData): FeedUser {
    return { userId: data.userId, actorTokenId, username: data.username, avatar: data.avatar, metadata: data.metadata, joinedAt: Date.now(), isLocal: false };
  }

  private _restoreChannels(): void {
    if (this._activeChannel) { const ch = this._channels.get(this._activeChannel); if (ch) ch._updateLocalPresence(); }
    this._lobby?.fetchPresence().then((s) => { this._onlineUsers.clear(); this._actorToUserId.clear(); this._hydrateOnlineUsers(s); }).catch(() => {});
  }
}
