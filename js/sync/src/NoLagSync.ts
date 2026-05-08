import type {
  NoLagOptions,
  LobbyPresenceEvent,
  LobbyPresenceState,
  LobbyContext,
  ActorPresence,
} from '@nolag/js-sdk';
import { NoLag } from '@nolag/js-sdk';
import { EventEmitter } from './EventEmitter';
import { SyncRoom } from './SyncRoom';
import { generateId, createLogger } from './utils';
import { DEFAULT_APP_NAME, LOBBY_ID } from './constants';
import type {
  NoLagSyncOptions,
  ResolvedSyncOptions,
  SyncClientEvents,
  SyncCollaborator,
  SyncPresenceData,
} from './types';

// The NoLag factory returns a client instance. We type it loosely
// because the actual class isn't exported (only the factory is).
type NoLagClient = ReturnType<typeof NoLag>;

/**
 * NoLagSync — high-level real-time data sync SDK built on @nolag/js-sdk.
 *
 * Provides document CRUD, conflict resolution, version tracking, and global
 * collaborator presence — all framework-agnostic via events.
 *
 * @example
 * ```typescript
 * import { NoLagSync } from '@nolag/sync';
 *
 * const sync = new NoLagSync(token, { debug: true });
 *
 * sync.on('connected', () => console.log('Connected!'));
 * sync.on('collaboratorOnline', (c) => console.log(c.userId, 'is online'));
 *
 * await sync.connect();
 *
 * const collection = sync.joinCollection('todos');
 * collection.on('documentCreated', (doc) => console.log('New doc:', doc));
 * collection.createDocument('todo-1', { text: 'Hello world', done: false });
 * ```
 */
export class NoLagSync extends EventEmitter<SyncClientEvents> {
  private _token: string;
  private _options: ResolvedSyncOptions;
  private _client: NoLagClient | null = null;
  private _localCollaborator: SyncCollaborator | null = null;
  private _collections = new Map<string, SyncRoom>();
  private _lobby: LobbyContext | null = null;
  private _onlineCollaborators = new Map<string, SyncCollaborator>();
  private _actorToUserId = new Map<string, string>();
  private _log: (...args: unknown[]) => void;

  constructor(token: string, options: NoLagSyncOptions = {}) {
    super();
    this._token = token;

    this._options = {
      userId: options.userId ?? generateId(),
      username: options.username,
      metadata: options.metadata,
      appName: options.appName ?? DEFAULT_APP_NAME,
      url: options.url,
      debug: options.debug ?? false,
      reconnect: options.reconnect ?? true,
      collections: options.collections ?? [],
    };

    this._log = createLogger('NoLagSync', this._options.debug);
  }

  // ============ Public Properties ============

  /** Whether the underlying connection is established */
  get connected(): boolean {
    return this._client?.connected ?? false;
  }

  /** The local collaborator's info (available after connect) */
  get localCollaborator(): SyncCollaborator | null {
    return this._localCollaborator;
  }

  /** All currently joined collections */
  get collections(): Map<string, SyncRoom> {
    return this._collections;
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
      if (this._collections.size > 0) {
        this._log('Reconnected — restoring collections...');
        this._restoreCollections();
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

    // Create local collaborator
    this._localCollaborator = {
      userId: this._options.userId,
      actorTokenId: this._client.actorId!,
      username: this._options.username,
      metadata: this._options.metadata,
      joinedAt: Date.now(),
      isLocal: true,
    };

    this._log('Local collaborator:', this._localCollaborator.userId, '→', this._localCollaborator.actorTokenId);

    // Set up lobby for global presence
    await this._setupLobby();

    // Emit connected now that _localCollaborator and lobby are ready
    this.emit('connected');

    // Auto-join pre-configured collections
    for (const name of this._options.collections) {
      this.joinCollection(name);
    }

    // Deferred lobby refetch to catch collaborators who joined during the setup window
    setTimeout(() => {
      if (this._lobby && this._client?.connected) {
        this._lobby.fetchPresence().then((state) => {
          this._hydrateOnlineCollaborators(state);
        }).catch(() => { /* ignore — best-effort */ });
      }
    }, 2000);
  }

  /**
   * Disconnect from NoLag and clean up all collections.
   */
  disconnect(): void {
    this._log('Disconnecting...');

    // Clean up collections
    for (const name of [...this._collections.keys()]) {
      this.leaveCollection(name);
    }

    // Unsubscribe from lobby
    this._lobby?.unsubscribe();
    this._lobby = null;

    // Disconnect client
    this._client?.disconnect();
    this._client = null;

    // Clear state
    this._onlineCollaborators.clear();
    this._actorToUserId.clear();
    this._localCollaborator = null;
  }

  // ============ Collection Management ============

  /**
   * Join a sync collection. Creates, subscribes, and activates it.
   * Returns an existing collection if already joined.
   */
  joinCollection(name: string): SyncRoom {
    if (!this._client || !this._localCollaborator) {
      throw new Error('Not connected — call connect() first');
    }

    let collection = this._collections.get(name);
    if (!collection) {
      collection = this._subscribeCollection(name);
      collection._activate();
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

  // ============ Private: Collection Setup ============

  private _subscribeCollection(name: string): SyncRoom {
    if (!this._client || !this._localCollaborator) {
      throw new Error('Not connected — call connect() first');
    }

    this._log('Subscribing collection:', name);

    const roomContext = this._client.setApp(this._options.appName).setRoom(name);
    const collection = new SyncRoom(
      name,
      roomContext,
      this._localCollaborator,
      this._options,
      createLogger(`SyncRoom:${name}`, this._options.debug),
    );

    this._collections.set(name, collection);
    collection._subscribe();

    return collection;
  }

  // ============ Private: Room Presence ============

  private _handleRoomPresenceJoin(data: ActorPresence): void {
    if (data.actorTokenId === this._localCollaborator?.actorTokenId) return;
    const presenceData = data.presence as unknown as SyncPresenceData;
    if (!presenceData?.userId) return;

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
    if (!presenceData?.userId) return;

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
      this._hydrateOnlineCollaborators(initialState);
      this._log('Lobby subscribed, online collaborators:', this._onlineCollaborators.size);
    } catch (err) {
      this._log('Lobby subscription failed:', err);
    }
  }

  private _handleLobbyJoin(event: LobbyPresenceEvent): void {
    const { actorId, data } = event;
    if (actorId === this._localCollaborator?.actorTokenId) return;

    const presenceData = data as unknown as SyncPresenceData;
    if (!presenceData.userId) return;

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
    if (!presenceData.userId) return;

    const collaborator = this._presenceToCollaborator(actorId, presenceData);
    this._onlineCollaborators.set(collaborator.userId, collaborator);
  }

  private _hydrateOnlineCollaborators(state: LobbyPresenceState): void {
    for (const roomId of Object.keys(state)) {
      const roomPresence = state[roomId];
      for (const actorId of Object.keys(roomPresence)) {
        if (actorId === this._localCollaborator?.actorTokenId) continue;

        const raw = roomPresence[actorId] as Record<string, unknown>;
        const presenceData = (raw?.presence ?? raw) as unknown as SyncPresenceData;
        if (presenceData?.userId) {
          const collaborator = this._presenceToCollaborator(actorId, presenceData);
          this._actorToUserId.set(actorId, collaborator.userId);
          if (!this._onlineCollaborators.has(collaborator.userId)) {
            this._onlineCollaborators.set(collaborator.userId, collaborator);
            this.emit('collaboratorOnline', collaborator);
          }
        }
      }
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

  private _restoreCollections(): void {
    // On reconnect, js-sdk auto-restores subscriptions.
    // Re-set presence on all active collections.
    for (const collection of this._collections.values()) {
      collection._updateLocalPresence();
    }

    // Re-fetch lobby presence
    this._lobby?.fetchPresence().then((state) => {
      this._onlineCollaborators.clear();
      this._actorToUserId.clear();
      this._hydrateOnlineCollaborators(state);
    }).catch((err) => {
      this._log('Failed to re-fetch lobby presence:', err);
    });
  }
}
