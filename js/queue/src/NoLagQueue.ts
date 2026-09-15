import type {
  LobbyPresenceEvent,
  LobbyPresenceState,
  LobbyContext,
  ActorPresence,
  NoLagSocket,
} from '@nolag/js-sdk';
import { EventEmitter } from './EventEmitter';
import { QueueRoom } from './QueueRoom';
import { generateId, createLogger, registerWrapper, releaseWrapper } from './utils';
import {
  DEFAULT_APP_NAME,
  DEFAULT_MAX_JOB_CACHE,
  LOBBY_ID,
  LOBBY_REFRESH_DELAY_MS,
} from './constants';
import type {
  NoLagQueueOptions,
  ResolvedQueueOptions,
  QueueClientEvents,
  QueueWorker,
  QueuePresenceData,
  FilterValue,
  JoinQueueOptions,
} from './types';

/**
 * NoLagQueue — high-level real-time job queue SDK built on @nolag/js-sdk.
 *
 * Provides job lifecycle management, progress tracking, worker management,
 * and global presence tracking — all framework-agnostic via events.
 *
 * The wrapper NEVER manages the connection. The app owns one core NoLag
 * client (shared by any number of wrappers on distinct apps) and the
 * wrapper attaches to it at construction and releases it via `detach()`.
 *
 * @example
 * ```typescript
 * import { NoLag } from '@nolag/js-sdk';
 * import { NoLagQueue } from '@nolag/queue';
 *
 * const client = NoLag(async () => (await (await fetch('/api/nolag-token')).json()).token);
 * const queue = new NoLagQueue({ client, role: 'worker', concurrency: 2 });
 *
 * queue.on('connected', () => console.log('Connected!'));
 *
 * await client.connect();   // the app owns the connection
 * await queue.ready();      // wrapper setup done (identity, lobby, queues)
 *
 * const room = queue.joinQueue('image-processing');
 * room.on('jobAdded', (job) => {
 *   room.claimJob(job.id);
 *   room.reportProgress(job.id, 50);
 *   room.completeJob(job.id, { output: 'result' });
 * });
 *
 * queue.detach();           // wrapper releases its handlers and topics
 * client.disconnect();      // the app closes the socket
 * ```
 */
export class NoLagQueue extends EventEmitter<QueueClientEvents> {
  private _client: NoLagSocket;
  private _options: ResolvedQueueOptions;
  private _localWorker: QueueWorker | null = null;
  private _queues = new Map<string, QueueRoom>();
  private _lobby: LobbyContext | null = null;
  private _onlineWorkers = new Map<string, QueueWorker>();
  private _actorToWorkerId = new Map<string, string>();
  private _workerId: string;
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

  constructor(options: NoLagQueueOptions) {
    super();

    if (!options?.client) {
      throw new TypeError(
        'NoLagQueue requires an injected NoLag client: new NoLagQueue({ client, role, ... })',
      );
    }

    this._client = options.client;
    this._workerId = options.workerId ?? generateId();

    this._options = {
      workerId: this._workerId,
      role: options.role ?? 'monitor',
      concurrency: options.concurrency ?? 1,
      metadata: options.metadata,
      appName: options.appName ?? DEFAULT_APP_NAME,
      maxJobCache: options.maxJobCache ?? DEFAULT_MAX_JOB_CACHE,
      debug: options.debug ?? false,
      queues: options.queues ?? [],
      loadBalanceGroup: options.loadBalanceGroup,
    };

    this._log = createLogger('NoLagQueue', this._options.debug);

    this._readyPromise = new Promise<void>((resolve, reject) => {
      this._readyResolve = resolve;
      this._readyReject = reject;
    });
    // ready() rejection is only meaningful to callers that await it
    this._readyPromise.catch(() => {});

    registerWrapper(this._client, this._options.appName, 'NoLagQueue');

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

  /** The local worker's info (available after ready) */
  get localWorker(): QueueWorker | null {
    return this._localWorker;
  }

  /** All currently joined queue rooms */
  get queues(): Map<string, QueueRoom> {
    return this._queues;
  }

  // ============ Lifecycle ============

  /**
   * Resolves once the wrapper's first setup completed (identity, lobby and
   * configured queues ready — equivalently, once 'connected' has fired).
   * Rejects only if detach() is called before that. Client auth failures
   * surface via the app's own `await client.connect()`, not here.
   */
  ready(): Promise<void> {
    return this._readyPromise;
  }

  /**
   * Detach from the client: remove every handler this wrapper added,
   * unsubscribe its topics and lobby (when connected), clear state.
   * Terminal and idempotent; never touches the socket. To use the queue
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
    this._client.off('presence:join', this._onPresenceJoinRef);
    this._client.off('presence:leave', this._onPresenceLeaveRef);
    this._client.off('presence:update', this._onPresenceUpdateRef);
    this._client.off('lobbyPresence:join', this._onLobbyJoinRef);
    this._client.off('lobbyPresence:leave', this._onLobbyLeaveRef);
    this._client.off('lobbyPresence:update', this._onLobbyUpdateRef);

    // Queue rooms: handler-specific off + connected-gated server unsubscribe
    for (const name of [...this._queues.keys()]) {
      this._queues.get(name)!._cleanup();
      this._queues.delete(name);
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

    this._onlineWorkers.clear();
    this._actorToWorkerId.clear();
    this._localWorker = null;

    releaseWrapper(this._client, this._options.appName);

    if (!this._isReady) {
      this._readyReject(new Error('NoLagQueue detached before ready'));
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
    if (!this._localWorker) {
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
    } else {
      this._localWorker.actorTokenId = this._client.actorId!;
    }

    // Lobby: subscribe every epoch (idempotent server-side) and diff-hydrate
    // from the returned snapshot — one path for setup and restore.
    if (!this._lobby) {
      this._lobby = this._client.setApp(this._options.appName).setLobby(LOBBY_ID);
    }
    try {
      const state = await this._lobby.subscribe();
      if (stale()) return;
      this._diffHydrateOnlineWorkers(state);
      this._log('Lobby subscribed, online workers:', this._onlineWorkers.size);
    } catch (err) {
      if (stale()) return;
      this._log('Lobby subscription failed:', err);
    }

    if (!this._isReady) {
      // First successful setup: pre-subscribe configured queues.
      for (const queueName of this._options.queues) {
        this._subscribeQueue(queueName);
      }
    } else {
      // Server auto-restored topic subscriptions; only room-scoped presence
      // needs re-applying (the core does not restore it).
      for (const room of this._queues.values()) {
        room._updateLocalPresence();
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

    // Deferred lobby refetch: catches workers who joined during the setup
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
          this._diffHydrateOnlineWorkers(state);
        })
        .catch(() => {
          /* best-effort */
        });
    }, LOBBY_REFRESH_DELAY_MS);
  }

  // ============ Queue Management ============

  /**
   * Join a queue room. Creates, subscribes, and activates it.
   * Returns an existing room if already joined.
   */
  joinQueue(name: string, opts?: JoinQueueOptions): QueueRoom {
    this._assertUsable();

    let room = this._queues.get(name);
    if (!room) {
      room = this._subscribeQueue(name, opts?.filters);
      room._activate();
    } else if (opts?.filters) {
      // Already joined — re-point its filters rather than ignoring them.
      room.setFilters(opts.filters);
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

  // ============ Private: Guards ============

  private _assertUsable(): void {
    if (this._detached) {
      throw new Error('NoLagQueue has been detached — construct a new instance');
    }
    if (!this._isReady || !this._localWorker) {
      throw new Error('NoLagQueue not ready — await ready() or the "connected" event');
    }
  }

  // ============ Private: Queue Setup ============

  private _subscribeQueue(name: string, filters?: FilterValue[]): QueueRoom {
    this._log('Subscribing queue:', name);

    const roomContext = this._client.setApp(this._options.appName).setRoom(name);
    const room = new QueueRoom(
      name,
      roomContext,
      this._workerId,
      this._options,
      createLogger(`QueueRoom:${name}`, this._options.debug),
      () => this._client.connected,
    );

    room._setLocalActorId(this._localWorker!.actorTokenId);

    this._queues.set(name, room);
    room._subscribe(filters);

    return room;
  }

  // ============ Private: Scope Filtering ============

  /**
   * On a shared client, presence events from other apps' wrappers arrive on
   * the same connection-level events. Wrappers stamp their presence with a
   * `__scope` (their appName); a mismatched tag means another app's data.
   * Untagged presence is accepted (older peers in this same app).
   */
  private _foreignScope(data: QueuePresenceData | undefined): boolean {
    const scope = (data as Record<string, unknown> | undefined)?.__scope;
    return typeof scope === 'string' && scope !== this._options.appName;
  }

  // ============ Private: Room Presence ============

  private _handleRoomPresenceJoin(data: ActorPresence): void {
    if (data.actorTokenId === this._localWorker?.actorTokenId) return;
    const presenceData = data.presence as unknown as QueuePresenceData;
    if (!presenceData?.workerId || this._foreignScope(presenceData)) return;

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
    if (!presenceData?.workerId || this._foreignScope(presenceData)) return;

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

  private _handleLobbyJoin(event: LobbyPresenceEvent): void {
    const { actorId, data } = event;
    if (actorId === this._localWorker?.actorTokenId) return;

    const presenceData = data as unknown as QueuePresenceData;
    if (!presenceData?.workerId || this._foreignScope(presenceData)) return;

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
    if (this._foreignScope(presenceData)) return;
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
    if (!presenceData?.workerId || this._foreignScope(presenceData)) return;

    const worker = this._presenceToWorker(actorId, presenceData);
    this._onlineWorkers.set(worker.workerId, worker);
  }

  /**
   * Reconcile the online-worker map against a fresh lobby snapshot, emitting
   * only the deltas (workerOffline for vanished, workerOnline for new). One
   * path for initial hydration, reconnect restore, and the deferred refetch.
   */
  private _diffHydrateOnlineWorkers(state: LobbyPresenceState): void {
    // Build the fresh worker set from the snapshot
    const fresh = new Map<string, QueueWorker>();
    const freshActors = new Map<string, string>();

    for (const roomId of Object.keys(state)) {
      const roomPresence = state[roomId];
      for (const actorId of Object.keys(roomPresence)) {
        if (actorId === this._localWorker?.actorTokenId) continue;

        const raw = roomPresence[actorId] as Record<string, unknown>;
        // Server returns full actor records with presence nested under .presence
        const presenceData = (raw?.presence ?? raw) as unknown as QueuePresenceData;
        if (presenceData?.workerId && !this._foreignScope(presenceData)) {
          if (!fresh.has(presenceData.workerId)) {
            fresh.set(presenceData.workerId, this._presenceToWorker(actorId, presenceData));
          }
          freshActors.set(actorId, presenceData.workerId);
        }
      }
    }

    // Vanished workers
    for (const [workerId, worker] of [...this._onlineWorkers]) {
      if (!fresh.has(workerId)) {
        this._onlineWorkers.delete(workerId);
        for (const [actorId, mappedWorkerId] of [...this._actorToWorkerId]) {
          if (mappedWorkerId === workerId) this._actorToWorkerId.delete(actorId);
        }
        this.emit('workerOffline', worker);
      }
    }

    // New workers
    for (const [workerId, worker] of fresh) {
      if (!this._onlineWorkers.has(workerId)) {
        this._onlineWorkers.set(workerId, worker);
        this.emit('workerOnline', worker);
      }
    }
    for (const [actorId, workerId] of freshActors) {
      this._actorToWorkerId.set(actorId, workerId);
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
}
