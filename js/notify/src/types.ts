/**
 * @nolag/notify — Public types
 */

// ============ Options ============

export interface NoLagNotifyOptions {
  /** Custom metadata attached to user presence */
  metadata?: Record<string, unknown>;
  /** NoLag app name (default: 'notify') */
  appName?: string;
  /** WebSocket URL override */
  url?: string;
  /** Max notifications kept in memory per channel (default: 500) */
  maxNotificationCache?: number;
  /** Enable debug logging (default: false) */
  debug?: boolean;
  /** Auto-reconnect on disconnect (default: true) */
  reconnect?: boolean;
  /** List of channels to subscribe to on connect */
  channels?: string[];
}

export interface ResolvedNotifyOptions {
  metadata?: Record<string, unknown>;
  appName: string;
  url?: string;
  maxNotificationCache: number;
  debug: boolean;
  reconnect: boolean;
  channels: string[];
}

// ============ Notification ============

export interface Notification {
  /** Client-generated unique ID */
  id: string;
  /** Channel this notification belongs to */
  channel: string;
  /** Notification title */
  title: string;
  /** Optional body text */
  body?: string;
  /** Optional icon URL */
  icon?: string;
  /** Optional structured data */
  data?: Record<string, unknown>;
  /** Timestamp (ms since epoch) */
  timestamp: number;
  /** Whether this notification has been read */
  read: boolean;
  /** Whether this notification came from replay (history) */
  isReplay: boolean;
}

export interface SendNotificationOptions {
  /** Optional body text */
  body?: string;
  /** Optional icon URL */
  icon?: string;
  /** Optional structured data */
  data?: Record<string, unknown>;
}

// ============ Badge ============

export interface BadgeCounts {
  /** Total unread across all channels */
  total: number;
  /** Unread count broken down by channel */
  byChannel: Record<string, number>;
}

// ============ Presence ============

/** Shape of data stored in NoLag presence for notify users */
export interface NotifyPresenceData {
  [key: string]: unknown;
  userId: string;
  metadata?: Record<string, unknown>;
}

// ============ Event Maps ============

export interface NotifyClientEvents {
  connected: [];
  disconnected: [reason: string];
  reconnected: [];
  error: [error: Error];
  notification: [notification: Notification];
  badgeUpdated: [counts: BadgeCounts];
}

export interface NotifyChannelEvents {
  notification: [notification: Notification];
  read: [id: string];
  readAll: [];
  replayStart: [data: { count: number }];
  replayEnd: [data: { replayed: number }];
}
