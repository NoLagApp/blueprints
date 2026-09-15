/**
 * @nolag/feed — Public types
 */

import type { NoLagSocket } from '@nolag/js-sdk';

// ============ Options ============

export interface NoLagFeedOptions {
  /**
   * The injected NoLag core client. The app owns its lifecycle: create it
   * with `NoLag(tokenOrProvider)`, call `connect()`/`disconnect()` yourself.
   * The wrapper only attaches protocol behavior on top and releases it
   * again via `detach()`. One wrapper per (client, appName).
   */
  client: NoLagSocket;
  /** Display name for this user */
  username: string;
  /** Avatar URL */
  avatar?: string;
  /** Custom metadata attached to user presence */
  metadata?: Record<string, unknown>;
  /** NoLag app name (default: 'feed') */
  appName?: string;
  /** Max posts kept in memory per channel (default: 200) */
  maxPostCache?: number;
  /** Max comments kept in memory per post (default: 100) */
  maxCommentCache?: number;
  /** Enable debug logging (default: false) */
  debug?: boolean;
  /** List of channels to subscribe to on connect (posts received in all; presence only in active channel) */
  channels?: string[];
}

export interface ResolvedFeedOptions {
  username: string;
  avatar?: string;
  metadata?: Record<string, unknown>;
  appName: string;
  maxPostCache: number;
  maxCommentCache: number;
  debug: boolean;
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
  /**
   * The filter value this post was published with, if any. Likes and comments
   * on the post are published with the same value so they reach the same
   * audience.
   */
  filter?: string;
  /** Delivery status */
  status: 'sending' | 'sent' | 'delivered';
  /** Whether this post came from replay (history) */
  isReplay: boolean;
}

export interface CreatePostOptions {
  content: string;
  media?: MediaAttachment[];
  data?: Record<string, unknown>;
  /**
   * Route this post to subscribers filtering on this value — e.g. a topic or
   * audience segment. Unfiltered (wildcard) subscribers still receive it.
   *
   * Likes and comments on the post automatically inherit this filter, so a
   * filtered post's reactions never reach an audience that cannot see it.
   */
  filter?: string;
  /**
   * AND composite filter — reaches only subscribers filtering on all of
   * these values together. Ignored when `filter` is also set.
   */
  filters?: string[];
}

/** The content topics a feed channel can filter independently. */
export type FeedFilterTopic = 'posts' | 'reactions' | 'comments';

/** Scope a filter call to one topic instead of all of them. */
export interface FeedFilterOptions {
  /**
   * Which topic to filter. Omit to apply the call to all three, which is
   * almost always what you want — filtering posts alone would still deliver
   * likes and comments for posts you cannot see.
   */
  topic?: FeedFilterTopic;
}

/** Options for `NoLagFeed.joinChannel()`. */
export interface JoinChannelOptions {
  /**
   * Only receive posts published with one of these filter values. Applies to
   * the channel's reactions and comments too, so the three stay in step.
   * Omit (or pass an empty array) to receive everything.
   */
  filters?: FilterValue[];
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
  reconnecting: [];
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


// ============ Filters ============

/**
 * A single subscription filter value.
 *
 * A plain string is an OR term: `['alice', 'bob']` matches either. A nested
 * array is an AND group: `[['alice', 'admin']]` matches only what was
 * published tagged with both.
 */
export type FilterValue = string | string[];
