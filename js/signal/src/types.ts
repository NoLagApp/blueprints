/**
 * @nolag/signal — Public types
 */

import type { NoLagSocket } from '@nolag/js-sdk';

// ============ Options ============

export interface NoLagSignalOptions {
  /**
   * The injected NoLag core client. The app owns its lifecycle: create it
   * with `NoLag(tokenOrProvider)`, call `connect()`/`disconnect()` yourself.
   * The wrapper only attaches protocol behavior on top and releases it
   * again via `detach()`. One wrapper per (client, appName).
   */
  client: NoLagSocket;
  /** Custom metadata attached to peer presence */
  metadata?: Record<string, unknown>;
  /** NoLag app name (default: 'signal') */
  appName?: string;
  /** Enable debug logging for the wrapper (default: false) */
  debug?: boolean;
}

/** Resolved options with defaults applied */
export interface ResolvedSignalOptions {
  metadata?: Record<string, unknown>;
  appName: string;
  debug: boolean;
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
  reconnecting: [];
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


/** Publish-side filter options for a signaling message. */
export interface SignalOptions {
  /**
   * Route this signal to peers filtering on this value — normally the
   * recipient's peerId, which turns the room broadcast into a direct send.
   *
   * Peers subscribed without filters still receive it, so this is safe to
   * adopt one peer at a time.
   */
  filter?: string;
  /**
   * AND composite filter — reaches only peers filtering on all of these
   * values together. Ignored when `filter` is also set.
   */
  filters?: string[];
}

/** Options for `NoLagSignal.joinRoom()`. */
export interface JoinRoomOptions {
  /**
   * Only receive signals published with one of these filter values. Join with
   * your own peerId to receive only signals addressed to you.
   *
   * Note this is exclusive: a filtered peer no longer receives the room-wide
   * broadcasts that unfiltered peers send. Adopt it on every peer at once, or
   * not at all.
   */
  filters?: FilterValue[];
}

// ============ Filters ============

/**
 * A single subscription filter value.
 *
 * A plain string is an OR term: `['alice', 'bob']` matches either. A nested
 * array is an AND group: `[['alice', 'admin']]` matches only what was
 * published tagged with both.
 */
export type FilterValue = string | string[];
