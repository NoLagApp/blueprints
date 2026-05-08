/**
 * @nolag/feed — Public types
 */

// ============ Options ============

export interface NoLagFeedOptions {
  /** Display name for this user */
  username: string;
  /** Avatar URL */
  avatar?: string;
  /** Custom metadata attached to user presence */
  metadata?: Record<string, unknown>;
  /** NoLag app name (default: 'feed') */
  appName?: string;
  /** WebSocket URL override */
  url?: string;
  /** Max posts kept in memory per channel (default: 200) */
  maxPostCache?: number;
  /** Max comments kept in memory per post (default: 100) */
  maxCommentCache?: number;
  /** Enable debug logging (default: false) */
  debug?: boolean;
  /** Auto-reconnect on disconnect (default: true) */
  reconnect?: boolean;
  /** List of channels to subscribe to on connect */
  channels?: string[];
}

export interface ResolvedFeedOptions {
  username: string;
  avatar?: string;
  metadata?: Record<string, unknown>;
  appName: string;
  url?: string;
  maxPostCache: number;
  maxCommentCache: number;
  debug: boolean;
  reconnect: boolean;
  channels: string[];
}

// ============ User ============

export interface FeedUser {
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
  /** Timestamp when the user joined */
  joinedAt: number;
  /** Whether this is the local user */
  isLocal: boolean;
}

// ============ Media ============

export type MediaType = 'image' | 'video' | 'link';

export interface MediaAttachment {
  type: MediaType;
  url: string;
  thumbnail?: string;
  title?: string;
}

// ============ Post ============

export interface FeedPost {
  /** Client-generated unique ID */
  id: string;
  /** Author's userId */
  userId: string;
  /** Author's display name */
  username: string;
  /** Author's avatar URL */
  avatar?: string;
  /** Post text content */
  content: string;
  /** Optional media attachments */
  media?: MediaAttachment[];
  /** Optional structured data */
  data?: Record<string, unknown>;
  /** Total like count */
  likeCount: number;
  /** Total comment count */
  commentCount: number;
  /** Whether the local user has liked this post */
  likedByMe: boolean;
  /** Timestamp (ms since epoch) */
  timestamp: number;
  /** Delivery status */
  status: 'sending' | 'sent' | 'delivered';
  /** Whether this post came from replay (history) */
  isReplay: boolean;
}

export interface CreatePostOptions {
  content: string;
  media?: MediaAttachment[];
  data?: Record<string, unknown>;
}

// ============ Comment ============

export interface FeedComment {
  /** Client-generated unique ID */
  id: string;
  /** The post this comment belongs to */
  postId: string;
  /** Author's userId */
  userId: string;
  /** Author's display name */
  username: string;
  /** Author's avatar URL */
  avatar?: string;
  /** Comment text */
  text: string;
  /** Timestamp (ms since epoch) */
  timestamp: number;
  /** Whether this comment came from replay (history) */
  isReplay: boolean;
}

// ============ Reaction ============

export type FeedReactionType = 'like' | 'unlike';

export interface FeedReaction {
  postId: string;
  userId: string;
  type: FeedReactionType;
  timestamp: number;
}

// ============ Presence ============

/** Shape of data stored in NoLag presence for feed users */
export interface FeedPresenceData {
  [key: string]: unknown;
  userId: string;
  username: string;
  avatar?: string;
  metadata?: Record<string, unknown>;
}

// ============ Event Maps ============

export interface FeedClientEvents {
  connected: [];
  disconnected: [reason: string];
  reconnected: [];
  error: [error: Error];
  userOnline: [user: FeedUser];
  userOffline: [user: FeedUser];
}

export interface FeedChannelEvents {
  postCreated: [post: FeedPost];
  postSent: [post: FeedPost];
  postLiked: [data: { postId: string; userId: string; likeCount: number }];
  postUnliked: [data: { postId: string; userId: string; likeCount: number }];
  commentAdded: [comment: FeedComment];
  commentSent: [comment: FeedComment];
  subscriberJoined: [user: FeedUser];
  subscriberLeft: [user: FeedUser];
  replayStart: [data: { count: number }];
  replayEnd: [data: { replayed: number }];
  unreadChanged: [data: { channel: string; count: number }];
}
