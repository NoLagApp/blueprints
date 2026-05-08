export type ViewerRole = 'viewer' | 'moderator' | 'host';

export interface NoLagStreamOptions {
  username: string;
  avatar?: string;
  role?: ViewerRole;
  metadata?: Record<string, unknown>;
  appName?: string;
  url?: string;
  maxCommentCache?: number;
  reactionWindow?: number;
  debug?: boolean;
  reconnect?: boolean;
  streams?: string[];
}

export interface ResolvedStreamOptions {
  username: string;
  avatar?: string;
  role: ViewerRole;
  metadata?: Record<string, unknown>;
  appName: string;
  url?: string;
  maxCommentCache: number;
  reactionWindow: number;
  debug: boolean;
  reconnect: boolean;
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
