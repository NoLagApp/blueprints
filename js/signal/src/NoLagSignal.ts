import type {
  LobbyPresenceEvent,
  LobbyPresenceState,
  LobbyContext,
  ActorPresence,
  NoLagSocket,
} from '@nolag/js-sdk';
import { EventEmitter } from './EventEmitter';
import { SignalRoom } from './SignalRoom';
import { generateId, createLogger, registerWrapper, releaseWrapper } from './utils';
import { DEFAULT_APP_NAME, LOBBY_ID, LOBBY_REFRESH_DELAY_MS } from './constants';
import type {
  NoLagSignalOptions,
  ResolvedSignalOptions,
  SignalClientEvents,
  Peer,
  SignalPresenceData,
  FilterValue,
  JoinRoomOptions,
} from './types';

/**
 * NoLagSignal — high-level WebRTC signaling SDK built on @nolag/js-sdk.
 *
 * Provides peer discovery, offer/answer/ICE exchange, and global presence
 * tracking — all framework-agnostic via events.
 *
 * The wrapper NEVER manages the connection. The app owns one core NoLag
 * client (shared by any number of wrappers on distinct apps) and the
 * wrapper attaches to it at construction and releases it via `detach()`.
 *
 * @example
 * ```typescript
 * import { NoLag } from '@nolag/js-sdk';
 * import { NoLagSignal } from '@nolag/signal';
 *
 * const client = NoLag(async () => (await (await fetch('/api/nolag-token')).json()).token);
 * const signal = new NoLagSignal({ client, appName: 'my-signal' });
 *
 * signal.on('peerOnline', (peer) => console.log(peer.peerId, 'is online'));
 *
 * await client.connect();   // the app owns the connection
 * await signal.ready();     // wrapper setup done (identity, lobby)
 *
 * const room = signal.joinRoom('call-room');
 * room.on('signal', (msg) => {
 *   if (msg.type === 'offer') handleOffer(msg);
 * });
 * room.sendOffer(remotePeerId, offer);
 *
 * signal.detach();          // wrapper releases its handlers and topics
 * client.disconnect();      // the app closes the socket
 * ```
 */
export class NoLagSignal extends EventEmitter<SignalClientEvents> {
  private _client: NoLagSocket;
  private _options: ResolvedSignalOptions;
  private _localPeer: Peer | null = null;
  private _rooms = new Map<string, SignalRoom>();
  private _lobby: LobbyContext | null = null;
  private _onlinePeers = new Map<string, Peer>();
  private _actorToPeerId = new Map<string, string>();
  private _peerId: string;
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

  constructor(options: NoLagSignalOptions) {
    super();

    if (!options?.client) {
      throw new TypeError(
        'NoLagSignal requires an injected NoLag client: new NoLagSignal({ client, ... })',
      );
    }

    this._client = options.client;
    this._peerId = generateId();

    this._options = {
      metadata: options.metadata,
      appName: options.appName ?? DEFAULT_APP_NAME,
      debug: options.debug ?? false,
    };

    this._log = createLogger('NoLagSignal', this._options.debug);

    this._readyPromise = new Promise<void>((resolve, reject) => {
      this._readyResolve = resolve;
      this._readyReject = reject;
    });
    // ready() rejection is only meaningful to callers that await it
    this._readyPromise.catch(() => {});

    registerWrapper(this._client, this._options.appName, 'NoLagSignal');

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

  /** The local peer's info (available after ready) */
  get localPeer(): Peer | null {
    return this._localPeer;
  }

  /** All currently joined rooms */
  get rooms(): Map<string, SignalRoom> {
    return this._rooms;
  }

  // ============ Lifecycle ============

  /**
   * Resolves once the wrapper's first setup completed (identity and lobby
   * ready — equivalently, once 'connected' has fired). Rejects only if
   * detach() is called before that. Client auth failures surface via the
   * app's own `await client.connect()`, not here.
   */
  ready(): Promise<void> {
    return this._readyPromise;
  }

  /**
   * Detach from the client: remove every handler this wrapper added,
   * unsubscribe its topics and lobby (when connected), clear state.
   * Terminal and idempotent; never touches the socket. To use signaling
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

    this._onlinePeers.clear();
    this._actorToPeerId.clear();
    this._localPeer = null;

    releaseWrapper(this._client, this._options.appName);

    if (!this._isReady) {
      this._readyReject(new Error('NoLagSignal detached before ready'));
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
    if (!this._localPeer) {
      this._localPeer = {
        peerId: this._peerId,
        actorTokenId: this._client.actorId!,
        connectionState: 'new',
        metadata: this._options.metadata,
        joinedAt: Date.now(),
        isLocal: true,
      };
      this._log('Local peer:', this._localPeer.peerId, '→', this._localPeer.actorTokenId);
    } else {
      this._localPeer.actorTokenId = this._client.actorId!;
    }

    // Lobby: subscribe every epoch (idempotent server-side) and diff-hydrate
    // from the returned snapshot — one path for setup and restore.
    if (!this._lobby) {
      this._lobby = this._client.setApp(this._options.appName).setLobby(LOBBY_ID);
    }
    try {
      const state = await this._lobby.subscribe();
      if (stale()) return;
      this._diffHydrateOnlinePeers(state);
      this._log('Lobby subscribed, online peers:', this._onlinePeers.size);
    } catch (err) {
      if (stale()) return;
      this._log('Lobby subscription failed:', err);
    }

    if (this._isReady) {
      // Server auto-restored topic subscriptions; only room-scoped presence
      // needs re-applying (the core does not restore it).
      for (const room of this._rooms.values()) {
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

    // Deferred lobby refetch: catches peers who joined during the setup
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
          this._diffHydrateOnlinePeers(state);
        })
        .catch(() => {
          /* best-effort */
        });
    }, LOBBY_REFRESH_DELAY_MS);
  }

  // ============ Room Management ============

  /**
   * Join a signaling room. Creates, subscribes, and activates it.
   * Returns an existing room if already joined.
   */
  joinRoom(name: string, opts?: JoinRoomOptions): SignalRoom {
    this._assertUsable();

    let room = this._rooms.get(name);
    if (!room) {
      room = this._subscribeRoom(name, opts?.filters);
      room._activate();
    } else if (opts?.filters) {
      // Already joined — re-point its filters rather than ignoring them.
      room.setFilters(opts.filters);
    }

    return room;
  }

  /**
   * Leave a signaling room. Fully unsubscribes and removes it.
   */
  leaveRoom(name: string): void {
    const room = this._rooms.get(name);
    if (!room) return;

    this._log('Leaving room:', name);
    room._cleanup();
    this._rooms.delete(name);
  }

  /**
   * Get all joined rooms.
   */
  getRooms(): SignalRoom[] {
    return Array.from(this._rooms.values());
  }

  // ============ Global Presence ============

  /**
   * Get all peers currently online across all rooms.
   */
  getOnlinePeers(): Peer[] {
    return Array.from(this._onlinePeers.values());
  }

  // ============ Private: Guards ============

  private _assertUsable(): void {
    if (this._detached) {
      throw new Error('NoLagSignal has been detached — construct a new instance');
    }
    if (!this._isReady || !this._localPeer) {
      throw new Error('NoLagSignal not ready — await ready() or the "connected" event');
    }
  }

  // ============ Private: Room Setup ============

  private _subscribeRoom(name: string, filters?: FilterValue[]): SignalRoom {
    this._log('Subscribing room:', name);

    const roomContext = this._client.setApp(this._options.appName).setRoom(name);
    const room = new SignalRoom(
      name,
      roomContext,
      this._localPeer!,
      this._options,
      createLogger(`SignalRoom:${name}`, this._options.debug),
      () => this._client.connected,
    );

    this._rooms.set(name, room);
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
  private _foreignScope(data: SignalPresenceData | undefined): boolean {
    const scope = (data as Record<string, unknown> | undefined)?.__scope;
    return typeof scope === 'string' && scope !== this._options.appName;
  }

  // ============ Private: Room Presence ============

  private _handleRoomPresenceJoin(data: ActorPresence): void {
    if (data.actorTokenId === this._localPeer?.actorTokenId) return;
    const presenceData = data.presence as unknown as SignalPresenceData;
    if (!presenceData?.peerId || this._foreignScope(presenceData)) return;

    const peer = this._presenceToPeer(data.actorTokenId, presenceData);
    this._actorToPeerId.set(data.actorTokenId, peer.peerId);
    if (!this._onlinePeers.has(peer.peerId)) {
      this._onlinePeers.set(peer.peerId, peer);
      this.emit('peerOnline', peer);
    }

    // Route to all rooms
    for (const room of this._rooms.values()) {
      room._handlePresenceJoin(data.actorTokenId, presenceData);
    }
  }

  private _handleRoomPresenceLeave(data: ActorPresence): void {
    if (data.actorTokenId === this._localPeer?.actorTokenId) return;

    // Route to all rooms
    for (const room of this._rooms.values()) {
      room._handlePresenceLeave(data.actorTokenId);
    }
  }

  private _handleRoomPresenceUpdate(data: ActorPresence): void {
    if (data.actorTokenId === this._localPeer?.actorTokenId) return;
    const presenceData = data.presence as unknown as SignalPresenceData;
    if (!presenceData?.peerId || this._foreignScope(presenceData)) return;

    if (this._onlinePeers.has(presenceData.peerId)) {
      const peer = this._presenceToPeer(data.actorTokenId, presenceData);
      this._onlinePeers.set(peer.peerId, peer);
    }

    // Route to all rooms
    for (const room of this._rooms.values()) {
      room._handlePresenceUpdate(data.actorTokenId, presenceData);
    }
  }

  // ============ Private: Lobby ============

  private _handleLobbyJoin(event: LobbyPresenceEvent): void {
    const { actorId, data } = event;
    if (actorId === this._localPeer?.actorTokenId) return;

    const presenceData = data as unknown as SignalPresenceData;
    if (!presenceData.peerId || this._foreignScope(presenceData)) return;

    const peer = this._presenceToPeer(actorId, presenceData);
    this._actorToPeerId.set(actorId, peer.peerId);
    if (!this._onlinePeers.has(peer.peerId)) {
      this._onlinePeers.set(peer.peerId, peer);
      this.emit('peerOnline', peer);
    }
  }

  private _handleLobbyLeave(event: LobbyPresenceEvent): void {
    const { actorId, data } = event;
    if (actorId === this._localPeer?.actorTokenId) return;

    const presenceData = data as unknown as SignalPresenceData;
    if (this._foreignScope(presenceData)) return;
    const peerId = presenceData?.peerId
      || this._actorToPeerId.get(actorId)
      || this._findPeerIdByActorId(actorId);

    if (peerId) {
      const peer = this._onlinePeers.get(peerId);
      if (peer) {
        this._onlinePeers.delete(peerId);
        this._actorToPeerId.delete(actorId);
        this.emit('peerOffline', peer);
      }
    }
  }

  private _handleLobbyUpdate(event: LobbyPresenceEvent): void {
    const { actorId, data } = event;
    if (actorId === this._localPeer?.actorTokenId) return;

    const presenceData = data as unknown as SignalPresenceData;
    if (!presenceData.peerId || this._foreignScope(presenceData)) return;

    const peer = this._presenceToPeer(actorId, presenceData);
    this._onlinePeers.set(peer.peerId, peer);
  }

  /**
   * Reconcile the online-peer map against a fresh lobby snapshot, emitting
   * only the deltas (peerOffline for vanished, peerOnline for new). One path
   * for initial hydration, reconnect restore, and the deferred refetch.
   */
  private _diffHydrateOnlinePeers(state: LobbyPresenceState): void {
    // Build the fresh peer set from the snapshot
    const fresh = new Map<string, Peer>();
    const freshActors = new Map<string, string>();

    for (const roomId of Object.keys(state)) {
      const roomPresence = state[roomId];
      for (const actorId of Object.keys(roomPresence)) {
        if (actorId === this._localPeer?.actorTokenId) continue;

        const raw = roomPresence[actorId] as Record<string, unknown>;
        // Server returns full actor records with presence nested under .presence
        const presenceData = (raw?.presence ?? raw) as unknown as SignalPresenceData;
        if (presenceData?.peerId && !this._foreignScope(presenceData)) {
          if (!fresh.has(presenceData.peerId)) {
            fresh.set(presenceData.peerId, this._presenceToPeer(actorId, presenceData));
          }
          freshActors.set(actorId, presenceData.peerId);
        }
      }
    }

    // Vanished peers
    for (const [peerId, peer] of [...this._onlinePeers]) {
      if (!fresh.has(peerId)) {
        this._onlinePeers.delete(peerId);
        for (const [actorId, mappedPeerId] of [...this._actorToPeerId]) {
          if (mappedPeerId === peerId) this._actorToPeerId.delete(actorId);
        }
        this.emit('peerOffline', peer);
      }
    }

    // New peers
    for (const [peerId, peer] of fresh) {
      if (!this._onlinePeers.has(peerId)) {
        this._onlinePeers.set(peerId, peer);
        this.emit('peerOnline', peer);
      }
    }
    for (const [actorId, peerId] of freshActors) {
      this._actorToPeerId.set(actorId, peerId);
    }
  }

  // ============ Private: Helpers ============

  private _presenceToPeer(actorTokenId: string, data: SignalPresenceData): Peer {
    return {
      peerId: data.peerId,
      actorTokenId,
      connectionState: 'new',
      metadata: data.metadata,
      joinedAt: Date.now(),
      isLocal: false,
    };
  }

  private _findPeerIdByActorId(actorTokenId: string): string | undefined {
    for (const peer of this._onlinePeers.values()) {
      if (peer.actorTokenId === actorTokenId) return peer.peerId;
    }
    return undefined;
  }
}
