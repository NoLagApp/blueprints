import type {
  NoLagOptions,
  LobbyPresenceEvent,
  LobbyPresenceState,
  LobbyContext,
  ActorPresence,
} from '@nolag/js-sdk';
import { NoLag } from '@nolag/js-sdk';
import { EventEmitter } from './EventEmitter';
import { CollabDocument } from './CollabDocument';
import { generateId, createLogger } from './utils';
import { DEFAULT_APP_NAME, DEFAULT_MAX_OPERATION_CACHE, DEFAULT_IDLE_TIMEOUT, DEFAULT_CURSOR_THROTTLE, LOBBY_ID } from './constants';
import type {
  NoLagCollabOptions,
  ResolvedCollabOptions,
  CollabClientEvents,
  CollabUser,
  CollabPresenceData,
} from './types';

// The NoLag factory returns a client instance. We type it loosely
// because the actual class isn't exported (only the factory is).
type NoLagClient = ReturnType<typeof NoLag>;

/**
 * NoLagCollab — high-level real-time collaboration SDK built on @nolag/js-sdk.
 *
 * Provides document-scoped operations, cursor broadcasting, and user awareness
 * (idle detection, status tracking) — all framework-agnostic via events.
 *
 * @example
 * ```typescript
 * import { NoLagCollab } from '@nolag/collab';
 *
 * const collab = new NoLagCollab(token, { username: 'Alice', debug: true });
 *
 * collab.on('connected', () => console.log('Connected!'));
 * collab.on('userOnline', (user) => console.log(user.username, 'is online'));
 *
 * await collab.connect();
 *
 * const doc = collab.joinDocument('my-doc');
 * doc.on('operation', (op) => applyOp(op));
 * doc.sendOperation('insert', { position: 0, content: 'Hello' });
 * ```
 */
export class NoLagCollab extends EventEmitter<CollabClientEvents> {
  private _token: string;
  private _options: ResolvedCollabOptions;
  private _client: NoLagClient | null = null;
  private _localUser: CollabUser | null = null;
  private _documents = new Map<string, CollabDocument>();
  private _lobby: LobbyContext | null = null;
  private _onlineUsers = new Map<string, CollabUser>();
  private _actorToUserId = new Map<string, string>();
  private _userId: string;
  private _log: (...args: unknown[]) => void;

  constructor(token: string, options: NoLagCollabOptions) {
    super();
    this._token = token;
    this._userId = generateId();

    this._options = {
      username: options.username,
      avatar: options.avatar,
      color: options.color,
      metadata: options.metadata,
      appName: options.appName ?? DEFAULT_APP_NAME,
      url: options.url,
      maxOperationCache: options.maxOperationCache ?? DEFAULT_MAX_OPERATION_CACHE,
      idleTimeout: options.idleTimeout ?? DEFAULT_IDLE_TIMEOUT,
      cursorThrottle: options.cursorThrottle ?? DEFAULT_CURSOR_THROTTLE,
      debug: options.debug ?? false,
      reconnect: options.reconnect ?? true,
      documents: options.documents ?? [],
    };

    this._log = createLogger('NoLagCollab', this._options.debug);
  }

  // ============ Public Properties ============

  /** Whether the underlying connection is established */
  get connected(): boolean {
    return this._client?.connected ?? false;
  }

  /** The local user's info (available after connect) */
  get localUser(): CollabUser | null {
    return this._localUser;
  }

  /** All currently joined documents */
  get documents(): Map<string, CollabDocument> {
    return this._documents;
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
    this._client.on('connect', () => {
      this._log('Connected');
      if (this._documents.size > 0) {
        this._log('Reconnected — restoring documents...');
        this._restoreDocuments();
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

    // Connect
    await this._client.connect();

    // Wire room-level presence events
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
      color: this._options.color,
      status: 'active',
      metadata: this._options.metadata,
      joinedAt: Date.now(),
      isLocal: true,
    };

    this._log('Local user:', this._localUser.userId, '→', this._localUser.actorTokenId);

    // Set up lobby for global presence
    await this._setupLobby();

    // Emit connected now that _localUser and lobby are ready
    this.emit('connected');

    // Auto-join documents specified in options
    for (const docName of this._options.documents) {
      this.joinDocument(docName);
    }

    // Deferred lobby refetch to catch users who joined during the setup window
    setTimeout(() => {
      if (this._lobby && this._client?.connected) {
        this._lobby.fetchPresence().then((state) => {
          this._hydrateOnlineUsers(state);
        }).catch(() => { /* ignore — best-effort */ });
      }
    }, 2000);
  }

  /**
   * Disconnect from NoLag and clean up all documents.
   */
  disconnect(): void {
    this._log('Disconnecting...');

    // Clean up documents
    for (const name of [...this._documents.keys()]) {
      this.leaveDocument(name);
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

  // ============ Document Management ============

  /**
   * Join a collaborative document. Creates, subscribes, and activates it.
   * Returns an existing document if already joined.
   */
  joinDocument(name: string): CollabDocument {
    if (!this._client || !this._localUser) {
      throw new Error('Not connected — call connect() first');
    }

    let doc = this._documents.get(name);
    if (!doc) {
      doc = this._subscribeDocument(name);
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

  // ============ Private: Document Setup ============

  private _subscribeDocument(name: string): CollabDocument {
    if (!this._client || !this._localUser) {
      throw new Error('Not connected — call connect() first');
    }

    this._log('Subscribing document:', name);

    const roomContext = this._client.setApp(this._options.appName).setRoom(name);
    const doc = new CollabDocument(
      name,
      roomContext,
      this._localUser,
      this._options,
      createLogger(`CollabDocument:${name}`, this._options.debug),
    );

    this._documents.set(name, doc);
    doc._subscribe();

    return doc;
  }

  // ============ Private: Room Presence ============

  private _handleRoomPresenceJoin(data: ActorPresence): void {
    if (data.actorTokenId === this._localUser?.actorTokenId) return;
    const presenceData = data.presence as unknown as CollabPresenceData;
    if (!presenceData?.userId) return;

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
    if (!presenceData?.userId) return;

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

  private async _setupLobby(): Promise<void> {
    if (!this._client) return;

    this._lobby = this._client.setApp(this._options.appName).setLobby(LOBBY_ID);

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

    const presenceData = data as unknown as CollabPresenceData;
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

    const presenceData = data as unknown as CollabPresenceData;
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
    if (!presenceData.userId) return;

    const user = this._presenceToUser(actorId, presenceData);
    this._onlineUsers.set(user.userId, user);
  }

  private _hydrateOnlineUsers(state: LobbyPresenceState): void {
    for (const roomId of Object.keys(state)) {
      const roomPresence = state[roomId];
      for (const actorId of Object.keys(roomPresence)) {
        if (actorId === this._localUser?.actorTokenId) continue;

        const raw = roomPresence[actorId] as Record<string, unknown>;
        const presenceData = (raw?.presence ?? raw) as unknown as CollabPresenceData;
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

  private _restoreDocuments(): void {
    // On reconnect, js-sdk auto-restores subscriptions.
    // Re-set presence on all active documents.
    for (const doc of this._documents.values()) {
      doc._updateLocalPresence();
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
