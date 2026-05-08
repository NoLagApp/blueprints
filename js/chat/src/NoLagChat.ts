import type {
  NoLagOptions,
  LobbyPresenceEvent,
  LobbyPresenceState,
  PresenceData,
  LobbyContext,
  ActorPresence,
} from '@nolag/js-sdk';
import { NoLag } from '@nolag/js-sdk';
import { EventEmitter } from './EventEmitter';
import { ChatRoom } from './ChatRoom';
import { generateId, createLogger } from './utils';
import {
  DEFAULT_APP_NAME,
  DEFAULT_TYPING_TIMEOUT,
  DEFAULT_MAX_MESSAGE_CACHE,
  LOBBY_ID,
} from './constants';
import type {
  NoLagChatOptions,
  ResolvedChatOptions,
  ChatClientEvents,
  ChatUser,
  ChatPresenceData,
} from './types';

// The NoLag factory returns a client instance. We type it loosely
// because the actual class isn't exported (only the factory is).
type NoLagClient = ReturnType<typeof NoLag>;

/**
 * NoLagChat — high-level chat SDK built on @nolag/js-sdk.
 *
 * Provides multi-room chat, presence (who's online), typing indicators,
 * message replay, and user mapping — all framework-agnostic via events.
 *
 * @example
 * ```typescript
 * import { NoLagChat } from '@nolag/chat';
 *
 * const chat = new NoLagChat(token, { username: 'Alice' });
 *
 * chat.on('connected', () => console.log('Connected!'));
 * chat.on('userOnline', (user) => console.log(user.username, 'is online'));
 *
 * await chat.connect();
 *
 * const room = chat.joinRoom('general');
 * room.on('message', (msg) => console.log(msg.username + ':', msg.text));
 * room.sendMessage('Hello!');
 * ```
 */
export class NoLagChat extends EventEmitter<ChatClientEvents> {
  private _token: string;
  private _options: ResolvedChatOptions;
  private _client: NoLagClient | null = null;
  private _localUser: ChatUser | null = null;
  private _rooms = new Map<string, ChatRoom>();
  private _lobby: LobbyContext | null = null;
  private _onlineUsers = new Map<string, ChatUser>();
  private _actorToUserId = new Map<string, string>();
  private _activeRoom: string | null = null;
  private _userId: string;
  private _log: (...args: unknown[]) => void;

  constructor(token: string, options: NoLagChatOptions) {
    super();
    this._token = token;
    this._userId = generateId();

    this._options = {
      username: options.username,
      avatar: options.avatar,
      metadata: options.metadata,
      appName: options.appName ?? DEFAULT_APP_NAME,
      url: options.url,
      typingTimeout: options.typingTimeout ?? DEFAULT_TYPING_TIMEOUT,
      maxMessageCache: options.maxMessageCache ?? DEFAULT_MAX_MESSAGE_CACHE,
      debug: options.debug ?? false,
      reconnect: options.reconnect ?? true,
      rooms: options.rooms ?? [],
    };

    this._log = createLogger('NoLagChat', this._options.debug);
  }

  // ============ Public Properties ============

  /** Whether the underlying connection is established */
  get connected(): boolean {
    return this._client?.connected ?? false;
  }

  /** The local user's info (available after connect) */
  get localUser(): ChatUser | null {
    return this._localUser;
  }

  /** All currently joined rooms */
  get rooms(): Map<string, ChatRoom> {
    return this._rooms;
  }

  // ============ Lifecycle ============

  /**
   * Connect to NoLag and set up global presence.
   */
  async connect(): Promise<void> {
    this._log('Connecting...');

    const clientOptions: NoLagOptions = {
      debug: this._options.debug,
      reconnect: this._options.reconnect,
    };
    if (this._options.url) {
      clientOptions.url = this._options.url;
    }

    this._client = NoLag(this._token, clientOptions);

    // Wire client lifecycle events
    // Note: we emit 'connected' after _localUser and lobby are ready (below),
    // not here, so that joinRoom() works inside the connected handler.
    this._client.on('connect', () => {
      this._log('Connected');
      // On reconnect, the SDK fires 'connect' after the connection is
      // re-established.  Restore rooms here (not in 'reconnect') so that
      // presence updates and lobby fetches go over a live socket.
      if (this._rooms.size > 0) {
        this._log('Reconnected — restoring rooms...');
        this._restoreRooms();
        this.emit('reconnected');
      }
    });

    this._client.on('disconnect', (reason: string) => {
      this._log('Disconnected:', reason);
      this.emit('disconnected', reason);
    });

    this._client.on('reconnect', () => {
      this._log('Reconnecting...');
    });

    this._client.on('error', (error: Error) => {
      this._log('Error:', error);
      this.emit('error', error);
    });

    // Wire replay events
    this._client.on('replay:start', (data: unknown) => {
      const event = data as { count: number };
      for (const room of this._rooms.values()) {
        room._handleReplayStart(event.count);
      }
    });

    this._client.on('replay:end', (data: unknown) => {
      const event = data as { replayed: number };
      for (const room of this._rooms.values()) {
        room._handleReplayEnd(event.replayed);
      }
    });

    // Connect
    await this._client.connect();

    // Wire room-level presence events (these arrive as client-level events)
    this._client.on('presence:join', (data: ActorPresence) => {
      this._handleRoomPresenceJoin(data);
    });
    this._client.on('presence:leave', (data: ActorPresence) => {
      this._handleRoomPresenceLeave(data);
    });
    this._client.on('presence:update', (data: ActorPresence) => {
      this._handleRoomPresenceUpdate(data);
    });

    // Create local user
    this._localUser = {
      userId: this._userId,
      actorTokenId: this._client.actorId!,
      username: this._options.username,
      avatar: this._options.avatar,
      metadata: this._options.metadata,
      status: 'online',
      joinedAt: Date.now(),
      isLocal: true,
    };

    this._log('Local user:', this._localUser.userId, '→', this._localUser.actorTokenId);

    // Set up lobby for global presence
    await this._setupLobby();

    // Pre-subscribe to all configured rooms (messages only, no presence)
    for (const roomName of this._options.rooms) {
      this._subscribeRoom(roomName);
    }

    // Emit connected now that _localUser and lobby are ready,
    // so handlers can safely call joinRoom().
    this.emit('connected');

    // Deferred lobby refetch: the initial lobby snapshot is taken before
    // rooms are joined and presence is set.  When multiple tabs connect
    // simultaneously, one tab may get its snapshot before the other has
    // set presence — causing a missed user.  A short-delay refetch
    // catches anyone who joined during the setup window.
    setTimeout(() => {
      if (this._lobby && this._client?.connected) {
        this._lobby.fetchPresence().then((state) => {
          this._hydrateOnlineUsers(state);
        }).catch(() => { /* ignore — best-effort */ });
      }
    }, 2000);
  }

  /**
   * Disconnect from NoLag and clean up all rooms.
   */
  disconnect(): void {
    this._log('Disconnecting...');

    // Clean up rooms
    for (const name of [...this._rooms.keys()]) {
      this.leaveRoom(name);
    }

    // Unsubscribe from lobby
    this._lobby?.unsubscribe();
    this._lobby = null;

    // Disconnect client
    this._client?.disconnect();
    this._client = null;

    // Clear state
    this._onlineUsers.clear();
    this._actorToUserId.clear();
    this._localUser = null;
  }

  // ============ Room Management ============

  /**
   * Join (activate) a chat room. Deactivates the previous active room.
   * If the room was pre-subscribed via the `rooms` option, activates it.
   * Otherwise creates, subscribes, and activates it.
   */
  joinRoom(name: string): ChatRoom {
    if (!this._client || !this._localUser) {
      throw new Error('Not connected — call connect() first');
    }

    // Deactivate the current active room
    if (this._activeRoom && this._activeRoom !== name) {
      const prev = this._rooms.get(this._activeRoom);
      if (prev) prev._deactivate();
    }

    // Get or create the room
    let room = this._rooms.get(name);
    if (!room) {
      room = this._subscribeRoom(name);
    }

    this._activeRoom = name;
    room._activate();

    return room;
  }

  /**
   * Leave a chat room. Fully unsubscribes and removes it.
   */
  leaveRoom(name: string): void {
    const room = this._rooms.get(name);
    if (!room) return;

    this._log('Leaving room:', name);
    room._cleanup();
    this._rooms.delete(name);
    if (this._activeRoom === name) {
      this._activeRoom = null;
    }
  }

  /**
   * Get all joined rooms.
   */
  getRooms(): ChatRoom[] {
    return Array.from(this._rooms.values());
  }

  // ============ Global Presence ============

  /**
   * Get all users currently online across all rooms.
   */
  getOnlineUsers(): ChatUser[] {
    return Array.from(this._onlineUsers.values());
  }

  /**
   * Update the local user's online status.
   */
  setStatus(status: ChatUser['status']): void {
    if (this._localUser) {
      this._localUser.status = status;
    }
    // Re-set presence only on the active room
    if (this._activeRoom) {
      const activeRoom = this._rooms.get(this._activeRoom);
      if (activeRoom) activeRoom._updateLocalPresence();
    }
  }

  // ============ Profile ============

  /**
   * Update the local user's profile info (broadcast to all rooms).
   */
  updateProfile(updates: {
    username?: string;
    avatar?: string;
    metadata?: Record<string, unknown>;
  }): void {
    if (!this._localUser) return;

    if (updates.username !== undefined) {
      this._localUser.username = updates.username;
      this._options.username = updates.username;
    }
    if (updates.avatar !== undefined) {
      this._localUser.avatar = updates.avatar;
      this._options.avatar = updates.avatar;
    }
    if (updates.metadata !== undefined) {
      this._localUser.metadata = { ...this._localUser.metadata, ...updates.metadata };
      this._options.metadata = this._localUser.metadata;
    }

    // Re-set presence only on the active room
    if (this._activeRoom) {
      const activeRoom = this._rooms.get(this._activeRoom);
      if (activeRoom) activeRoom._updateLocalPresence();
    }
  }

  // ============ Private: Room Setup ============

  private _subscribeRoom(name: string): ChatRoom {
    if (!this._client || !this._localUser) {
      throw new Error('Not connected — call connect() first');
    }

    this._log('Subscribing room:', name);

    const roomContext = this._client.setApp(this._options.appName).setRoom(name);
    const room = new ChatRoom(
      name,
      roomContext,
      this._localUser,
      this._options,
      createLogger(`ChatRoom:${name}`, this._options.debug),
    );

    this._rooms.set(name, room);
    room._subscribe();

    return room;
  }

  // ============ Private: Room Presence → Active Room ============

  private _handleRoomPresenceJoin(data: ActorPresence): void {
    if (data.actorTokenId === this._localUser?.actorTokenId) return;
    const presenceData = data.presence as unknown as ChatPresenceData;
    if (!presenceData?.userId) return;

    // Track as online user
    const user = this._presenceToUser(data.actorTokenId, presenceData);
    this._actorToUserId.set(data.actorTokenId, user.userId);
    if (!this._onlineUsers.has(user.userId)) {
      this._onlineUsers.set(user.userId, user);
      this.emit('userOnline', user);
    }

    const room = this._activeRoom ? this._rooms.get(this._activeRoom) : undefined;
    if (room) {
      room._handlePresenceJoin(data.actorTokenId, presenceData);
    }
  }

  private _handleRoomPresenceLeave(data: ActorPresence): void {
    if (data.actorTokenId === this._localUser?.actorTokenId) return;
    // Room leave ≠ offline — user may still be in another room.
    // Lobby leave handles actual offline status.
    const room = this._activeRoom ? this._rooms.get(this._activeRoom) : undefined;
    if (room) {
      room._handlePresenceLeave(data.actorTokenId);
    }
  }

  private _handleRoomPresenceUpdate(data: ActorPresence): void {
    if (data.actorTokenId === this._localUser?.actorTokenId) return;
    const presenceData = data.presence as unknown as ChatPresenceData;
    if (!presenceData?.userId) return;

    // Update online user info if we already track them
    if (this._onlineUsers.has(presenceData.userId)) {
      const user = this._presenceToUser(data.actorTokenId, presenceData);
      this._onlineUsers.set(user.userId, user);
      this.emit('userUpdated', user);
    }

    const room = this._activeRoom ? this._rooms.get(this._activeRoom) : undefined;
    if (room) {
      room._handlePresenceUpdate(data.actorTokenId, presenceData);
    }
  }

  // ============ Private: Lobby ============

  private async _setupLobby(): Promise<void> {
    if (!this._client) return;

    this._lobby = this._client.setApp(this._options.appName).setLobby(LOBBY_ID);

    // Register on the client's generic lobby events (lobbyPresence:join/leave/update)
    // instead of lobby.on(), because the server sends presence events with the
    // server-assigned lobby UUID, while lobby.on() listens on the client-provided
    // lobby name — the keys never match.
    const lobbyHandler = (type: 'join' | 'leave' | 'update') =>
      (data: unknown) => {
        const event = data as LobbyPresenceEvent;
        if (type === 'join') this._handleLobbyJoin(event);
        else if (type === 'leave') this._handleLobbyLeave(event);
        else this._handleLobbyUpdate(event);
      };

    this._client.on('lobbyPresence:join', lobbyHandler('join'));
    this._client.on('lobbyPresence:leave', lobbyHandler('leave'));
    this._client.on('lobbyPresence:update', lobbyHandler('update'));

    try {
      const initialState = await this._lobby.subscribe();
      this._hydrateOnlineUsers(initialState);
      this._log('Lobby subscribed, online users:', this._onlineUsers.size);
    } catch (err) {
      this._log('Lobby subscription failed:', err);
    }
  }

  private _handleLobbyJoin(event: LobbyPresenceEvent): void {
    const { actorId, data } = event;
    if (actorId === this._localUser?.actorTokenId) return;

    const presenceData = data as unknown as ChatPresenceData;
    if (!presenceData.userId) return;

    const user = this._presenceToUser(actorId, presenceData);
    this._actorToUserId.set(actorId, user.userId);
    if (!this._onlineUsers.has(user.userId)) {
      this._onlineUsers.set(user.userId, user);
      this.emit('userOnline', user);
    }
  }

  private _handleLobbyLeave(event: LobbyPresenceEvent): void {
    const { actorId, data } = event;
    if (actorId === this._localUser?.actorTokenId) return;

    const presenceData = data as unknown as ChatPresenceData;
    const userId = presenceData?.userId
      || this._actorToUserId.get(actorId)
      || this._findUserIdByActorId(actorId);

    if (userId) {
      const user = this._onlineUsers.get(userId);
      if (user) {
        this._onlineUsers.delete(userId);
        this._actorToUserId.delete(actorId);
        this.emit('userOffline', user);
      }
    }
  }

  private _handleLobbyUpdate(event: LobbyPresenceEvent): void {
    const { actorId, data } = event;
    if (actorId === this._localUser?.actorTokenId) return;

    const presenceData = data as unknown as ChatPresenceData;
    if (!presenceData.userId) return;

    const user = this._presenceToUser(actorId, presenceData);
    this._onlineUsers.set(user.userId, user);
    this.emit('userUpdated', user);
  }

  private _hydrateOnlineUsers(state: LobbyPresenceState): void {
    // state = { roomId: { actorId: actorRecord } }
    // actorRecord from the server is { actorTokenId, presence: ChatPresenceData, joinedAt }
    for (const roomId of Object.keys(state)) {
      const roomPresence = state[roomId];
      for (const actorId of Object.keys(roomPresence)) {
        if (actorId === this._localUser?.actorTokenId) continue;

        const raw = roomPresence[actorId] as Record<string, unknown>;
        // Server returns full actor records with presence nested under .presence
        const presenceData = (raw?.presence ?? raw) as unknown as ChatPresenceData;
        if (presenceData?.userId) {
          const user = this._presenceToUser(actorId, presenceData);
          this._actorToUserId.set(actorId, user.userId);
          if (!this._onlineUsers.has(user.userId)) {
            this._onlineUsers.set(user.userId, user);
            this.emit('userOnline', user);
          }
        }
      }
    }
  }

  // ============ Private: Helpers ============

  private _presenceToUser(actorTokenId: string, data: ChatPresenceData): ChatUser {
    return {
      userId: data.userId,
      actorTokenId,
      username: data.username,
      avatar: data.avatar,
      metadata: data.metadata,
      status: data.status || 'online',
      joinedAt: Date.now(),
      isLocal: false,
    };
  }

  private _findUserIdByActorId(actorTokenId: string): string | undefined {
    for (const user of this._onlineUsers.values()) {
      if (user.actorTokenId === actorTokenId) return user.userId;
    }
    return undefined;
  }

  private _restoreRooms(): void {
    // On reconnect, js-sdk auto-restores subscriptions.
    // Re-set presence only on the active room.
    if (this._activeRoom) {
      const activeRoom = this._rooms.get(this._activeRoom);
      if (activeRoom) activeRoom._updateLocalPresence();
    }

    // Re-fetch lobby presence
    this._lobby?.fetchPresence().then((state) => {
      this._onlineUsers.clear();
      this._actorToUserId.clear();
      this._hydrateOnlineUsers(state);
    }).catch((err) => {
      this._log('Failed to re-fetch lobby presence:', err);
    });
  }
}
