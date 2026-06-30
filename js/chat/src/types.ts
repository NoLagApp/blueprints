/**
 * @nolag/chat — Public types
 */

// ============ Options ============

export interface NoLagChatOptions {
  /** Display name for this user */
  username: string;
  /** Avatar URL */
  avatar?: string;
  /** Custom metadata attached to user presence */
  metadata?: Record<string, unknown>;
  /** NoLag app name (default: 'chat') */
  appName?: string;
  /** WebSocket URL override */
  url?: string;
  /** Typing indicator auto-stop timeout in ms (default: 3000) */
  typingTimeout?: number;
  /** Max messages kept in memory per room (default: 500) */
  maxMessageCache?: number;
  /** Enable debug logging (default: false) */
  debug?: boolean;
  /** Auto-reconnect on disconnect (default: true) */
  reconnect?: boolean;
  /** List of rooms to subscribe to on connect (messages received in all; presence only in active room) */
  rooms?: string[];
}

// ============ User ============

export interface ChatUser {
  /** Stable client-generated user ID */
  userId: string;
  /** NoLag internal actor token ID */
  actorTokenId: string;
  /** Display name */
  username: string;
  /** Avatar URL */
  avatar?: string;
  /** Custom metadata */
  metadata?: Record<string, unknown>;
  /** Online status */
  status: 'online' | 'away' | 'busy' | 'offline';
  /** Timestamp when the user joined */
  joinedAt: number;
  /** Whether this is the local user */
  isLocal: boolean;
}

// ============ Message ============

export interface ChatMessage {
  /** Client-generated unique ID */
  id: string;
  /** Sender's userId */
  userId: string;
  /** Sender's display name */
  username: string;
  /** Sender's avatar URL */
  avatar?: string;
  /** Message text */
  text: string;
  /** Optional structured data */
  data?: Record<string, unknown>;
  /** Timestamp (ms since epoch) */
  timestamp: number;
  /**
   * Delivery status. `streaming` = an in-progress streamed message whose `text`
   * is still growing; it becomes `delivered`/`sent` when finalized, or `aborted`
   * if the stream was cancelled.
   */
  status: 'sending' | 'sent' | 'delivered' | 'streaming' | 'aborted';
  /** Whether this message came from replay (history) */
  isReplay: boolean;
}

// ============ Send Options ============

export interface SendMessageOptions {
  /** Optional structured data to attach */
  data?: Record<string, unknown>;
}

// ============ Streaming ============

export interface StreamMessageOptions {
  /** Optional structured data to attach to the final message */
  data?: Record<string, unknown>;
  /**
   * Coalesce appended tokens and publish a network delta at most this often (ms).
   * Lower = smoother but more messages; higher = fewer/larger chunks.
   * Default 60. The local message text updates immediately regardless.
   */
  flushIntervalMs?: number;
}

/**
 * Handle for an in-progress outgoing streamed message — e.g. an AI response
 * generated token-by-token. Append tokens as they arrive, then `complete()` to
 * finalize + persist, or `abort()` to cancel.
 */
export interface MessageStream {
  /** The optimistic streaming message; its `text` grows as you append. */
  readonly message: ChatMessage;
  /** Append a token/chunk; updates the message and (throttled) broadcasts a delta. */
  append(text: string): void;
  /** Finalize: flush, publish the persisted message, emit `streamEnd`. Returns the message. */
  complete(): ChatMessage;
  /** Cancel the stream; broadcasts an abort and does NOT persist a message. */
  abort(error?: string): void;
}

// ============ Event Maps ============

export interface ChatClientEvents {
  connected: [];
  disconnected: [reason: string];
  reconnected: [];
  error: [error: Error];
  userOnline: [user: ChatUser];
  userOffline: [user: ChatUser];
  userUpdated: [user: ChatUser];
}

export interface ChatRoomEvents {
  message: [message: ChatMessage];
  messageSent: [message: ChatMessage];
  userJoined: [user: ChatUser];
  userLeft: [user: ChatUser];
  typing: [data: { users: ChatUser[] }];
  replayStart: [data: { count: number }];
  replayEnd: [data: { replayed: number }];
  unreadChanged: [data: { room: string; count: number }];
  /** A streamed message started (placeholder, status 'streaming') */
  streamStart: [message: ChatMessage];
  /** A streamed message grew by `delta` (message.text already updated) */
  streamChunk: [data: { message: ChatMessage; delta: string }];
  /** A streamed message finished (status 'delivered'/'sent', final text) */
  streamEnd: [message: ChatMessage];
  /** A streamed message was cancelled (status 'aborted') */
  streamAbort: [data: { message: ChatMessage; error?: string }];
}

// ============ Presence Payload ============

/** Shape of data stored in NoLag presence for chat users */
export interface ChatPresenceData {
  [key: string]: unknown;
  userId: string;
  username: string;
  avatar?: string;
  status: 'online' | 'away' | 'busy' | 'offline';
  metadata?: Record<string, unknown>;
}

// ============ Internal ============

/** Resolved options with defaults applied */
export interface ResolvedChatOptions {
  username: string;
  avatar?: string;
  metadata?: Record<string, unknown>;
  appName: string;
  url?: string;
  typingTimeout: number;
  maxMessageCache: number;
  debug: boolean;
  reconnect: boolean;
  rooms: string[];
}
