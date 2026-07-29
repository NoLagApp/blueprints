import type {
  LobbyPresenceEvent,
  LobbyPresenceState,
  LobbyContext,
  ActorPresence,
  NoLagSocket,
} from '@nolag/js-sdk';
import { EventEmitter } from './EventEmitter';
import { CollabDocument } from './CollabDocument';
import { generateId, createLogger, registerWrapper, releaseWrapper } from './utils';
import {
  DEFAULT_APP_NAME,
  DEFAULT_MAX_OPERATION_CACHE,
  DEFAULT_IDLE_TIMEOUT,
  DEFAULT_CURSOR_THROTTLE,
  LOBBY_ID,
  LOBBY_REFRESH_DELAY_MS,
} from './constants';
import type {
  NoLagCollabOptions,
  ResolvedCollabOptions,
  CollabClientEvents,
  CollabUser,
  CollabPresenceData,
} from './types';

/**
 * NoLagCollab — high-level real-time collaboration SDK built on @nolag/js-sdk.
 *
 * Provides document-scoped operations, cursor broadcasting, and user awareness
 * (idle detection, status tracking) — all framework-agnostic via events.
 *
 * The wrapper NEVER manages the connection. The app owns one core NoLag
 * client (shared by any number of wrappers on distinct apps) and the
 * wrapper attaches to it at construction and releases it via `detach()`.
 *
 * @example
 * ```typescript
 * import { NoLag } from '@nolag/js-sdk';
 * import { NoLagCollab } from '@nolag/collab';
 *
 * const client = NoLag(async () => (await (await fetch('/api/nolag-token')).json()).token);
 * const collab = new NoLagCollab({ client, appName: 'my-collab', username: 'Alice' });
 *
 * collab.on('userOnline', (user) => console.log(user.username, 'is online'));
 *
 * await client.connect();   // the app owns the connection
 * await collab.ready();     // wrapper setup done (identity, lobby, documents)
 *
 * const doc = collab.joinDocument('my-doc');
 * doc.on('operation', (op) => applyOp(op));
 * doc.sendOperation('insert', { position: 0, content: 'Hello' });
 *
 * collab.detach();          // wrapper releases its handlers and topics
 * client.disconnect();      // the app closes the socket
 * ```
 */
export class NoLagCollab extends EventEmitter<CollabClientEvents> {
  private _client: NoLagSocket;
  private _options: ResolvedCollabOptions;
  private _localUser: CollabUser | null = null;
  private _documents = new Map<string, CollabDocument>();
  private _lobby: LobbyContext | null = null;
  private _onlineUsers = new Map<string, CollabUser>();
  private _actorToUserId = new Map<string, string>();
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
  private _onPresenceJoinRef = (data: ActorPresence) => this._handleRoomPresenceJoin(data);
  private _onPresenceLeaveRef = (data: ActorPresence) => this._handleRoomPresenceLeave(data);
  private _onPresenceUpdateRef = (data: ActorPresence) => this._handleRoomPresenceUpdate(data);
  private _onLobbyJoinRef = (data: unknown) => this._handleLobbyJoin(data as LobbyPresenceEvent);
  private _onLobbyLeaveRef = (data: unknown) => this._handleLobbyLeave(data as LobbyPresenceEvent);
  private _onLobbyUpdateRef = (data: unknown) => this._handleLobbyUpdate(data as LobbyPresenceEvent);

  constructor(options: NoLagCollabOptions) {
    super();

    if (!options?.client) {
      throw new TypeError(
        'NoLagCollab requires an injected NoLag client: new NoLagCollab({ client, username, ... })',
      );
    }

    this._client = options.client;
    this._userId = generateId();

    this._options = {
      username: options.username,
      avatar: options.avatar,
      color: options.color,
      metadata: options.metadata,
      appName: options.appName ?? DEFAULT_APP_NAME,
      maxOperationCache: options.maxOperationCache ?? DEFAULT_MAX_OPERATION_CACHE,
      idleTimeout: options.idleTimeout ?? DEFAULT_IDLE_TIMEOUT,
      cursorThrottle: options.cursorThrottle ?? DEFAULT_CURSOR_THROTTLE,
      debug: options.debug ?? false,
      documents: options.documents ?? [],
    };

    this._log = createLogger('NoLagCollab', this._options.debug);

    this._readyPromise = new Promise<void>((resolve, reject) => {
      this._readyResolve = resolve;
      this._readyReject = reject;
    });
    // ready() rejection is only meaningful to callers that await it
    this._readyPromise.catch(() => {});

    registerWrapper(this._client, this._options.appName, 'NoLagCollab');

    // Construction = attach: wire everything now, with stored refs.
    this._client.on('connect', this._onConnectRef);
    this._client.on('disconnect', this._onDisconnectRef);
    this._client.on('reconnect', this._onReconnectRef);
    this._client.on('error', this._onErrorRef);
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
  get localUser(): CollabUser | null {
    return this._localUser;
  }

  /** All currently joined documents */
  get documents(): Map<string, CollabDocument> {
    return this._documents;
  }

  // ============ Lifecycle ============

  /**
   * Resolves once the wrapper's first setup completed (identity, lobby and
   * configured documents ready — equivalently, once 'connected' has fired).
   * Rejects only if detach() is called before that. Client auth failures
   * surface via the app's own `await client.connect()`, not here.
   */
  ready(): Promise<void> {
    return this._readyPromise;
  }

  /**
   * Detach from the client: remove every handler this wrapper added,
   * unsubscribe its topics and lobby (when connected), clear state.
   * Terminal and idempotent; never touches the socket. To use collab again,
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
    this._client.off('presence:join', this._onPresenceJoinRef);
    this._client.off('presence:leave', this._onPresenceLeaveRef);
    this._client.off('presence:update', this._onPresenceUpdateRef);
    this._client.off('lobbyPresence:join', this._onLobbyJoinRef);
    this._client.off('lobbyPresence:leave', this._onLobbyLeaveRef);
    this._client.off('lobbyPresence:update', this._onLobbyUpdateRef);

    // Documents: handler-specific off + connected-gated server unsubscribe.
    // _cleanup also clears each document's cursor-throttle and idle timers.
    for (const name of [...this._documents.keys()]) {
      this._documents.get(name)!._cleanup();
      this._documents.delete(name);
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

    this._onlineUsers.clear();
    this._actorToUserId.clear();
    this._localUser = null;

    releaseWrapper(this._client, this._options.appName);

    if (!this._isReady) {
      this._readyReject(new Error('NoLagCollab detached before ready'));
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
        color: this._options.color,
        status: 'active',
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
      // First successful setup: auto-join configured documents
      for (const name of this._options.documents) {
        this._subscribeDocumentInternal(name);
      }
    } else {
      // Server auto-restored topic subscriptions; only room-scoped presence
      // needs re-applying (the core does not restore it).
      for (const doc of this._documents.values()) {
        doc._updateLocalPresence();
      }
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

  // ============ Document Management ============

  /**
   * Join a collaborative document. Creates, subscribes, and activates it.
   * Returns an existing document if already joined.
   */
  joinDocument(name: string): CollabDocument {
    this._assertUsable();

    let doc = this._documents.get(name);
    if (!doc) {
      doc = this._subscribeDocumentInternal(name);
      doc._activate();
    }

    return doc;
  }

  /**
   * Leave a collaborative document. Fully unsubscribes and removes it.
   */
  leaveDocument(name: string): void {
    const doc = this._documents.get(name);
    if (!doc) return;

    this._log('Leaving document:', name);
    doc._cleanup();
    this._documents.delete(name);
  }

  /**
   * Get all joined documents.
   */
  getDocuments(): CollabDocument[] {
    return Array.from(this._documents.values());
  }

  // ============ Global Presence ============

  /**
   * Get all users currently online across all documents.
   */
  getOnlineUsers(): CollabUser[] {
    return Array.from(this._onlineUsers.values());
  }

  // ============ Private: Guards ============

  private _assertUsable(): void {
    if (this._detached) {
      throw new Error('NoLagCollab has been detached — construct a new instance');
    }
    if (!this._isReady || !this._localUser) {
      throw new Error('NoLagCollab not ready — await ready() or the "connected" event');
    }
  }

  // ============ Private: Document Setup ============

  private _subscribeDocumentInternal(name: string): CollabDocument {
    this._log('Subscribing document:', name);

    const roomContext = this._client.setApp(this._options.appName).setRoom(name);
    const doc = new CollabDocument(
      name,
      roomContext,
      this._localUser!,
      this._options,
      createLogger(`CollabDocument:${name}`, this._options.debug),
      () => this._client.connected,
    );

    this._documents.set(name, doc);
    doc._subscribe();

    return doc;
  }

  // ============ Private: Scope Filtering ============

  /**
   * On a shared client, presence events from other apps' wrappers arrive on
   * the same connection-level events. Wrappers stamp their presence with a
   * `__scope` (their appName); a mismatched tag means another app's data.
   * Untagged presence is accepted (older peers in this same app).
   */
  private _foreignScope(data: CollabPresenceData | undefined): boolean {
    const scope = (data as Record<string, unknown> | undefined)?.__scope;
    return typeof scope === 'string' && scope !== this._options.appName;
  }

  // ============ Private: Room Presence ============

  private _handleRoomPresenceJoin(data: ActorPresence): void {
    if (data.actorTokenId === this._localUser?.actorTokenId) return;
    const presenceData = data.presence as unknown as CollabPresenceData;
    if (!presenceData?.userId || this._foreignScope(presenceData)) return;

    const user = this._presenceToUser(data.actorTokenId, presenceData);
    this._actorToUserId.set(data.actorTokenId, user.userId);
    if (!this._onlineUsers.has(user.userId)) {
      this._onlineUsers.set(user.userId, user);
      this.emit('userOnline', user);
    }

    // Route to all documents
    for (const doc of this._documents.values()) {
      doc._handlePresenceJoin(data.actorTokenId, presenceData);
    }
  }

  private _handleRoomPresenceLeave(data: ActorPresence): void {
    if (data.actorTokenId === this._localUser?.actorTokenId) return;

    // Route to all documents
    for (const doc of this._documents.values()) {
      doc._handlePresenceLeave(data.actorTokenId);
    }
  }

  private _handleRoomPresenceUpdate(data: ActorPresence): void {
    if (data.actorTokenId === this._localUser?.actorTokenId) return;
    const presenceData = data.presence as unknown as CollabPresenceData;
    if (!presenceData?.userId || this._foreignScope(presenceData)) return;

    if (this._onlineUsers.has(presenceData.userId)) {
      const user = this._presenceToUser(data.actorTokenId, presenceData);
      this._onlineUsers.set(user.userId, user);
    }

    // Route to all documents
    for (const doc of this._documents.values()) {
      doc._handlePresenceUpdate(data.actorTokenId, presenceData);
    }
  }

  // ============ Private: Lobby ============

  private _handleLobbyJoin(event: LobbyPresenceEvent): void {
    const { actorId, data } = event;
    if (actorId === this._localUser?.actorTokenId) return;

    const presenceData = data as unknown as CollabPresenceData;
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

    const presenceData = data as unknown as CollabPresenceData;
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

    const presenceData = data as unknown as CollabPresenceData;
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
    const fresh = new Map<string, CollabUser>();
    const freshActors = new Map<string, string>();

    for (const roomId of Object.keys(state)) {
      const roomPresence = state[roomId];
      for (const actorId of Object.keys(roomPresence)) {
        if (actorId === this._localUser?.actorTokenId) continue;

        const raw = roomPresence[actorId] as Record<string, unknown>;
        // Server returns full actor records with presence nested under .presence
        const presenceData = (raw?.presence ?? raw) as unknown as CollabPresenceData;
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

  private _presenceToUser(actorTokenId: string, data: CollabPresenceData): CollabUser {
    return {
      userId: data.userId,
      actorTokenId,
      username: data.username,
      avatar: data.avatar,
      color: data.color,
      status: data.status ?? 'active',
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
