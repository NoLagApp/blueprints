/**
 * @nolag/notify — Public types
 */

import type { NoLagSocket } from '@nolag/js-sdk';

// ============ Options ============

export interface NoLagNotifyOptions {
  /**
   * The injected NoLag core client. The app owns its lifecycle: create it
   * with `NoLag(tokenOrProvider)`, call `connect()`/`disconnect()` yourself.
   * The wrapper only attaches protocol behavior on top and releases it
   * again via `detach()`. One wrapper per (client, appName).
   */
  client: NoLagSocket;
  /** Custom metadata attached to user presence */
  metadata?: Record<string, unknown>;
  /** NoLag app name (default: 'notify') */
  appName?: string;
  /** Max notifications kept in memory per channel (default: 500) */
  maxNotificationCache?: number;
  /** Enable debug logging (default: false) */
  debug?: boolean;
  /** List of channels to subscribe to on connect */
  channels?: string[];
}

export interface ResolvedNotifyOptions {
  metadata?: Record<string, unknown>;
  appName: string;
  maxNotificationCache: number;
  debug: boolean;
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
  reconnecting: [];
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
