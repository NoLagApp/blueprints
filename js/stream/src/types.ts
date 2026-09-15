import type { NoLagSocket } from '@nolag/js-sdk';

export type ViewerRole = 'viewer' | 'moderator' | 'host';

export interface NoLagStreamOptions {
  /**
   * The injected NoLag core client. The app owns its lifecycle: create it
   * with `NoLag(tokenOrProvider)`, call `connect()`/`disconnect()` yourself.
   * The wrapper only attaches protocol behavior on top and releases it
   * again via `detach()`. One wrapper per (client, appName).
   */
  client: NoLagSocket;
  username: string;
  avatar?: string;
  role?: ViewerRole;
  metadata?: Record<string, unknown>;
  appName?: string;
  maxCommentCache?: number;
  reactionWindow?: number;
  debug?: boolean;
  streams?: string[];
}

export interface ResolvedStreamOptions {
  username: string;
  avatar?: string;
  role: ViewerRole;
  metadata?: Record<string, unknown>;
  appName: string;
  maxCommentCache: number;
  reactionWindow: number;
  debug: boolean;
  streams: string[];
}

export interface StreamViewer {
  viewerId: string;
  actorTokenId: string;
  username: string;
  avatar?: string;
  role: ViewerRole;
  metadata?: Record<string, unknown>;
  joinedAt: number;
  isLocal: boolean;
}

export interface StreamComment {
  id: string;
  viewerId: string;
  username: string;
  avatar?: string;
  text: string;
  data?: Record<string, unknown>;
  timestamp: number;
  status: 'sending' | 'sent' | 'delivered';
  isReplay: boolean;
}

export interface SendCommentOptions {
  data?: Record<string, unknown>;
  /**
   * Route this comment to viewers filtering on this value — a language, a
   * moderator channel, a ticket tier. Unfiltered viewers still receive it.
   */
  filter?: string;
  /**
   * AND composite filter — reaches only viewers filtering on all of these
   * values together. Ignored when `filter` is also set.
   */
  filters?: string[];
}

export interface ReactionBurst {
  emoji: string;
  count: number;
  windowStart: number;
  windowEnd: number;
}

export interface PollOption {
  text: string;
  votes: number;
}

export interface Poll {
  id: string;
  question: string;
  options: PollOption[];
  createdBy: string;
  closed: boolean;
  totalVotes: number;
  timestamp: number;
}

export interface PollVote {
  pollId: string;
  optionIndex: number;
  viewerId: string;
}

export interface CreatePollOptions {
  question: string;
  options: string[];
  /**
   * Route this poll to viewers filtering on this value. Votes and the close
   * event inherit it, so the whole poll stays with one audience.
   */
  filter?: string;
  /**
   * AND composite filter — reaches only viewers filtering on all of these
   * values together. Ignored when `filter` is also set.
   */
  filters?: string[];
}

/** The content topics a stream room can filter independently. */
export type StreamFilterTopic = 'comments' | 'polls';

/** Scope a filter call to one topic instead of both. */
export interface StreamFilterOptions {
  /** Which topic to filter. Omit to apply the call to comments and polls. */
  topic?: StreamFilterTopic;
}

/** Options for `NoLagStream.joinStream()`. */
export interface JoinStreamOptions {
  /**
   * Only receive comments and polls published with one of these filter
   * values. Reactions are unaffected — they are ephemeral and stream-wide.
   *
   * Omit (or pass an empty array) to receive everything.
   */
  filters?: FilterValue[];
}

export interface StreamPresenceData {
  [key: string]: unknown;
  viewerId: string;
  username: string;
  avatar?: string;
  role: ViewerRole;
  metadata?: Record<string, unknown>;
}

export interface StreamClientEvents {
  connected: [];
  disconnected: [reason: string];
  reconnecting: [];
  reconnected: [];
  error: [error: Error];
  viewerOnline: [viewer: StreamViewer];
  viewerOffline: [viewer: StreamViewer];
  viewerCountChanged: [count: number];
}

export interface StreamRoomEvents {
  comment: [comment: StreamComment];
  commentSent: [comment: StreamComment];
  reaction: [burst: ReactionBurst];
  pollCreated: [poll: Poll];
  pollUpdated: [poll: Poll];
  pollClosed: [poll: Poll];
  viewerJoined: [viewer: StreamViewer];
  viewerLeft: [viewer: StreamViewer];
  viewerCountChanged: [count: number];
  replayStart: [data: { count: number }];
  replayEnd: [data: { replayed: number }];
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
