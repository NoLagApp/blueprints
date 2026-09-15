import type {
  LobbyPresenceEvent,
  LobbyPresenceState,
  LobbyContext,
  ActorPresence,
  NoLagSocket,
} from '@nolag/js-sdk';
import { EventEmitter } from './EventEmitter';
import { SyncRoom } from './SyncRoom';
import { generateId, createLogger, registerWrapper, releaseWrapper } from './utils';
import { DEFAULT_APP_NAME, LOBBY_ID, LOBBY_REFRESH_DELAY_MS } from './constants';
import type {
  NoLagSyncOptions,
  ResolvedSyncOptions,
  SyncClientEvents,
  SyncCollaborator,
  SyncPresenceData,
  FilterValue,
  JoinCollectionOptions,
} from './types';

/**
 * NoLagSync — high-level real-time data sync SDK built on @nolag/js-sdk.
 *
 * Provides document CRUD, conflict resolution, version tracking, and global
 * collaborator presence — all framework-agnostic via events.
 *
 * The wrapper NEVER manages the connection. The app owns one core NoLag
 * client (shared by any number of wrappers on distinct apps) and the
 * wrapper attaches to it at construction and releases it via `detach()`.
 *
 * @example
 * ```typescript
 * import { NoLag } from '@nolag/js-sdk';
 * import { NoLagSync } from '@nolag/sync';
 *
 * const client = NoLag(async () => (await (await fetch('/api/nolag-token')).json()).token);
 * const sync = new NoLagSync({ client, appName: 'my-sync', username: 'Alice' });
 *
 * sync.on('collaboratorOnline', (c) => console.log(c.userId, 'is online'));
 *
 * await client.connect();   // the app owns the connection
 * await sync.ready();       // wrapper setup done (identity, lobby, collections)
 *
 * const collection = sync.joinCollection('todos');
 * collection.on('documentCreated', (doc) => console.log('New doc:', doc));
 * collection.createDocument('todo-1', { text: 'Hello world', done: false });
 *
 * sync.detach();            // wrapper releases its handlers and topics
 * client.disconnect();      // the app closes the socket
 * ```
 */
export class NoLagSync extends EventEmitter<SyncClientEvents> {
  private _client: NoLagSocket;
  private _options: ResolvedSyncOptions;
  private _localCollaborator: SyncCollaborator | null = null;
  private _collections = new Map<string, SyncRoom>();
  private _lobby: LobbyContext | null = null;
  private _onlineCollaborators = new Map<string, SyncCollaborator>();
  private _actorToUserId = new Map<string, string>();
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

  constructor(options: NoLagSyncOptions) {
    super();

    if (!options?.client) {
      throw new TypeError(
        'NoLagSync requires an injected NoLag client: new NoLagSync({ client, ... })',
      );
    }

    this._client = options.client;

    this._options = {
      userId: options.userId ?? generateId(),
      username: options.username,
      metadata: options.metadata,
      appName: options.appName ?? DEFAULT_APP_NAME,
      debug: options.debug ?? false,
      collections: options.collections ?? [],
    };

    this._log = createLogger('NoLagSync', this._options.debug);

    this._readyPromise = new Promise<void>((resolve, reject) => {
      this._readyResolve = resolve;
      this._readyReject = reject;
    });
    // ready() rejection is only meaningful to callers that await it
    this._readyPromise.catch(() => {});

    registerWrapper(this._client, this._options.appName, 'NoLagSync');

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

  /** The local collaborator's info (available after ready) */
  get localCollaborator(): SyncCollaborator | null {
    return this._localCollaborator;
  }

  /** All currently joined collections */
  get collections(): Map<string, SyncRoom> {
    return this._collections;
  }

  // ============ Lifecycle ============

  /**
   * Resolves once the wrapper's first setup completed (identity, online lobby
   * and configured collections ready — equivalently, once 'connected' has
   * fired). Rejects only if detach() is called before that. Client auth
   * failures surface via the app's own `await client.connect()`, not here.
   */
  ready(): Promise<void> {
    return this._readyPromise;
  }

  /**
   * Detach from the client: remove every handler this wrapper added,
   * unsubscribe its topics and lobby (when connected), clear state.
   * Terminal and idempotent; never touches the socket. To use sync again,
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

    // Collections: handler-specific off + connected-gated server unsubscribe
    for (const name of [...this._collections.keys()]) {
      this._collections.get(name)!._cleanup();
      this._collections.delete(name);
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

    this._onlineCollaborators.clear();
    this._actorToUserId.clear();
    this._localCollaborator = null;

    releaseWrapper(this._client, this._options.appName);

    if (!this._isReady) {
      this._readyReject(new Error('NoLagSync detached before ready'));
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
    if (!this._localCollaborator) {
      this._localCollaborator = {
        userId: this._options.userId,
        actorTokenId: this._client.actorId!,
        username: this._options.username,
        metadata: this._options.metadata,
        joinedAt: Date.now(),
        isLocal: true,
      };
      this._log('Local collaborator:', this._localCollaborator.userId, '→', this._localCollaborator.actorTokenId);
    } else {
      this._localCollaborator.actorTokenId = this._client.actorId!;
    }

    // Lobby: subscribe every epoch (idempotent server-side) and diff-hydrate
    // from the returned snapshot — one path for setup and restore.
    if (!this._lobby) {
      this._lobby = this._client.setApp(this._options.appName).setLobby(LOBBY_ID);
    }
    try {
      const state = await this._lobby.subscribe();
      if (stale()) return;
      this._diffHydrateOnlineCollaborators(state);
      this._log('Lobby subscribed, online collaborators:', this._onlineCollaborators.size);
    } catch (err) {
      if (stale()) return;
      this._log('Lobby subscription failed:', err);
    }

    if (!this._isReady) {
      // First successful setup: pre-join configured collections
      for (const name of this._options.collections) {
        this._joinCollectionInternal(name);
      }
    } else {
      // Server auto-restored topic subscriptions; only room-scoped presence
      // needs re-applying (the core does not restore it).
      for (const collection of this._collections.values()) {
        collection._updateLocalPresence();
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

    // Deferred lobby refetch: catches collaborators who joined during the
    // setup window (e.g. simultaneous multi-tab connects).
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
          this._diffHydrateOnlineCollaborators(state);
        })
        .catch(() => {
          /* best-effort */
        });
    }, LOBBY_REFRESH_DELAY_MS);
  }

  // ============ Collection Management ============

  /**
   * Join a sync collection. Creates, subscribes, and activates it.
   * Returns an existing collection if already joined.
   */
  joinCollection(name: string, opts?: JoinCollectionOptions): SyncRoom {
    this._assertUsable();

    let collection = this._collections.get(name);
    if (!collection) {
      collection = this._joinCollectionInternal(name, opts?.filters);
    } else if (opts?.filters) {
      // Already joined — re-point its filters rather than ignoring them.
      collection.setFilters(opts.filters);
    }

    return collection;
  }

  /**
   * Leave a sync collection. Fully unsubscribes and removes it.
   */
  leaveCollection(name: string): void {
    const collection = this._collections.get(name);
    if (!collection) return;

    this._log('Leaving collection:', name);
    collection._cleanup();
    this._collections.delete(name);
  }

  /**
   * Get all joined collections.
   */
  getCollections(): SyncRoom[] {
    return Array.from(this._collections.values());
  }

  // ============ Global Presence ============

  /**
   * Get all collaborators currently online across all collections.
   */
  getCollaborators(): SyncCollaborator[] {
    return Array.from(this._onlineCollaborators.values());
  }

  // ============ Private: Guards ============

  private _assertUsable(): void {
    if (this._detached) {
      throw new Error('NoLagSync has been detached — construct a new instance');
    }
    if (!this._isReady || !this._localCollaborator) {
      throw new Error('NoLagSync not ready — await ready() or the "connected" event');
    }
  }

  // ============ Private: Collection Setup ============

  private _joinCollectionInternal(name: string, filters?: FilterValue[]): SyncRoom {
    this._log('Subscribing collection:', name);

    const roomContext = this._client.setApp(this._options.appName).setRoom(name);
    const collection = new SyncRoom(
      name,
      roomContext,
      this._localCollaborator!,
      this._options,
      createLogger(`SyncRoom:${name}`, this._options.debug),
      () => this._client.connected,
    );

    this._collections.set(name, collection);
    collection._subscribe(filters);
    collection._activate();

    return collection;
  }

  // ============ Private: Scope Filtering ============

  /**
   * On a shared client, presence events from other apps' wrappers arrive on
   * the same connection-level events. Wrappers stamp their presence with a
   * `__scope` (their appName); a mismatched tag means another app's data.
   * Untagged presence is accepted (older peers in this same app).
   */
  private _foreignScope(data: SyncPresenceData | undefined): boolean {
    const scope = (data as Record<string, unknown> | undefined)?.__scope;
    return typeof scope === 'string' && scope !== this._options.appName;
  }

  // ============ Private: Room Presence ============

  private _handleRoomPresenceJoin(data: ActorPresence): void {
    if (data.actorTokenId === this._localCollaborator?.actorTokenId) return;
    const presenceData = data.presence as unknown as SyncPresenceData;
    if (!presenceData?.userId || this._foreignScope(presenceData)) return;

    const collaborator = this._presenceToCollaborator(data.actorTokenId, presenceData);
    this._actorToUserId.set(data.actorTokenId, collaborator.userId);
    if (!this._onlineCollaborators.has(collaborator.userId)) {
      this._onlineCollaborators.set(collaborator.userId, collaborator);
      this.emit('collaboratorOnline', collaborator);
    }

    // Route to all collections
    for (const collection of this._collections.values()) {
      collection._handlePresenceJoin(data.actorTokenId, presenceData);
    }
  }

  private _handleRoomPresenceLeave(data: ActorPresence): void {
    if (data.actorTokenId === this._localCollaborator?.actorTokenId) return;

    // Route to all collections
    for (const collection of this._collections.values()) {
      collection._handlePresenceLeave(data.actorTokenId);
    }
  }

  private _handleRoomPresenceUpdate(data: ActorPresence): void {
    if (data.actorTokenId === this._localCollaborator?.actorTokenId) return;
    const presenceData = data.presence as unknown as SyncPresenceData;
    if (!presenceData?.userId || this._foreignScope(presenceData)) return;

    if (this._onlineCollaborators.has(presenceData.userId)) {
      const collaborator = this._presenceToCollaborator(data.actorTokenId, presenceData);
      this._onlineCollaborators.set(collaborator.userId, collaborator);
    }

    // Route to all collections
    for (const collection of this._collections.values()) {
      collection._handlePresenceUpdate(data.actorTokenId, presenceData);
    }
  }

  // ============ Private: Lobby ============

  private _handleLobbyJoin(event: LobbyPresenceEvent): void {
    const { actorId, data } = event;
    if (actorId === this._localCollaborator?.actorTokenId) return;

    const presenceData = data as unknown as SyncPresenceData;
    if (!presenceData.userId || this._foreignScope(presenceData)) return;

    const collaborator = this._presenceToCollaborator(actorId, presenceData);
    this._actorToUserId.set(actorId, collaborator.userId);
    if (!this._onlineCollaborators.has(collaborator.userId)) {
      this._onlineCollaborators.set(collaborator.userId, collaborator);
      this.emit('collaboratorOnline', collaborator);
    }
  }

  private _handleLobbyLeave(event: LobbyPresenceEvent): void {
    const { actorId, data } = event;
    if (actorId === this._localCollaborator?.actorTokenId) return;

    const presenceData = data as unknown as SyncPresenceData;
    if (this._foreignScope(presenceData)) return;
    const userId = presenceData?.userId
      || this._actorToUserId.get(actorId)
      || this._findUserIdByActorId(actorId);

    if (userId) {
      const collaborator = this._onlineCollaborators.get(userId);
      if (collaborator) {
        this._onlineCollaborators.delete(userId);
        this._actorToUserId.delete(actorId);
        this.emit('collaboratorOffline', collaborator);
      }
    }
  }

  private _handleLobbyUpdate(event: LobbyPresenceEvent): void {
    const { actorId, data } = event;
    if (actorId === this._localCollaborator?.actorTokenId) return;

    const presenceData = data as unknown as SyncPresenceData;
    if (!presenceData.userId || this._foreignScope(presenceData)) return;

    const collaborator = this._presenceToCollaborator(actorId, presenceData);
    this._onlineCollaborators.set(collaborator.userId, collaborator);
  }

  /**
   * Reconcile the online-collaborator map against a fresh lobby snapshot,
   * emitting only the deltas (collaboratorOffline for vanished,
   * collaboratorOnline for new). One path for initial hydration, reconnect
   * restore, and the deferred refetch.
   */
  private _diffHydrateOnlineCollaborators(state: LobbyPresenceState): void {
    // Build the fresh collaborator set from the snapshot
    const fresh = new Map<string, SyncCollaborator>();
    const freshActors = new Map<string, string>();

    for (const roomId of Object.keys(state)) {
      const roomPresence = state[roomId];
      for (const actorId of Object.keys(roomPresence)) {
        if (actorId === this._localCollaborator?.actorTokenId) continue;

        const raw = roomPresence[actorId] as Record<string, unknown>;
        // Server returns full actor records with presence nested under .presence
        const presenceData = (raw?.presence ?? raw) as unknown as SyncPresenceData;
        if (presenceData?.userId && !this._foreignScope(presenceData)) {
          if (!fresh.has(presenceData.userId)) {
            fresh.set(presenceData.userId, this._presenceToCollaborator(actorId, presenceData));
          }
          freshActors.set(actorId, presenceData.userId);
        }
      }
    }

    // Vanished collaborators
    for (const [userId, collaborator] of [...this._onlineCollaborators]) {
      if (!fresh.has(userId)) {
        this._onlineCollaborators.delete(userId);
        for (const [actorId, mappedUserId] of [...this._actorToUserId]) {
          if (mappedUserId === userId) this._actorToUserId.delete(actorId);
        }
        this.emit('collaboratorOffline', collaborator);
      }
    }

    // New collaborators
    for (const [userId, collaborator] of fresh) {
      if (!this._onlineCollaborators.has(userId)) {
        this._onlineCollaborators.set(userId, collaborator);
        this.emit('collaboratorOnline', collaborator);
      }
    }
    for (const [actorId, userId] of freshActors) {
      this._actorToUserId.set(actorId, userId);
    }
  }

  // ============ Private: Helpers ============

  private _presenceToCollaborator(actorTokenId: string, data: SyncPresenceData): SyncCollaborator {
    return {
      userId: data.userId,
      actorTokenId,
      username: data.username,
      metadata: data.metadata,
      joinedAt: Date.now(),
      isLocal: false,
    };
  }

  private _findUserIdByActorId(actorTokenId: string): string | undefined {
    for (const collaborator of this._onlineCollaborators.values()) {
      if (collaborator.actorTokenId === actorTokenId) return collaborator.userId;
    }
    return undefined;
  }
}
