import type {
  NoLagOptions,
  LobbyPresenceEvent,
  LobbyPresenceState,
  LobbyContext,
  ActorPresence,
} from '@nolag/js-sdk';
import { NoLag } from '@nolag/js-sdk';
import { EventEmitter } from './EventEmitter';
import { StreamRoom } from './StreamRoom';
import { generateId, createLogger } from './utils';
import { DEFAULT_APP_NAME, DEFAULT_MAX_COMMENT_CACHE, DEFAULT_REACTION_WINDOW, LOBBY_ID } from './constants';
import type {
  NoLagStreamOptions,
  ResolvedStreamOptions,
  StreamClientEvents,
  StreamViewer,
  StreamPresenceData,
} from './types';

type NoLagClient = ReturnType<typeof NoLag>;

export class NoLagStream extends EventEmitter<StreamClientEvents> {
  private _token: string;
  private _options: ResolvedStreamOptions;
  private _client: NoLagClient | null = null;
  private _localViewer: StreamViewer | null = null;
  private _rooms = new Map<string, StreamRoom>();
  private _lobby: LobbyContext | null = null;
  private _onlineViewers = new Map<string, StreamViewer>();
  private _actorToViewerId = new Map<string, string>();
  private _viewerId: string;
  private _log: (...args: unknown[]) => void;

  constructor(token: string, options: NoLagStreamOptions) {
    super();
    this._token = token;
    this._viewerId = generateId();

    this._options = {
      username: options.username,
      avatar: options.avatar,
      role: options.role ?? 'viewer',
      metadata: options.metadata,
      appName: options.appName ?? DEFAULT_APP_NAME,
      url: options.url,
      maxCommentCache: options.maxCommentCache ?? DEFAULT_MAX_COMMENT_CACHE,
      reactionWindow: options.reactionWindow ?? DEFAULT_REACTION_WINDOW,
      debug: options.debug ?? false,
      reconnect: options.reconnect ?? true,
      streams: options.streams ?? [],
    };

    this._log = createLogger('NoLagStream', this._options.debug);
  }

  get connected(): boolean { return this._client?.connected ?? false; }
  get localViewer(): StreamViewer | null { return this._localViewer; }
  get rooms(): Map<string, StreamRoom> { return this._rooms; }

  async connect(): Promise<void> {
    this._log('Connecting...');

    const clientOptions: NoLagOptions = { debug: this._options.debug, reconnect: this._options.reconnect };
    if (this._options.url) clientOptions.url = this._options.url;

    this._client = NoLag(this._token, clientOptions);

    this._client.on('connect', () => {
      if (this._rooms.size > 0) { this._restoreRooms(); this.emit('reconnected'); }
    });
    this._client.on('disconnect', (reason: string) => this.emit('disconnected', reason));
    this._client.on('reconnect', () => {});
    this._client.on('error', (error: Error) => this.emit('error', error));

    this._client.on('replay:start', (data: unknown) => {
      const event = data as { count: number };
      for (const room of this._rooms.values()) room._handleReplayStart(event.count);
    });
    this._client.on('replay:end', (data: unknown) => {
      const event = data as { replayed: number };
      for (const room of this._rooms.values()) room._handleReplayEnd(event.replayed);
    });

    await this._client.connect();

    this._client.on('presence:join', (data: ActorPresence) => this._handleRoomPresenceJoin(data));
    this._client.on('presence:leave', (data: ActorPresence) => this._handleRoomPresenceLeave(data));
    this._client.on('presence:update', (data: ActorPresence) => this._handleRoomPresenceUpdate(data));

    this._localViewer = {
      viewerId: this._viewerId,
      actorTokenId: this._client.actorId!,
      username: this._options.username,
      avatar: this._options.avatar,
      role: this._options.role,
      metadata: this._options.metadata,
      joinedAt: Date.now(),
      isLocal: true,
    };

    await this._setupLobby();

    for (const streamName of this._options.streams) {
      this._subscribeRoom(streamName);
    }

    this.emit('connected');

    setTimeout(() => {
      if (this._lobby && this._client?.connected) {
        this._lobby.fetchPresence().then((state) => this._hydrateOnlineViewers(state)).catch(() => {});
      }
    }, 2000);
  }

  disconnect(): void {
    for (const name of [...this._rooms.keys()]) this.leaveStream(name);
    this._lobby?.unsubscribe();
    this._lobby = null;
    this._client?.disconnect();
    this._client = null;
    this._onlineViewers.clear();
    this._actorToViewerId.clear();
    this._localViewer = null;
  }

  joinStream(name: string): StreamRoom {
    if (!this._client || !this._localViewer) throw new Error('Not connected — call connect() first');
    let room = this._rooms.get(name);
    if (!room) { room = this._subscribeRoom(name); }
    room._activate();
    return room;
  }

  leaveStream(name: string): void {
    const room = this._rooms.get(name);
    if (!room) return;
    room._cleanup();
    this._rooms.delete(name);
  }

  getOnlineViewers(): StreamViewer[] { return Array.from(this._onlineViewers.values()); }
  get viewerCount(): number { return this._onlineViewers.size + 1; }

  private _subscribeRoom(name: string): StreamRoom {
    if (!this._client || !this._localViewer) throw new Error('Not connected');
    const roomContext = this._client.setApp(this._options.appName).setRoom(name);
    const room = new StreamRoom(name, roomContext, this._localViewer, this._options, createLogger(`StreamRoom:${name}`, this._options.debug));
    this._rooms.set(name, room);
    room._subscribe();
    return room;
  }

  private _handleRoomPresenceJoin(data: ActorPresence): void {
    if (data.actorTokenId === this._localViewer?.actorTokenId) return;
    const presenceData = data.presence as unknown as StreamPresenceData;
    if (!presenceData?.viewerId) return;
    const viewer = this._presenceToViewer(data.actorTokenId, presenceData);
    this._actorToViewerId.set(data.actorTokenId, viewer.viewerId);
    if (!this._onlineViewers.has(viewer.viewerId)) {
      this._onlineViewers.set(viewer.viewerId, viewer);
      this.emit('viewerOnline', viewer);
      this.emit('viewerCountChanged', this.viewerCount);
    }
    for (const room of this._rooms.values()) room._handlePresenceJoin(data.actorTokenId, presenceData);
  }

  private _handleRoomPresenceLeave(data: ActorPresence): void {
    if (data.actorTokenId === this._localViewer?.actorTokenId) return;
    for (const room of this._rooms.values()) room._handlePresenceLeave(data.actorTokenId);
  }

  private _handleRoomPresenceUpdate(data: ActorPresence): void {
    if (data.actorTokenId === this._localViewer?.actorTokenId) return;
    const presenceData = data.presence as unknown as StreamPresenceData;
    if (!presenceData?.viewerId) return;
    for (const room of this._rooms.values()) room._handlePresenceUpdate(data.actorTokenId, presenceData);
  }

  private async _setupLobby(): Promise<void> {
    if (!this._client) return;
    this._lobby = this._client.setApp(this._options.appName).setLobby(LOBBY_ID);
    const lobbyHandler = (type: 'join' | 'leave' | 'update') => (data: unknown) => {
      const event = data as LobbyPresenceEvent;
      if (type === 'join') this._handleLobbyJoin(event);
      else if (type === 'leave') this._handleLobbyLeave(event);
    };
    this._client.on('lobbyPresence:join', lobbyHandler('join'));
    this._client.on('lobbyPresence:leave', lobbyHandler('leave'));
    this._client.on('lobbyPresence:update', lobbyHandler('update'));
    try {
      const initialState = await this._lobby.subscribe();
      this._hydrateOnlineViewers(initialState);
    } catch {}
  }

  private _handleLobbyJoin(event: LobbyPresenceEvent): void {
    const { actorId, data } = event;
    if (actorId === this._localViewer?.actorTokenId) return;
    const presenceData = data as unknown as StreamPresenceData;
    if (!presenceData.viewerId) return;
    const viewer = this._presenceToViewer(actorId, presenceData);
    this._actorToViewerId.set(actorId, viewer.viewerId);
    if (!this._onlineViewers.has(viewer.viewerId)) {
      this._onlineViewers.set(viewer.viewerId, viewer);
      this.emit('viewerOnline', viewer);
      this.emit('viewerCountChanged', this.viewerCount);
    }
  }

  private _handleLobbyLeave(event: LobbyPresenceEvent): void {
    const { actorId, data } = event;
    if (actorId === this._localViewer?.actorTokenId) return;
    const presenceData = data as unknown as StreamPresenceData;
    const viewerId = presenceData?.viewerId || this._actorToViewerId.get(actorId);
    if (viewerId) {
      const viewer = this._onlineViewers.get(viewerId);
      if (viewer) {
        this._onlineViewers.delete(viewerId);
        this._actorToViewerId.delete(actorId);
        this.emit('viewerOffline', viewer);
        this.emit('viewerCountChanged', this.viewerCount);
      }
    }
  }

  private _hydrateOnlineViewers(state: LobbyPresenceState): void {
    for (const roomId of Object.keys(state)) {
      const roomPresence = state[roomId];
      for (const actorId of Object.keys(roomPresence)) {
        if (actorId === this._localViewer?.actorTokenId) continue;
        const raw = roomPresence[actorId] as Record<string, unknown>;
        const presenceData = (raw?.presence ?? raw) as unknown as StreamPresenceData;
        if (presenceData?.viewerId) {
          const viewer = this._presenceToViewer(actorId, presenceData);
          this._actorToViewerId.set(actorId, viewer.viewerId);
          if (!this._onlineViewers.has(viewer.viewerId)) {
            this._onlineViewers.set(viewer.viewerId, viewer);
            this.emit('viewerOnline', viewer);
          }
        }
      }
    }
  }

  private _presenceToViewer(actorTokenId: string, data: StreamPresenceData): StreamViewer {
    return {
      viewerId: data.viewerId,
      actorTokenId,
      username: data.username,
      avatar: data.avatar,
      role: data.role || 'viewer',
      metadata: data.metadata,
      joinedAt: Date.now(),
      isLocal: false,
    };
  }

  private _restoreRooms(): void {
    for (const room of this._rooms.values()) room._updateLocalPresence();
    this._lobby?.fetchPresence().then((state) => {
      this._onlineViewers.clear();
      this._actorToViewerId.clear();
      this._hydrateOnlineViewers(state);
    }).catch(() => {});
  }
}
