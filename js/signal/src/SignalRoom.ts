import type { RoomContext } from '@nolag/js-sdk';
import { EventEmitter } from './EventEmitter';
import { PeerManager } from './PeerManager';
import { generateId } from './utils';
import { TOPIC_SIGNALING } from './constants';
import type {
  SignalRoomEvents,
  SignalMessage,
  SignalType,
  Peer,
  SignalPresenceData,
  ResolvedSignalOptions,
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
  sendOffer(toPeerId: string, offer: RTCSessionDescriptionInit): void {
    this.signal(toPeerId, 'offer', offer);
  }

  /**
   * Send an SDP answer to a specific peer.
   */
  sendAnswer(toPeerId: string, answer: RTCSessionDescriptionInit): void {
    this.signal(toPeerId, 'answer', answer);
  }

  /**
   * Send an ICE candidate to a specific peer.
   */
  sendIceCandidate(toPeerId: string, candidate: RTCIceCandidateInit): void {
    this.signal(toPeerId, 'ice-candidate', candidate);
  }

  /**
   * Send a bye signal to a specific peer (graceful close).
   */
  sendBye(toPeerId: string): void {
    this.signal(toPeerId, 'bye', {});
  }

  /**
   * Send a generic signal message to a specific peer.
   */
  signal(
    toPeerId: string,
    type: SignalType,
    payload: RTCSessionDescriptionInit | RTCIceCandidateInit | Record<string, unknown>,
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

    this._roomContext.emit(TOPIC_SIGNALING, message, { echo: false });
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
  _subscribe(): void {
    this._log('Room subscribe:', this.name);

    this._roomContext.subscribe(TOPIC_SIGNALING);

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
