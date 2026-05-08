/**
 * @nolag/collab — Public types
 */

// ============ Primitives ============

export type OperationType = 'insert' | 'delete' | 'replace' | 'format' | 'custom';

export type UserStatus = 'active' | 'idle' | 'viewing';

// ============ Options ============

export interface NoLagCollabOptions {
  /** Display name for the local user */
  username: string;
  /** Optional avatar URL */
  avatar?: string;
  /** Optional cursor/highlight colour */
  color?: string;
  /** Custom metadata attached to user presence */
  metadata?: Record<string, unknown>;
  /** NoLag app name (default: 'collab') */
  appName?: string;
  /** WebSocket URL override */
  url?: string;
  /** Maximum number of operations to cache per document (default: 1000) */
  maxOperationCache?: number;
  /** Milliseconds of inactivity before a user is marked idle (default: 60000) */
  idleTimeout?: number;
  /** Minimum ms between cursor broadcast messages (default: 50) */
  cursorThrottle?: number;
  /** Enable debug logging (default: false) */
  debug?: boolean;
  /** Auto-reconnect on disconnect (default: true) */
  reconnect?: boolean;
  /** Document names to auto-join on connect */
  documents?: string[];
}

/** Resolved options with defaults applied */
export interface ResolvedCollabOptions {
  username: string;
  avatar?: string;
  color?: string;
  metadata?: Record<string, unknown>;
  appName: string;
  url?: string;
  maxOperationCache: number;
  idleTimeout: number;
  cursorThrottle: number;
  debug: boolean;
  reconnect: boolean;
  documents: string[];
}

// ============ Operations ============

export interface CollabOperation {
  /** Client-generated unique ID */
  id: string;
  /** Operation type */
  type: OperationType;
  /** File/resource path this operation targets */
  path?: string;
  /** Character or element offset */
  position?: number;
  /** Number of characters or elements affected */
  length?: number;
  /** Inserted or replacement content */
  content?: string;
  /** Arbitrary operation payload for custom types */
  data?: Record<string, unknown>;
  /** Sender's userId */
  userId: string;
  /** Sender's display name */
  username: string;
  /** Timestamp (ms since epoch) */
  timestamp: number;
  /** Whether this operation was replayed from cache */
  isReplay: boolean;
}

export interface SendOperationOptions {
  /** File/resource path this operation targets */
  path?: string;
  /** Character or element offset */
  position?: number;
  /** Number of characters or elements affected */
  length?: number;
  /** Inserted or replacement content */
  content?: string;
  /** Arbitrary operation payload for custom types */
  data?: Record<string, unknown>;
}

// ============ Cursors ============

export interface CursorPosition {
  /** User ID of the cursor owner */
  userId: string;
  /** Display name of the cursor owner */
  username: string;
  /** Optional cursor colour */
  color?: string;
  /** Pixel X coordinate (for canvas/freeform) */
  x?: number;
  /** Pixel Y coordinate (for canvas/freeform) */
  y?: number;
  /** Line number (for code/text editors) */
  line?: number;
  /** Column number (for code/text editors) */
  column?: number;
  /** Text selection range */
  selection?: { start: number; end: number };
  /** File/resource path the cursor is in */
  path?: string;
  /** Timestamp of last update (ms since epoch) */
  timestamp: number;
}

export interface CursorUpdateOptions {
  /** Pixel X coordinate */
  x?: number;
  /** Pixel Y coordinate */
  y?: number;
  /** Line number */
  line?: number;
  /** Column number */
  column?: number;
  /** Text selection range */
  selection?: { start: number; end: number };
  /** File/resource path */
  path?: string;
}

// ============ Users ============

export interface CollabUser {
  /** Stable client-generated user ID */
  userId: string;
  /** NoLag internal actor token ID */
  actorTokenId: string;
  /** Display name */
  username: string;
  /** Optional avatar URL */
  avatar?: string;
  /** Optional cursor/highlight colour */
  color?: string;
  /** Current activity status */
  status: UserStatus;
  /** Custom metadata */
  metadata?: Record<string, unknown>;
  /** Timestamp when the user joined */
  joinedAt: number;
  /** Whether this is the local user */
  isLocal: boolean;
}

// ============ Presence Payload ============

/** Shape of data stored in NoLag presence for collab users */
export interface CollabPresenceData {
  [key: string]: unknown;
  userId: string;
  username: string;
  avatar?: string;
  color?: string;
  status: UserStatus;
  metadata?: Record<string, unknown>;
}

// ============ Event Maps ============

export interface CollabClientEvents {
  connected: [];
  disconnected: [reason: string];
  reconnected: [];
  error: [error: Error];
  userOnline: [user: CollabUser];
  userOffline: [user: CollabUser];
}

export interface CollabDocumentEvents {
  operation: [op: CollabOperation];
  cursorMoved: [cursor: CursorPosition];
  userJoined: [user: CollabUser];
  userLeft: [user: CollabUser];
  awarenessChanged: [change: { userId: string; status: UserStatus }];
  replayStart: [info: { count: number }];
  replayEnd: [info: { replayed: number }];
}
