import type {
  LobbyPresenceEvent,
  LobbyPresenceState,
  LobbyContext,
  ActorPresence,
  NoLagSocket,
} from '@nolag/js-sdk';
import { EventEmitter } from './EventEmitter';
import { FeedChannel } from './FeedChannel';
import { generateId, createLogger, registerWrapper, releaseWrapper } from './utils';
import {
  DEFAULT_APP_NAME,
  DEFAULT_MAX_POST_CACHE,
  DEFAULT_MAX_COMMENT_CACHE,
  LOBBY_ID,
  LOBBY_REFRESH_DELAY_MS,
} from './constants';
import type {
  NoLagFeedOptions,
  ResolvedFeedOptions,
  FeedClientEvents,
  FeedUser,
  FeedPresenceData,
} from './types';

/**
 * NoLagFeed — high-level activity-feed SDK built on @nolag/js-sdk.
 *
 * Provides multi-channel feeds, posts, likes, comments, presence (who's
 * online), replay, and user mapping — all framework-agnostic via events.
 *
 * The wrapper NEVER manages the connection. The app owns one core NoLag
 * client (shared by any number of wrappers on distinct apps) and the
 * wrapper attaches to it at construction and releases it via `detach()`.
 *
 * @example
 * ```typescript
 * import { NoLag } from '@nolag/js-sdk';
 * import { NoLagFeed } from '@nolag/feed';
 *
 * const client = NoLag(async () => (await (await fetch('/api/nolag-token')).json()).token);
 * const feed = new NoLagFeed({ client, appName: 'my-feed', username: 'Alice' });
 *
 * feed.on('userOnline', (user) => console.log(user.username, 'is online'));
 *
 * await client.connect();   // the app owns the connection
 * await feed.ready();       // wrapper setup done (identity, lobby, channels)
 *
 * const channel = feed.joinChannel('general');
 * channel.on('postCreated', (post) => console.log(post.username + ':', post.content));
 * channel.createPost({ content: 'Hello!' });
 *
 * feed.detach();            // wrapper releases its handlers and topics
 * client.disconnect();      // the app closes the socket
 * ```
 */
export class NoLagFeed extends EventEmitter<FeedClientEvents> {
  private _client: NoLagSocket;
  private _options: ResolvedFeedOptions;
  private _localUser: FeedUser | null = null;
  private _channels = new Map<string, FeedChannel>();
  private _lobby: LobbyContext | null = null;
  private _onlineUsers = new Map<string, FeedUser>();
  private _actorToUserId = new Map<string, string>();
  private _activeChannel: string | null = null;
  private _userId: string;
  private _log: (...args: unknown[]) => void;

  // Lifecycle: one setup run per connection epoch; detach is terminal.
  private _epoch = 0;
  private _detached = false;
  private _isReady = false;
  private _readyResolve!: () => void;
  private _readyReject!: (err: Error) => void;
  private _readyPromise: Promise<void>;
  private _lobbyRefreshTimer: ReturnType<typeof setTimeout> | null = null;

  // Stored client handler refs. INVARIANT: every client.on() below has a
  // matching client.off() in detach() — never bare off(event), never inline
  // closures on the client.
  private _onConnectRef = () => this._onConnect();
  private _onDisconnectRef = (reason: string) => {
    this._log('Disconnected:', reason);
    this.emit('disconnected', reason);
  };
  private _onReconnectRef = () => {
    this._log('Reconnecting...');
    this.emit('reconnecting');
  };
  private _onErrorRef = (error: Error) => {
    this._log('Error:', error);
    this.emit('error', error);
  };
  private _onReplayStartRef = (data: unknown) => {
    const event = data as { count: number };
    for (const channel of this._channels.values()) {
      channel._handleReplayStart(event.count);
    }
  };
  private _onReplayEndRef = (data: unknown) => {
    const event = data as { replayed: number };
    for (const channel of this._channels.values()) {
      channel._handleReplayEnd(event.replayed);
    }
  };
  private _onPresenceJoinRef = (data: ActorPresence) => this._handleRoomPresenceJoin(data);
  private _onPresenceLeaveRef = (data: ActorPresence) => this._handleRoomPresenceLeave(data);
  private _onPresenceUpdateRef = (data: ActorPresence) => this._handleRoomPresenceUpdate(data);
  private _onLobbyJoinRef = (data: unknown) => this._handleLobbyJoin(data as LobbyPresenceEvent);
  private _onLobbyLeaveRef = (data: unknown) => this._handleLobbyLeave(data as LobbyPresenceEvent);
  private _onLobbyUpdateRef = (data: unknown) => this._handleLobbyUpdate(data as LobbyPresenceEvent);

  constructor(options: NoLagFeedOptions) {
    super();

    if (!options?.client) {
      throw new TypeError(
        'NoLagFeed requires an injected NoLag client: new NoLagFeed({ client, username, ... })',
      );
    }

    this._client = options.client;
    this._userId = generateId();

    this._options = {
      username: options.username,
      avatar: options.avatar,
      metadata: options.metadata,
      appName: options.appName ?? DEFAULT_APP_NAME,
      maxPostCache: options.maxPostCache ?? DEFAULT_MAX_POST_CACHE,
      maxCommentCache: options.maxCommentCache ?? DEFAULT_MAX_COMMENT_CACHE,
      debug: options.debug ?? false,
      channels: options.channels ?? [],
    };

    this._log = createLogger('NoLagFeed', this._options.debug);

    this._readyPromise = new Promise<void>((resolve, reject) => {
      this._readyResolve = resolve;
      this._readyReject = reject;
    });
    // ready() rejection is only meaningful to callers that await it
    this._readyPromise.catch(() => {});

    registerWrapper(this._client, this._options.appName, 'NoLagFeed');

    // Construction = attach: wire everything now, with stored refs.
    this._client.on('connect', this._onConnectRef);
    this._client.on('disconnect', this._onDisconnectRef);
    this._client.on('reconnect', this._onReconnectRef);
    this._client.on('error', this._onErrorRef);
    this._client.on('replay:start', this._onReplayStartRef);
    this._client.on('replay:end', this._onReplayEndRef);
    this._client.on('presence:join', this._onPresenceJoinRef);
    this._client.on('presence:leave', this._onPresenceLeaveRef);
    this._client.on('presence:update', this._onPresenceUpdateRef);
    this._client.on('lobbyPresence:join', this._onLobbyJoinRef);
    this._client.on('lobbyPresence:leave', this._onLobbyLeaveRef);
    this._client.on('lobbyPresence:update', this._onLobbyUpdateRef);

    // Attach-to-connected: if the client is already authenticated, run setup.
    // The microtask lets the caller wire wrapper event handlers synchronously
    // first; a racing real 'connect' event wins via the epoch guard.
    queueMicrotask(() => {
      if (this._epoch === 0 && !this._detached && this._client.connected) {
        this._onConnect();
      }
    });
  }

  // ============ Public Properties ============

  /** Whether the underlying connection is established (connected ≠ ready) */
  get connected(): boolean {
    return !this._detached && this._client.connected;
  }

  /** The injected core client (owned by the app, not the wrapper) */
  get client(): NoLagSocket {
    return this._client;
  }

  /** The local user's info (available after ready) */
  get localUser(): FeedUser | null {
    return this._localUser;
  }

  /** All currently joined channels */
  get channels(): Map<string, FeedChannel> {
    return this._channels;
  }

  // ============ Lifecycle ============

  /**
   * Resolves once the wrapper's first setup completed (identity, lobby and
   * configured channels ready — equivalently, once 'connected' has fired).
   * Rejects only if detach() is called before that. Client auth failures
   * surface via the app's own `await client.connect()`, not here.
   */
  ready(): Promise<void> {
    return this._readyPromise;
  }

  /**
   * Detach from the client: remove every handler this wrapper added,
   * unsubscribe its topics and lobby (when connected), clear state.
   * Terminal and idempotent; never touches the socket. To use the feed again,
   * construct a new instance.
   */
  detach(): void {
    if (this._detached) return;
    this._log('Detaching...');
    this._detached = true;
    this._epoch++; // aborts any in-flight setup at its next checkpoint

    if (this._lobbyRefreshTimer) {
      clearTimeout(this._lobbyRefreshTimer);
      this._lobbyRefreshTimer = null;
    }

    // Remove all client handlers by stored ref
    this._client.off('connect', this._onConnectRef);
    this._client.off('disconnect', this._onDisconnectRef);
    this._client.off('reconnect', this._onReconnectRef);
    this._client.off('error', this._onErrorRef);
    this._client.off('replay:start', this._onReplayStartRef);
    this._client.off('replay:end', this._onReplayEndRef);
    this._client.off('presence:join', this._onPresenceJoinRef);
    this._client.off('presence:leave', this._onPresenceLeaveRef);
    this._client.off('presence:update', this._onPresenceUpdateRef);
    this._client.off('lobbyPresence:join', this._onLobbyJoinRef);
    this._client.off('lobbyPresence:leave', this._onLobbyLeaveRef);
    this._client.off('lobbyPresence:update', this._onLobbyUpdateRef);

    // Channels: handler-specific off + connected-gated server unsubscribe
    for (const name of [...this._channels.keys()]) {
      this._channels.get(name)!._cleanup();
      this._channels.delete(name);
    }
    this._activeChannel = null;

    // Lobby: server unsubscribe is best-effort and needs a live socket
    if (this._lobby && this._client.connected) {
      try {
        this._lobby.unsubscribe();
      } catch {
        /* best-effort */
      }
    }
    this._lobby = null;

    this._onlineUsers.clear();
    this._actorToUserId.clear();
    this._localUser = null;

    releaseWrapper(this._client, this._options.appName);

    if (!this._isReady) {
      this._readyReject(new Error('NoLagFeed detached before ready'));
    }
  }

  // ============ Private: Epoch Setup ============

  private _onConnect(): void {
    this._epoch++;
    void this._runSetup(this._epoch);
  }

  /**
   * One setup pass per connection epoch. Serves both initial setup (epoch 1)
   * and reconnect restore (epoch > 1). Aborts silently whenever a newer
   * epoch started or the wrapper detached — checked after every await.
   */
  private async _runSetup(epoch: number): Promise<void> {
    const stale = () => epoch !== this._epoch || this._detached;
    this._log(this._isReady ? 'Restoring after reconnect...' : 'Setting up...');

    // Identity (client.actorId is guaranteed post-auth)
    if (!this._localUser) {
      this._localUser = {
        userId: this._userId,
        actorTokenId: this._client.actorId!,
        username: this._options.username,
        avatar: this._options.avatar,
        metadata: this._options.metadata,
        joinedAt: Date.now(),
        isLocal: true,
      };
      this._log('Local user:', this._localUser.userId, '→', this._localUser.actorTokenId);
    } else {
      this._localUser.actorTokenId = this._client.actorId!;
    }

    // Lobby: subscribe every epoch (idempotent server-side) and diff-hydrate
    // from the returned snapshot — one path for setup and restore.
    if (!this._lobby) {
      this._lobby = this._client.setApp(this._options.appName).setLobby(LOBBY_ID);
    }
    try {
      const state = await this._lobby.subscribe();
      if (stale()) return;
      this._diffHydrateOnlineUsers(state);
      this._log('Lobby subscribed, online users:', this._onlineUsers.size);
    } catch (err) {
      if (stale()) return;
      this._log('Lobby subscription failed:', err);
    }

    if (!this._isReady) {
      // First successful setup: pre-subscribe configured channels
      // (posts only, no presence)
      for (const channelName of this._options.channels) {
        this._subscribeChannelInternal(channelName);
      }
    } else if (this._activeChannel) {
      // Server auto-restored topic subscriptions; only channel-scoped presence
      // needs re-applying (the core does not restore it).
      this._channels.get(this._activeChannel)?._updateLocalPresence();
    }

    if (stale()) return;

    // Ready keys on the first setup that COMPLETES, not on epoch 1: an
    // epoch aborted by a racing reconnect must not strand ready().
    if (!this._isReady) {
      this._isReady = true;
      this._readyResolve();
      this.emit('connected');
    } else {
      this.emit('reconnected');
    }

    // Deferred lobby refetch: catches users who joined during the setup
    // window (e.g. simultaneous multi-tab connects).
    this._scheduleLobbyRefresh(epoch);
  }

  private _scheduleLobbyRefresh(epoch: number): void {
    if (this._lobbyRefreshTimer) clearTimeout(this._lobbyRefreshTimer);
    this._lobbyRefreshTimer = setTimeout(() => {
      this._lobbyRefreshTimer = null;
      if (epoch !== this._epoch || this._detached || !this._client.connected || !this._lobby) {
        return;
      }
      this._lobby
        .fetchPresence()
        .then((state) => {
          if (epoch !== this._epoch || this._detached) return;
          this._diffHydrateOnlineUsers(state);
        })
        .catch(() => {
          /* best-effort */
        });
    }, LOBBY_REFRESH_DELAY_MS);
  }

  // ============ Channel Management ============

  /**
   * Join (activate) a feed channel. Deactivates the previous active channel.
   * If the channel was pre-subscribed via the `channels` option, activates it.
   * Otherwise creates, subscribes, and activates it.
   */
  joinChannel(name: string): FeedChannel {
    this._assertUsable();

    // Deactivate the current active channel
    if (this._activeChannel && this._activeChannel !== name) {
      const prev = this._channels.get(this._activeChannel);
      if (prev) prev._deactivate();
    }

    // Get or create the channel
    let channel = this._channels.get(name);
    if (!channel) {
      channel = this._subscribeChannelInternal(name);
    }

    this._activeChannel = name;
    channel._activate();

    return channel;
  }

  /**
   * Leave a feed channel. Fully unsubscribes and removes it.
   */
  leaveChannel(name: string): void {
    const channel = this._channels.get(name);
    if (!channel) return;

    this._log('Leaving channel:', name);
    channel._cleanup();
    this._channels.delete(name);
    if (this._activeChannel === name) {
      this._activeChannel = null;
    }
  }

  /**
   * Get all joined channels.
   */
  getChannels(): FeedChannel[] {
    return Array.from(this._channels.values());
  }

  // ============ Global Presence ============

  /**
   * Get all users currently online across all channels.
   */
  getOnlineUsers(): FeedUser[] {
    return Array.from(this._onlineUsers.values());
  }

  // ============ Profile ============

  /**
   * Update the local user's profile info (broadcast to the active channel).
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

    // Re-set presence only on the active channel
    if (this._activeChannel) {
      const activeChannel = this._channels.get(this._activeChannel);
      if (activeChannel) activeChannel._updateLocalPresence();
    }
  }

  // ============ Private: Guards ============

  private _assertUsable(): void {
    if (this._detached) {
      throw new Error('NoLagFeed has been detached — construct a new instance');
    }
    if (!this._isReady || !this._localUser) {
      throw new Error('NoLagFeed not ready — await ready() or the "connected" event');
    }
  }

  // ============ Private: Channel Setup ============

  private _subscribeChannelInternal(name: string): FeedChannel {
    this._log('Subscribing channel:', name);

    const roomContext = this._client.setApp(this._options.appName).setRoom(name);
    const channel = new FeedChannel(
      name,
      roomContext,
      this._localUser!,
      this._options,
      createLogger(`FeedChannel:${name}`, this._options.debug),
      () => this._client.connected,
    );

    this._channels.set(name, channel);
    channel._subscribe();

    return channel;
  }

  // ============ Private: Scope Filtering ============

  /**
   * On a shared client, presence events from other apps' wrappers arrive on
   * the same connection-level events. Wrappers stamp their presence with a
   * `__scope` (their appName); a mismatched tag means another app's data.
   * Untagged presence is accepted (older peers in this same app).
   */
  private _foreignScope(data: FeedPresenceData | undefined): boolean {
    const scope = (data as Record<string, unknown> | undefined)?.__scope;
    return typeof scope === 'string' && scope !== this._options.appName;
  }

  // ============ Private: Channel Presence → Active Channel ============

  private _handleRoomPresenceJoin(data: ActorPresence): void {
    if (data.actorTokenId === this._localUser?.actorTokenId) return;
    const presenceData = data.presence as unknown as FeedPresenceData;
    if (!presenceData?.userId || this._foreignScope(presenceData)) return;

    // Track as online user
    const user = this._presenceToUser(data.actorTokenId, presenceData);
    this._actorToUserId.set(data.actorTokenId, user.userId);
    if (!this._onlineUsers.has(user.userId)) {
      this._onlineUsers.set(user.userId, user);
      this.emit('userOnline', user);
    }

    const channel = this._activeChannel ? this._channels.get(this._activeChannel) : undefined;
    if (channel) {
      channel._handlePresenceJoin(data.actorTokenId, presenceData);
    }
  }

  private _handleRoomPresenceLeave(data: ActorPresence): void {
    if (data.actorTokenId === this._localUser?.actorTokenId) return;
    // Channel leave ≠ offline — user may still be in another channel.
    // Lobby leave handles actual offline status.
    const channel = this._activeChannel ? this._channels.get(this._activeChannel) : undefined;
    if (channel) {
      channel._handlePresenceLeave(data.actorTokenId);
    }
  }

  private _handleRoomPresenceUpdate(data: ActorPresence): void {
    if (data.actorTokenId === this._localUser?.actorTokenId) return;
    const presenceData = data.presence as unknown as FeedPresenceData;
    if (!presenceData?.userId || this._foreignScope(presenceData)) return;

    // Update online user info if we already track them
    if (this._onlineUsers.has(presenceData.userId)) {
      const user = this._presenceToUser(data.actorTokenId, presenceData);
      this._onlineUsers.set(user.userId, user);
    }

    const channel = this._activeChannel ? this._channels.get(this._activeChannel) : undefined;
    if (channel) {
      channel._handlePresenceUpdate(data.actorTokenId, presenceData);
    }
  }

  // ============ Private: Lobby ============

  private _handleLobbyJoin(event: LobbyPresenceEvent): void {
    const { actorId, data } = event;
    if (actorId === this._localUser?.actorTokenId) return;

    const presenceData = data as unknown as FeedPresenceData;
    if (!presenceData.userId || this._foreignScope(presenceData)) return;

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

    const presenceData = data as unknown as FeedPresenceData;
    if (this._foreignScope(presenceData)) return;
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

    const presenceData = data as unknown as FeedPresenceData;
    if (!presenceData.userId || this._foreignScope(presenceData)) return;

    const user = this._presenceToUser(actorId, presenceData);
    this._onlineUsers.set(user.userId, user);
  }

  /**
   * Reconcile the online-user map against a fresh lobby snapshot, emitting
   * only the deltas (userOffline for vanished, userOnline for new). One path
   * for initial hydration, reconnect restore, and the deferred refetch.
   */
  private _diffHydrateOnlineUsers(state: LobbyPresenceState): void {
    // Build the fresh user set from the snapshot
    const fresh = new Map<string, FeedUser>();
    const freshActors = new Map<string, string>();

    for (const roomId of Object.keys(state)) {
      const roomPresence = state[roomId];
      for (const actorId of Object.keys(roomPresence)) {
        if (actorId === this._localUser?.actorTokenId) continue;

        const raw = roomPresence[actorId] as Record<string, unknown>;
        // Server returns full actor records with presence nested under .presence
        const presenceData = (raw?.presence ?? raw) as unknown as FeedPresenceData;
        if (presenceData?.userId && !this._foreignScope(presenceData)) {
          if (!fresh.has(presenceData.userId)) {
            fresh.set(presenceData.userId, this._presenceToUser(actorId, presenceData));
          }
          freshActors.set(actorId, presenceData.userId);
        }
      }
    }

    // Vanished users
    for (const [userId, user] of [...this._onlineUsers]) {
      if (!fresh.has(userId)) {
        this._onlineUsers.delete(userId);
        for (const [actorId, mappedUserId] of [...this._actorToUserId]) {
          if (mappedUserId === userId) this._actorToUserId.delete(actorId);
        }
        this.emit('userOffline', user);
      }
    }

    // New users
    for (const [userId, user] of fresh) {
      if (!this._onlineUsers.has(userId)) {
        this._onlineUsers.set(userId, user);
        this.emit('userOnline', user);
      }
    }
    for (const [actorId, userId] of freshActors) {
      this._actorToUserId.set(actorId, userId);
    }
  }

  // ============ Private: Helpers ============

  private _presenceToUser(actorTokenId: string, data: FeedPresenceData): FeedUser {
    return {
      userId: data.userId,
      actorTokenId,
      username: data.username,
      avatar: data.avatar,
      metadata: data.metadata,
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
}
