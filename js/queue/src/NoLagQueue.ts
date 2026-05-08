import type {
  NoLagOptions,
  LobbyPresenceEvent,
  LobbyPresenceState,
  LobbyContext,
  ActorPresence,
} from '@nolag/js-sdk';
import { NoLag } from '@nolag/js-sdk';
import { EventEmitter } from './EventEmitter';
import { QueueRoom } from './QueueRoom';
import { generateId, createLogger } from './utils';
import { DEFAULT_APP_NAME, DEFAULT_MAX_JOB_CACHE, DEFAULT_MAX_ATTEMPTS, LOBBY_ID } from './constants';
import type {
  NoLagQueueOptions,
  ResolvedQueueOptions,
  QueueClientEvents,
  QueueWorker,
  QueuePresenceData,
} from './types';

// The NoLag factory returns a client instance. We type it loosely
// because the actual class isn't exported (only the factory is).
type NoLagClient = ReturnType<typeof NoLag>;

/**
 * NoLagQueue — high-level real-time job queue SDK built on @nolag/js-sdk.
 *
 * Provides job lifecycle management, progress tracking, worker management,
 * and global presence tracking — all framework-agnostic via events.
 *
 * @example
 * ```typescript
 * import { NoLagQueue } from '@nolag/queue';
 *
 * const queue = new NoLagQueue(token, { role: 'worker', concurrency: 2 });
 *
 * queue.on('connected', () => console.log('Connected!'));
 *
 * await queue.connect();
 *
 * const room = queue.joinQueue('image-processing');
 * room.on('jobAdded', (job) => {
 *   room.claimJob(job.id);
 *   // process...
 *   room.reportProgress(job.id, 50);
 *   room.completeJob(job.id, { output: 'result' });
 * });
 * ```
 */
export class NoLagQueue extends EventEmitter<QueueClientEvents> {
  private _token: string;
  private _options: ResolvedQueueOptions;
  private _client: NoLagClient | null = null;
  private _localWorker: QueueWorker | null = null;
  private _queues = new Map<string, QueueRoom>();
  private _lobby: LobbyContext | null = null;
  private _onlineWorkers = new Map<string, QueueWorker>();
  private _actorToWorkerId = new Map<string, string>();
  private _workerId: string;
  private _log: (...args: unknown[]) => void;

  constructor(token: string, options: NoLagQueueOptions = {}) {
    super();
    this._token = token;
    this._workerId = options.workerId ?? generateId();

    this._options = {
      workerId: this._workerId,
      role: options.role ?? 'monitor',
      concurrency: options.concurrency ?? 1,
      metadata: options.metadata,
      appName: options.appName ?? DEFAULT_APP_NAME,
      url: options.url,
      maxJobCache: options.maxJobCache ?? DEFAULT_MAX_JOB_CACHE,
      debug: options.debug ?? false,
      reconnect: options.reconnect ?? true,
      queues: options.queues ?? [],
      loadBalanceGroup: options.loadBalanceGroup,
    };

    this._log = createLogger('NoLagQueue', this._options.debug);
  }

  // ============ Public Properties ============

  /** Whether the underlying connection is established */
  get connected(): boolean {
    return this._client?.connected ?? false;
  }

  /** The local worker's info (available after connect) */
  get localWorker(): QueueWorker | null {
    return this._localWorker;
  }

  /** All currently joined queue rooms */
  get queues(): Map<string, QueueRoom> {
    return this._queues;
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
      if (this._queues.size > 0) {
        this._log('Reconnected — restoring queues...');
        this._restoreQueues();
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

    // Create local worker record
    this._localWorker = {
      workerId: this._workerId,
      actorTokenId: this._client.actorId!,
      role: this._options.role,
      activeJobs: 0,
      concurrency: this._options.concurrency,
      metadata: this._options.metadata,
      joinedAt: Date.now(),
      isLocal: true,
    };

    this._log('Local worker:', this._localWorker.workerId, '→', this._localWorker.actorTokenId);

    // Set up lobby for global presence
    await this._setupLobby();

    // Emit connected now that _localWorker and lobby are ready
    this.emit('connected');

    // Deferred lobby refetch to catch workers who joined during the setup window
    setTimeout(() => {
      if (this._lobby && this._client?.connected) {
        this._lobby.fetchPresence().then((state) => {
          this._hydrateOnlineWorkers(state);
        }).catch(() => { /* ignore — best-effort */ });
      }
    }, 2000);
  }

  /**
   * Disconnect from NoLag and clean up all queue rooms.
   */
  disconnect(): void {
    this._log('Disconnecting...');

    // Clean up queue rooms
    for (const name of [...this._queues.keys()]) {
      this.leaveQueue(name);
    }

    // Unsubscribe from lobby
    this._lobby?.unsubscribe();
    this._lobby = null;

    // Disconnect client
    this._client?.disconnect();
    this._client = null;

    // Clear state
    this._onlineWorkers.clear();
    this._actorToWorkerId.clear();
    this._localWorker = null;
  }

  // ============ Queue Management ============

  /**
   * Join a queue room. Creates, subscribes, and activates it.
   * Returns an existing room if already joined.
   */
  joinQueue(name: string): QueueRoom {
    if (!this._client || !this._localWorker) {
      throw new Error('Not connected — call connect() first');
    }

    let room = this._queues.get(name);
    if (!room) {
      room = this._subscribeQueue(name);
      room._activate();
    }

    return room;
  }

  /**
   * Leave a queue room. Fully unsubscribes and removes it.
   */
  leaveQueue(name: string): void {
    const room = this._queues.get(name);
    if (!room) return;

    this._log('Leaving queue:', name);
    room._cleanup();
    this._queues.delete(name);
  }

  /**
   * Get all joined queue rooms.
   */
  getQueues(): QueueRoom[] {
    return Array.from(this._queues.values());
  }

  // ============ Global Presence ============

  /**
   * Get all workers currently online across all queue rooms.
   */
  getOnlineWorkers(): QueueWorker[] {
    return Array.from(this._onlineWorkers.values());
  }

  // ============ Private: Queue Setup ============

  private _subscribeQueue(name: string): QueueRoom {
    if (!this._client || !this._localWorker) {
      throw new Error('Not connected — call connect() first');
    }

    this._log('Subscribing queue:', name);

    const roomContext = this._client.setApp(this._options.appName).setRoom(name);
    const room = new QueueRoom(
      name,
      roomContext,
      this._workerId,
      this._options,
      createLogger(`QueueRoom:${name}`, this._options.debug),
    );

    room._setLocalActorId(this._localWorker.actorTokenId);

    this._queues.set(name, room);
    room._subscribe();

    return room;
  }

  // ============ Private: Room Presence ============

  private _handleRoomPresenceJoin(data: ActorPresence): void {
    if (data.actorTokenId === this._localWorker?.actorTokenId) return;
    const presenceData = data.presence as unknown as QueuePresenceData;
    if (!presenceData?.workerId) return;

    const worker = this._presenceToWorker(data.actorTokenId, presenceData);
    this._actorToWorkerId.set(data.actorTokenId, worker.workerId);
    if (!this._onlineWorkers.has(worker.workerId)) {
      this._onlineWorkers.set(worker.workerId, worker);
      this.emit('workerOnline', worker);
    }

    // Route to all queue rooms
    for (const room of this._queues.values()) {
      room._handlePresenceJoin(data.actorTokenId, presenceData);
    }
  }

  private _handleRoomPresenceLeave(data: ActorPresence): void {
    if (data.actorTokenId === this._localWorker?.actorTokenId) return;

    // Route to all queue rooms
    for (const room of this._queues.values()) {
      room._handlePresenceLeave(data.actorTokenId);
    }
  }

  private _handleRoomPresenceUpdate(data: ActorPresence): void {
    if (data.actorTokenId === this._localWorker?.actorTokenId) return;
    const presenceData = data.presence as unknown as QueuePresenceData;
    if (!presenceData?.workerId) return;

    if (this._onlineWorkers.has(presenceData.workerId)) {
      const worker = this._presenceToWorker(data.actorTokenId, presenceData);
      this._onlineWorkers.set(worker.workerId, worker);
    }

    // Route to all queue rooms
    for (const room of this._queues.values()) {
      room._handlePresenceUpdate(data.actorTokenId, presenceData);
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
      this._hydrateOnlineWorkers(initialState);
      this._log('Lobby subscribed, online workers:', this._onlineWorkers.size);
    } catch (err) {
      this._log('Lobby subscription failed:', err);
    }
  }

  private _handleLobbyJoin(event: LobbyPresenceEvent): void {
    const { actorId, data } = event;
    if (actorId === this._localWorker?.actorTokenId) return;

    const presenceData = data as unknown as QueuePresenceData;
    if (!presenceData.workerId) return;

    const worker = this._presenceToWorker(actorId, presenceData);
    this._actorToWorkerId.set(actorId, worker.workerId);
    if (!this._onlineWorkers.has(worker.workerId)) {
      this._onlineWorkers.set(worker.workerId, worker);
      this.emit('workerOnline', worker);
    }
  }

  private _handleLobbyLeave(event: LobbyPresenceEvent): void {
    const { actorId, data } = event;
    if (actorId === this._localWorker?.actorTokenId) return;

    const presenceData = data as unknown as QueuePresenceData;
    const workerId = presenceData?.workerId
      || this._actorToWorkerId.get(actorId)
      || this._findWorkerIdByActorId(actorId);

    if (workerId) {
      const worker = this._onlineWorkers.get(workerId);
      if (worker) {
        this._onlineWorkers.delete(workerId);
        this._actorToWorkerId.delete(actorId);
        this.emit('workerOffline', worker);
      }
    }
  }

  private _handleLobbyUpdate(event: LobbyPresenceEvent): void {
    const { actorId, data } = event;
    if (actorId === this._localWorker?.actorTokenId) return;

    const presenceData = data as unknown as QueuePresenceData;
    if (!presenceData.workerId) return;

    const worker = this._presenceToWorker(actorId, presenceData);
    this._onlineWorkers.set(worker.workerId, worker);
  }

  private _hydrateOnlineWorkers(state: LobbyPresenceState): void {
    for (const roomId of Object.keys(state)) {
      const roomPresence = state[roomId];
      for (const actorId of Object.keys(roomPresence)) {
        if (actorId === this._localWorker?.actorTokenId) continue;

        const raw = roomPresence[actorId] as Record<string, unknown>;
        const presenceData = (raw?.presence ?? raw) as unknown as QueuePresenceData;
        if (presenceData?.workerId) {
          const worker = this._presenceToWorker(actorId, presenceData);
          this._actorToWorkerId.set(actorId, worker.workerId);
          if (!this._onlineWorkers.has(worker.workerId)) {
            this._onlineWorkers.set(worker.workerId, worker);
            this.emit('workerOnline', worker);
          }
        }
      }
    }
  }

  // ============ Private: Helpers ============

  private _presenceToWorker(actorTokenId: string, data: QueuePresenceData): QueueWorker {
    return {
      workerId: data.workerId,
      actorTokenId,
      role: data.role,
      activeJobs: data.activeJobs ?? 0,
      concurrency: data.concurrency ?? 1,
      metadata: data.metadata,
      joinedAt: Date.now(),
      isLocal: false,
    };
  }

  private _findWorkerIdByActorId(actorTokenId: string): string | undefined {
    for (const worker of this._onlineWorkers.values()) {
      if (worker.actorTokenId === actorTokenId) return worker.workerId;
    }
    return undefined;
  }

  private _restoreQueues(): void {
    // On reconnect, js-sdk auto-restores subscriptions.
    // Re-set presence on all active queue rooms.
    for (const room of this._queues.values()) {
      room._updateLocalPresence();
    }

    // Re-fetch lobby presence
    this._lobby?.fetchPresence().then((state) => {
      this._onlineWorkers.clear();
      this._actorToWorkerId.clear();
      this._hydrateOnlineWorkers(state);
    }).catch((err) => {
      this._log('Failed to re-fetch lobby presence:', err);
    });
  }
}
