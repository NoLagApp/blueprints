/**
 * @nolag/signal — Public types
 */

// ============ Options ============

export interface NoLagSignalOptions {
  /** Custom metadata attached to peer presence */
  metadata?: Record<string, unknown>;
  /** NoLag app name (default: 'signal') */
  appName?: string;
  /** WebSocket URL override */
  url?: string;
  /** Enable debug logging (default: false) */
  debug?: boolean;
  /** Auto-reconnect on disconnect (default: true) */
  reconnect?: boolean;
}

/** Resolved options with defaults applied */
export interface ResolvedSignalOptions {
  metadata?: Record<string, unknown>;
  appName: string;
  url?: string;
  debug: boolean;
  reconnect: boolean;
}

// ============ Signal Types ============

export type SignalType = 'offer' | 'answer' | 'ice-candidate' | 'renegotiate' | 'bye';

// ============ Signal Message ============

export interface SignalMessage {
  /** Client-generated unique ID */
  id: string;
  /** Signal type */
  type: SignalType;
  /** Sender's peerId */
  fromPeerId: string;
  /** Recipient's peerId (targeted delivery) */
  toPeerId: string;
  /** Signal payload */
  payload: RTCSessionDescriptionInit | RTCIceCandidateInit | Record<string, unknown>;
  /** Timestamp (ms since epoch) */
  timestamp: number;
}

// ============ Peer ============

export interface Peer {
  /** Stable client-generated peer ID */
  peerId: string;
  /** NoLag internal actor token ID */
  actorTokenId: string;
  /** WebRTC connection state */
  connectionState: 'new' | 'connecting' | 'connected' | 'disconnected';
  /** Custom metadata */
  metadata?: Record<string, unknown>;
  /** Timestamp when the peer joined */
  joinedAt: number;
  /** Whether this is the local peer */
  isLocal: boolean;
}

// ============ Event Maps ============

export interface SignalClientEvents {
  connected: [];
  disconnected: [reason: string];
  reconnected: [];
  error: [error: Error];
  peerOnline: [peer: Peer];
  peerOffline: [peer: Peer];
}

export interface SignalRoomEvents {
  signal: [message: SignalMessage];
  peerJoined: [peer: Peer];
  peerLeft: [peer: Peer];
}

// ============ Presence Payload ============

/** Shape of data stored in NoLag presence for signal peers */
export interface SignalPresenceData {
  [key: string]: unknown;
  peerId: string;
  metadata?: Record<string, unknown>;
}
