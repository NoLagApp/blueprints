import type {
  NoLagOptions,
  LobbyPresenceEvent,
  LobbyPresenceState,
  LobbyContext,
  ActorPresence,
} from '@nolag/js-sdk';
import { NoLag } from '@nolag/js-sdk';
import { EventEmitter } from './EventEmitter';
import { SignalRoom } from './SignalRoom';
import { generateId, createLogger } from './utils';
import { DEFAULT_APP_NAME, LOBBY_ID } from './constants';
import type {
  NoLagSignalOptions,
  ResolvedSignalOptions,
  SignalClientEvents,
  Peer,
  SignalPresenceData,
} from './types';

// The NoLag factory returns a client instance. We type it loosely
// because the actual class isn't exported (only the factory is).
type NoLagClient = ReturnType<typeof NoLag>;

/**
 * NoLagSignal — high-level WebRTC signaling SDK built on @nolag/js-sdk.
 *
 * Provides peer discovery, offer/answer/ICE exchange, and global presence
 * tracking — all framework-agnostic via events.
 *
 * @example
 * ```typescript
 * import { NoLagSignal } from '@nolag/signal';
 *
 * const signal = new NoLagSignal(token, { debug: true });
 *
 * signal.on('connected', () => console.log('Connected!'));
 * signal.on('peerOnline', (peer) => console.log(peer.peerId, 'is online'));
 *
 * await signal.connect();
 *
 * const room = signal.joinRoom('call-room');
 * room.on('signal', (msg) => {
 *   if (msg.type === 'offer') handleOffer(msg);
 * });
 * room.sendOffer(remotePeerId, offer);
 * ```
 */
export class NoLagSignal extends EventEmitter<SignalClientEvents> {
  private _token: string;
  private _options: ResolvedSignalOptions;
  private _client: NoLagClient | null = null;
  private _localPeer: Peer | null = null;
  private _rooms = new Map<string, SignalRoom>();
  private _lobby: LobbyContext | null = null;
  private _onlinePeers = new Map<string, Peer>();
  private _actorToPeerId = new Map<string, string>();
  private _peerId: string;
  private _log: (...args: unknown[]) => void;

  constructor(token: string, options: NoLagSignalOptions = {}) {
    super();
    this._token = token;
    this._peerId = generateId();

    this._options = {
      metadata: options.metadata,
      appName: options.appName ?? DEFAULT_APP_NAME,
      url: options.url,
      debug: options.debug ?? false,
      reconnect: options.reconnect ?? true,
    };

    this._log = createLogger('NoLagSignal', this._options.debug);
  }

  // ============ Public Properties ============

  /** Whether the underlying connection is established */
  get connected(): boolean {
    return this._client?.connected ?? false;
  }

  /** The local peer's info (available after connect) */
  get localPeer(): Peer | null {
    return this._localPeer;
  }

  /** All currently joined rooms */
  get rooms(): Map<string, SignalRoom> {
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
    this._client.on('connect', () => {
      this._log('Connected');
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

    // Create local peer
    this._localPeer = {
      peerId: this._peerId,
      actorTokenId: this._client.actorId!,
      connectionState: 'new',
      metadata: this._options.metadata,
      joinedAt: Date.now(),
      isLocal: true,
    };

    this._log('Local peer:', this._localPeer.peerId, '→', this._localPeer.actorTokenId);

    // Set up lobby for global presence
    await this._setupLobby();

    // Emit connected now that _localPeer and lobby are ready
    this.emit('connected');

    // Deferred lobby refetch to catch peers who joined during the setup window
    setTimeout(() => {
      if (this._lobby && this._client?.connected) {
        this._lobby.fetchPresence().then((state) => {
          this._hydrateOnlinePeers(state);
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
    this._onlinePeers.clear();
    this._actorToPeerId.clear();
    this._localPeer = null;
  }

  // ============ Room Management ============

  /**
   * Join a signaling room. Creates, subscribes, and activates it.
   * Returns an existing room if already joined.
   */
  joinRoom(name: string): SignalRoom {
    if (!this._client || !this._localPeer) {
      throw new Error('Not connected — call connect() first');
    }

    let room = this._rooms.get(name);
    if (!room) {
      room = this._subscribeRoom(name);
      room._activate();
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

  // ============ Private: Room Setup ============

  private _subscribeRoom(name: string): SignalRoom {
    if (!this._client || !this._localPeer) {
      throw new Error('Not connected — call connect() first');
    }

    this._log('Subscribing room:', name);

    const roomContext = this._client.setApp(this._options.appName).setRoom(name);
    const room = new SignalRoom(
      name,
      roomContext,
      this._localPeer,
      this._options,
      createLogger(`SignalRoom:${name}`, this._options.debug),
    );

    this._rooms.set(name, room);
    room._subscribe();

    return room;
  }

  // ============ Private: Room Presence ============

  private _handleRoomPresenceJoin(data: ActorPresence): void {
    if (data.actorTokenId === this._localPeer?.actorTokenId) return;
    const presenceData = data.presence as unknown as SignalPresenceData;
    if (!presenceData?.peerId) return;

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
    if (!presenceData?.peerId) return;

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
      this._hydrateOnlinePeers(initialState);
      this._log('Lobby subscribed, online peers:', this._onlinePeers.size);
    } catch (err) {
      this._log('Lobby subscription failed:', err);
    }
  }

  private _handleLobbyJoin(event: LobbyPresenceEvent): void {
    const { actorId, data } = event;
    if (actorId === this._localPeer?.actorTokenId) return;

    const presenceData = data as unknown as SignalPresenceData;
    if (!presenceData.peerId) return;

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
    if (!presenceData.peerId) return;

    const peer = this._presenceToPeer(actorId, presenceData);
    this._onlinePeers.set(peer.peerId, peer);
  }

  private _hydrateOnlinePeers(state: LobbyPresenceState): void {
    for (const roomId of Object.keys(state)) {
      const roomPresence = state[roomId];
      for (const actorId of Object.keys(roomPresence)) {
        if (actorId === this._localPeer?.actorTokenId) continue;

        const raw = roomPresence[actorId] as Record<string, unknown>;
        const presenceData = (raw?.presence ?? raw) as unknown as SignalPresenceData;
        if (presenceData?.peerId) {
          const peer = this._presenceToPeer(actorId, presenceData);
          this._actorToPeerId.set(actorId, peer.peerId);
          if (!this._onlinePeers.has(peer.peerId)) {
            this._onlinePeers.set(peer.peerId, peer);
            this.emit('peerOnline', peer);
          }
        }
      }
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

  private _restoreRooms(): void {
    // On reconnect, js-sdk auto-restores subscriptions.
    // Re-set presence on all active rooms.
    for (const room of this._rooms.values()) {
      room._updateLocalPresence();
    }

    // Re-fetch lobby presence
    this._lobby?.fetchPresence().then((state) => {
      this._onlinePeers.clear();
      this._actorToPeerId.clear();
      this._hydrateOnlinePeers(state);
    }).catch((err) => {
      this._log('Failed to re-fetch lobby presence:', err);
    });
  }
}
