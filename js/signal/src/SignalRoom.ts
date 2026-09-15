import type { RoomContext } from '@nolag/js-sdk';
import { EventEmitter } from './EventEmitter';
import { PeerManager } from './PeerManager';
import { generateId, filterEmitOptions, mergeFilters, withoutFilters } from './utils';
import { TOPIC_SIGNALING } from './constants';
import type {
  SignalRoomEvents,
  SignalMessage,
  SignalType,
  Peer,
  SignalPresenceData,
  ResolvedSignalOptions,
  SignalOptions,
  FilterValue,
} from './types';

/**
 * SignalRoom — a single signaling room for WebRTC peer discovery and exchange.
 *
 * Created via `NoLagSignal.joinRoom(name)`. Do not instantiate directly.
 */
export class SignalRoom extends EventEmitter<SignalRoomEvents> {
  /** Room name */
  readonly name: string;

  private _roomContext: RoomContext;
  private _localPeer: Peer;
  private _options: ResolvedSignalOptions;
  private _peerManager: PeerManager;
  private _log: (...args: unknown[]) => void;
  private _isConnected: () => boolean;

  // Stored topic handler ref — cleanup removes exactly this, never all
  // handlers for a topic (the client may be shared with other consumers).
  private _onSignalingRef: ((data: unknown) => void) | null = null;

  /** Filter values applied to the signaling subscription. */
  private _filters: FilterValue[] = [];

  /** @internal */
  constructor(
    name: string,
    roomContext: RoomContext,
    localPeer: Peer,
    options: ResolvedSignalOptions,
    log: (...args: unknown[]) => void,
    isConnected: () => boolean,
  ) {
    super();
    this.name = name;
    this._roomContext = roomContext;
    this._localPeer = localPeer;
    this._options = options;
    this._log = log;
    this._isConnected = isConnected;

    this._peerManager = new PeerManager(localPeer.actorTokenId);
  }

  // ============ Public Properties ============

  /** All remote peers currently in this room */
  get peers(): Map<string, Peer> {
    return this._peerManager.peers;
  }

  // ============ Signaling ============

  /**
   * Send an SDP offer to a specific peer.
   */
  sendOffer(toPeerId: string, offer: RTCSessionDescriptionInit, opts?: SignalOptions): void {
    this.signal(toPeerId, 'offer', offer, opts);
  }

  /**
   * Send an SDP answer to a specific peer.
   */
  sendAnswer(toPeerId: string, answer: RTCSessionDescriptionInit, opts?: SignalOptions): void {
    this.signal(toPeerId, 'answer', answer, opts);
  }

  /**
   * Send an ICE candidate to a specific peer.
   */
  sendIceCandidate(toPeerId: string, candidate: RTCIceCandidateInit, opts?: SignalOptions): void {
    this.signal(toPeerId, 'ice-candidate', candidate, opts);
  }

  /**
   * Send a bye signal to a specific peer (graceful close).
   */
  sendBye(toPeerId: string, opts?: SignalOptions): void {
    this.signal(toPeerId, 'bye', {}, opts);
  }

  /**
   * Send a generic signal message to a specific peer.
   *
   * By default this broadcasts to the room and peers discard messages not
   * addressed to them. Pass `{ filter: toPeerId }` to have the server do the
   * addressing instead, so the signal is only delivered to that peer.
   */
  signal(
    toPeerId: string,
    type: SignalType,
    payload: RTCSessionDescriptionInit | RTCIceCandidateInit | Record<string, unknown>,
    opts?: SignalOptions,
  ): void {
    const message: SignalMessage = {
      id: generateId(),
      type,
      fromPeerId: this._localPeer.peerId,
      toPeerId,
      payload,
      timestamp: Date.now(),
    };

    this._log('Sending signal:', type, '→', toPeerId);

    this._roomContext.emit(TOPIC_SIGNALING, message, { echo: false, ...filterEmitOptions(opts) });
  }

  // ============ Filters ============

  /** This peer's own id — the value to filter on to receive directed signals. */
  get localPeerId(): string {
    return this._localPeer.peerId;
  }

  /** The filter values currently applied to this room's signaling. */
  get filters(): FilterValue[] {
    return [...this._filters];
  }

  /**
   * Replace this room's signaling filters — only signals published with one of
   * these values are delivered. Set your own peerId to receive only signals
   * addressed to you, and send with `{ filter: toPeerId }` so the server does
   * the addressing rather than every peer discarding other peers' traffic.
   *
   * A filtered peer stops receiving unfiltered room broadcasts, so switch the
   * whole room over together. Passing an empty array restores the wildcard
   * subscription, which receives everything.
   *
   * @example
   * ```ts
   * room.setFilters([room.localPeerId]);  // only signals addressed to me
   * room.setFilters([]);                  // back to room broadcast
   * ```
   */
  setFilters(values: FilterValue[]): void {
    this._filters = [...values];
    // The core types filters as `string[]`, but both its implementation and
    // the wire protocol accept AND groups (nested arrays).
    this._roomContext.setFilters(TOPIC_SIGNALING, this._filters as unknown as string[]);
  }

  /** Add filter values to the existing set. Existing AND groups are kept. */
  addFilters(values: string[]): void {
    this.setFilters(mergeFilters(this._filters, values));
  }

  /**
   * Remove filter values from the existing set. Removing the last value
   * restores the wildcard subscription.
   */
  removeFilters(values: string[]): void {
    this.setFilters(withoutFilters(this._filters, values));
  }

  // ============ Peers ============

  /**
   * Get all remote peers in this room.
   */
  getPeers(): Peer[] {
    return this._peerManager.getAll();
  }

  /**
   * Get a specific peer by peerId.
   */
  getPeer(peerId: string): Peer | undefined {
    return this._peerManager.getPeer(peerId);
  }

  // ============ Internal (called by NoLagSignal) ============

  /** @internal Subscribe to signaling topic and attach listeners */
  _subscribe(filters?: FilterValue[]): void {
    this._log('Room subscribe:', this.name);

    this._filters = filters ? [...filters] : [];

    if (this._filters.length > 0) {
      this._roomContext.subscribe(TOPIC_SIGNALING, { filters: this._filters });
    } else {
      this._roomContext.subscribe(TOPIC_SIGNALING);
    }

    // Listen for signals (ref stored for handler-specific removal)
    this._onSignalingRef = (data: unknown) => {
      this._handleIncomingSignal(data);
    };
    this._roomContext.on(TOPIC_SIGNALING, this._onSignalingRef);
  }

  /** @internal Set presence and fetch room members */
  _activate(): void {
    this._log('Room activate:', this.name);
    this._setPresence();

    this._roomContext.fetchPresence().then((actors) => {
      this._log('Room presence fetched:', this.name, actors.length, 'actors');
      for (const actor of actors) {
        if (actor.presence) {
          const peer = this._peerManager.addFromPresence(
            actor.actorTokenId,
            actor.presence as SignalPresenceData,
            actor.joinedAt,
          );
          if (peer) {
            this.emit('peerJoined', peer);
          }
        }
      }
    }).catch((err) => {
      this._log('Failed to fetch room presence:', err);
    });
  }

  /** @internal Re-set presence after reconnect */
  _updateLocalPresence(): void {
    this._setPresence();
  }

  /** @internal Handle a presence:join event */
  _handlePresenceJoin(actorTokenId: string, presenceData: SignalPresenceData): void {
    const peer = this._peerManager.addFromPresence(actorTokenId, presenceData);
    if (peer) {
      this._log('Peer joined room:', this.name, peer.peerId);
      this.emit('peerJoined', peer);
    }
  }

  /** @internal Handle a presence:leave event */
  _handlePresenceLeave(actorTokenId: string): void {
    const peer = this._peerManager.removeByActorId(actorTokenId);
    if (peer) {
      this._log('Peer left room:', this.name, peer.peerId);
      this.emit('peerLeft', peer);
    }
  }

  /** @internal Handle a presence:update event */
  _handlePresenceUpdate(actorTokenId: string, presenceData: SignalPresenceData): void {
    this._peerManager.addFromPresence(actorTokenId, presenceData);
  }

  /** @internal Unsubscribe and clean up */
  _cleanup(): void {
    this._log('Room cleanup:', this.name);

    // Server unsubscribes need a live socket; skip when disconnected
    // (best-effort — the core would no-op with an error callback anyway).
    if (this._isConnected()) {
      this._roomContext.unsubscribe(TOPIC_SIGNALING);
    }

    // Handler-specific removal only: the client may be shared, and a bare
    // off(topic) would strip other consumers' handlers too.
    if (this._onSignalingRef) this._roomContext.off(TOPIC_SIGNALING, this._onSignalingRef);
    this._onSignalingRef = null;

    this._peerManager.clear();
    this.removeAllListeners();
  }

  // ============ Private ============

  private _handleIncomingSignal(data: unknown): void {
    const message = data as SignalMessage;

    // Only process messages targeted at this peer
    if (message.toPeerId !== this._localPeer.peerId) return;

    this._log('Received signal:', message.type, 'from', message.fromPeerId);
    this.emit('signal', message);
  }

  private _setPresence(): void {
    const presenceData: SignalPresenceData = {
      peerId: this._localPeer.peerId,
      metadata: this._localPeer.metadata,
      // Scope tag: on a shared client, other apps' wrappers filter our
      // presence out by this (and we filter theirs).
      __scope: this._options.appName,
    };
    this._roomContext.setPresence(presenceData);
  }
}
