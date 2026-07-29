import type {
  LobbyPresenceEvent,
  LobbyPresenceState,
  LobbyContext,
  ActorPresence,
  NoLagSocket,
} from '@nolag/js-sdk';
import { EventEmitter } from './EventEmitter';
import { StreamRoom } from './StreamRoom';
import { generateId, createLogger, registerWrapper, releaseWrapper } from './utils';
import { DEFAULT_APP_NAME, DEFAULT_MAX_COMMENT_CACHE, DEFAULT_REACTION_WINDOW, LOBBY_ID, LOBBY_REFRESH_DELAY_MS } from './constants';
import type {
  NoLagStreamOptions,
  ResolvedStreamOptions,
  StreamClientEvents,
  StreamViewer,
  StreamPresenceData,
} from './types';

/**
 * NoLagStream — high-level live-streaming engagement SDK built on @nolag/js-sdk.
 *
 * Provides live comments, reaction bursts, polls, and viewer tracking (who's
 * watching) — all framework-agnostic via events.
 *
 * The wrapper NEVER manages the connection. The app owns one core NoLag
 * client (shared by any number of wrappers on distinct apps) and the
 * wrapper attaches to it at construction and releases it via `detach()`.
 *
 * @example
 * ```typescript
 * import { NoLag } from '@nolag/js-sdk';
 * import { NoLagStream } from '@nolag/stream';
 *
 * const client = NoLag(async () => (await (await fetch('/api/nolag-token')).json()).token);
 * const stream = new NoLagStream({ client, appName: 'my-stream', username: 'Alice' });
 *
 * stream.on('viewerOnline', (viewer) => console.log(viewer.username, 'is watching'));
 *
 * await client.connect();   // the app owns the connection
 * await stream.ready();     // wrapper setup done (identity, lobby, streams)
 *
 * const room = stream.joinStream('friday-show');
 * room.on('comment', (c) => console.log(c.username + ':', c.text));
 * room.sendComment('Great stream!');
 *
 * stream.detach();          // wrapper releases its handlers and topics
 * client.disconnect();      // the app closes the socket
 * ```
 */
export class NoLagStream extends EventEmitter<StreamClientEvents> {
  private _client: NoLagSocket;
  private _options: ResolvedStreamOptions;
  private _localViewer: StreamViewer | null = null;
  private _rooms = new Map<string, StreamRoom>();
  private _lobby: LobbyContext | null = null;
  private _onlineViewers = new Map<string, StreamViewer>();
  private _actorToViewerId = new Map<string, string>();
  private _viewerId: string;
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
    for (const room of this._rooms.values()) room._handleReplayStart(event.count);
  };
  private _onReplayEndRef = (data: unknown) => {
    const event = data as { replayed: number };
    for (const room of this._rooms.values()) room._handleReplayEnd(event.replayed);
  };
  private _onPresenceJoinRef = (data: ActorPresence) => this._handleRoomPresenceJoin(data);
  private _onPresenceLeaveRef = (data: ActorPresence) => this._handleRoomPresenceLeave(data);
  private _onPresenceUpdateRef = (data: ActorPresence) => this._handleRoomPresenceUpdate(data);
  private _onLobbyJoinRef = (data: unknown) => this._handleLobbyJoin(data as LobbyPresenceEvent);
  private _onLobbyLeaveRef = (data: unknown) => this._handleLobbyLeave(data as LobbyPresenceEvent);
  private _onLobbyUpdateRef = (data: unknown) => this._handleLobbyUpdate(data as LobbyPresenceEvent);

  constructor(options: NoLagStreamOptions) {
    super();

    if (!options?.client) {
      throw new TypeError(
        'NoLagStream requires an injected NoLag client: new NoLagStream({ client, username, ... })',
      );
    }

    this._client = options.client;
    this._viewerId = generateId();

    this._options = {
      username: options.username,
      avatar: options.avatar,
      role: options.role ?? 'viewer',
      metadata: options.metadata,
      appName: options.appName ?? DEFAULT_APP_NAME,
      maxCommentCache: options.maxCommentCache ?? DEFAULT_MAX_COMMENT_CACHE,
      reactionWindow: options.reactionWindow ?? DEFAULT_REACTION_WINDOW,
      debug: options.debug ?? false,
      streams: options.streams ?? [],
    };

    this._log = createLogger('NoLagStream', this._options.debug);

    this._readyPromise = new Promise<void>((resolve, reject) => {
      this._readyResolve = resolve;
      this._readyReject = reject;
    });
    // ready() rejection is only meaningful to callers that await it
    this._readyPromise.catch(() => {});

    registerWrapper(this._client, this._options.appName, 'NoLagStream');

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

  /** The local viewer's info (available after ready) */
  get localViewer(): StreamViewer | null {
    return this._localViewer;
  }

  /** All currently joined streams */
  get rooms(): Map<string, StreamRoom> {
    return this._rooms;
  }

  /** Total viewers across all streams (includes the local viewer) */
  get viewerCount(): number {
    return this._onlineViewers.size + 1;
  }

  // ============ Lifecycle ============

  /**
   * Resolves once the wrapper's first setup completed (identity, lobby and
   * configured streams ready — equivalently, once 'connected' has fired).
   * Rejects only if detach() is called before that. Client auth failures
   * surface via the app's own `await client.connect()`, not here.
   */
  ready(): Promise<void> {
    return this._readyPromise;
  }

  /**
   * Detach from the client: remove every handler this wrapper added,
   * unsubscribe its topics and lobby (when connected), clear state.
   * Terminal and idempotent; never touches the socket. To use the stream
   * again, construct a new instance.
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

    // Rooms: handler-specific off + connected-gated server unsubscribe
    for (const name of [...this._rooms.keys()]) {
      this._rooms.get(name)!._cleanup();
      this._rooms.delete(name);
    }

    // Lobby: server unsubscribe is best-effort and needs a live socket
    if (this._lobby && this._client.connected) {
      try {
        this._lobby.unsubscribe();
      } catch {
        /* best-effort */
      }
    }
    this._lobby = null;

    this._onlineViewers.clear();
    this._actorToViewerId.clear();
    this._localViewer = null;

    releaseWrapper(this._client, this._options.appName);

    if (!this._isReady) {
      this._readyReject(new Error('NoLagStream detached before ready'));
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
    if (!this._localViewer) {
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
      this._log('Local viewer:', this._localViewer.viewerId, '→', this._localViewer.actorTokenId);
    } else {
      this._localViewer.actorTokenId = this._client.actorId!;
    }

    // Lobby: subscribe every epoch (idempotent server-side) and diff-hydrate
    // from the returned snapshot — one path for setup and restore.
    if (!this._lobby) {
      this._lobby = this._client.setApp(this._options.appName).setLobby(LOBBY_ID);
    }
    try {
      const state = await this._lobby.subscribe();
      if (stale()) return;
      this._diffHydrateOnlineViewers(state);
      this._log('Lobby subscribed, online viewers:', this._onlineViewers.size);
    } catch (err) {
      if (stale()) return;
      this._log('Lobby subscription failed:', err);
    }

    if (!this._isReady) {
      // First successful setup: pre-subscribe configured streams
      // (comments/reactions/polls only, no presence)
      for (const streamName of this._options.streams) {
        this._subscribeRoomInternal(streamName);
      }
    } else {
      // Server auto-restored topic subscriptions; only room-scoped presence
      // needs re-applying (the core does not restore it).
      for (const room of this._rooms.values()) room._updateLocalPresence();
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

    // Deferred lobby refetch: catches viewers who joined during the setup
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
          this._diffHydrateOnlineViewers(state);
        })
        .catch(() => {
          /* best-effort */
        });
    }, LOBBY_REFRESH_DELAY_MS);
  }

  // ============ Stream Management ============

  /**
   * Join (activate) a stream. If the stream was pre-subscribed via the
   * `streams` option, activates it. Otherwise creates, subscribes, and
   * activates it.
   */
  joinStream(name: string): StreamRoom {
    this._assertUsable();

    let room = this._rooms.get(name);
    if (!room) {
      room = this._subscribeRoomInternal(name);
    }
    room._activate();
    return room;
  }

  /**
   * Leave a stream. Fully unsubscribes and removes it.
   */
  leaveStream(name: string): void {
    const room = this._rooms.get(name);
    if (!room) return;
    this._log('Leaving stream:', name);
    room._cleanup();
    this._rooms.delete(name);
  }

  /**
   * Get all joined streams.
   */
  getRooms(): StreamRoom[] {
    return Array.from(this._rooms.values());
  }

  // ============ Global Presence ============

  /**
   * Get all viewers currently online across all streams.
   */
  getOnlineViewers(): StreamViewer[] {
    return Array.from(this._onlineViewers.values());
  }

  // ============ Private: Guards ============

  private _assertUsable(): void {
    if (this._detached) {
      throw new Error('NoLagStream has been detached — construct a new instance');
    }
    if (!this._isReady || !this._localViewer) {
      throw new Error('NoLagStream not ready — await ready() or the "connected" event');
    }
  }

  // ============ Private: Stream Setup ============

  private _subscribeRoomInternal(name: string): StreamRoom {
    this._log('Subscribing stream:', name);

    const roomContext = this._client.setApp(this._options.appName).setRoom(name);
    const room = new StreamRoom(
      name,
      roomContext,
      this._localViewer!,
      this._options,
      createLogger(`StreamRoom:${name}`, this._options.debug),
      () => this._client.connected,
    );

    this._rooms.set(name, room);
    room._subscribe();

    return room;
  }

  // ============ Private: Scope Filtering ============

  /**
   * On a shared client, presence events from other apps' wrappers arrive on
   * the same connection-level events. Wrappers stamp their presence with a
   * `__scope` (their appName); a mismatched tag means another app's data.
   * Untagged presence is accepted (older peers in this same app).
   */
  private _foreignScope(data: StreamPresenceData | undefined): boolean {
    const scope = (data as Record<string, unknown> | undefined)?.__scope;
    return typeof scope === 'string' && scope !== this._options.appName;
  }

  // ============ Private: Room Presence → All Streams ============

  private _handleRoomPresenceJoin(data: ActorPresence): void {
    if (data.actorTokenId === this._localViewer?.actorTokenId) return;
    const presenceData = data.presence as unknown as StreamPresenceData;
    if (!presenceData?.viewerId || this._foreignScope(presenceData)) return;

    const viewer = this._presenceToViewer(data.actorTokenId, presenceData);
    this._actorToViewerId.set(data.actorTokenId, viewer.viewerId);
    if (!this._onlineViewers.has(viewer.viewerId)) {
      this._onlineViewers.set(viewer.viewerId, viewer);
      this.emit('viewerOnline', viewer);
      this.emit('viewerCountChanged', this.viewerCount);
    }

    for (const room of this._rooms.values()) {
      room._handlePresenceJoin(data.actorTokenId, presenceData);
    }
  }

  private _handleRoomPresenceLeave(data: ActorPresence): void {
    if (data.actorTokenId === this._localViewer?.actorTokenId) return;
    // Stream leave ≠ offline — the lobby leave handles actual offline status.
    for (const room of this._rooms.values()) {
      room._handlePresenceLeave(data.actorTokenId);
    }
  }

  private _handleRoomPresenceUpdate(data: ActorPresence): void {
    if (data.actorTokenId === this._localViewer?.actorTokenId) return;
    const presenceData = data.presence as unknown as StreamPresenceData;
    if (!presenceData?.viewerId || this._foreignScope(presenceData)) return;

    // Update online viewer info if we already track them
    if (this._onlineViewers.has(presenceData.viewerId)) {
      const viewer = this._presenceToViewer(data.actorTokenId, presenceData);
      this._onlineViewers.set(viewer.viewerId, viewer);
    }

    for (const room of this._rooms.values()) {
      room._handlePresenceUpdate(data.actorTokenId, presenceData);
    }
  }

  // ============ Private: Lobby ============

  private _handleLobbyJoin(event: LobbyPresenceEvent): void {
    const { actorId, data } = event;
    if (actorId === this._localViewer?.actorTokenId) return;

    const presenceData = data as unknown as StreamPresenceData;
    if (!presenceData.viewerId || this._foreignScope(presenceData)) return;

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
    if (this._foreignScope(presenceData)) return;
    const viewerId = presenceData?.viewerId
      || this._actorToViewerId.get(actorId)
      || this._findViewerIdByActorId(actorId);

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

  private _handleLobbyUpdate(event: LobbyPresenceEvent): void {
    const { actorId, data } = event;
    if (actorId === this._localViewer?.actorTokenId) return;

    const presenceData = data as unknown as StreamPresenceData;
    if (!presenceData.viewerId || this._foreignScope(presenceData)) return;

    const viewer = this._presenceToViewer(actorId, presenceData);
    this._onlineViewers.set(viewer.viewerId, viewer);
  }

  /**
   * Reconcile the online-viewer map against a fresh lobby snapshot, emitting
   * only the deltas (viewerOffline for vanished, viewerOnline for new, plus a
   * viewerCountChanged when the count moved). One path for initial hydration,
   * reconnect restore, and the deferred refetch.
   */
  private _diffHydrateOnlineViewers(state: LobbyPresenceState): void {
    // Build the fresh viewer set from the snapshot
    const fresh = new Map<string, StreamViewer>();
    const freshActors = new Map<string, string>();

    for (const roomId of Object.keys(state)) {
      const roomPresence = state[roomId];
      for (const actorId of Object.keys(roomPresence)) {
        if (actorId === this._localViewer?.actorTokenId) continue;

        const raw = roomPresence[actorId] as Record<string, unknown>;
        // Server returns full actor records with presence nested under .presence
        const presenceData = (raw?.presence ?? raw) as unknown as StreamPresenceData;
        if (presenceData?.viewerId && !this._foreignScope(presenceData)) {
          if (!fresh.has(presenceData.viewerId)) {
            fresh.set(presenceData.viewerId, this._presenceToViewer(actorId, presenceData));
          }
          freshActors.set(actorId, presenceData.viewerId);
        }
      }
    }

    let changed = false;

    // Vanished viewers
    for (const [viewerId, viewer] of [...this._onlineViewers]) {
      if (!fresh.has(viewerId)) {
        this._onlineViewers.delete(viewerId);
        for (const [actorId, mappedViewerId] of [...this._actorToViewerId]) {
          if (mappedViewerId === viewerId) this._actorToViewerId.delete(actorId);
        }
        this.emit('viewerOffline', viewer);
        changed = true;
      }
    }

    // New viewers
    for (const [viewerId, viewer] of fresh) {
      if (!this._onlineViewers.has(viewerId)) {
        this._onlineViewers.set(viewerId, viewer);
        this.emit('viewerOnline', viewer);
        changed = true;
      }
    }
    for (const [actorId, viewerId] of freshActors) {
      this._actorToViewerId.set(actorId, viewerId);
    }

    if (changed) this.emit('viewerCountChanged', this.viewerCount);
  }

  // ============ Private: Helpers ============

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

  private _findViewerIdByActorId(actorTokenId: string): string | undefined {
    for (const viewer of this._onlineViewers.values()) {
      if (viewer.actorTokenId === actorTokenId) return viewer.viewerId;
    }
    return undefined;
  }
}
