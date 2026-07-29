import type { RoomContext, MessageMeta } from '@nolag/js-sdk';
import { EventEmitter } from './EventEmitter';
import { PostStore } from './PostStore';
import { ReactionManager } from './ReactionManager';
import { PresenceManager } from './PresenceManager';
import { generateId } from './utils';
import { TOPIC_POSTS, TOPIC_REACTIONS, TOPIC_COMMENTS } from './constants';
import type {
  FeedChannelEvents, FeedPost, FeedComment, FeedUser,
  FeedPresenceData, ResolvedFeedOptions, CreatePostOptions,
} from './types';

/**
 * FeedChannel — a single feed channel with posts, comments, reactions, and
 * presence.
 *
 * Created via `NoLagFeed.joinChannel(name)`. Do not instantiate directly.
 */
export class FeedChannel extends EventEmitter<FeedChannelEvents> {
  readonly name: string;

  private _roomContext: RoomContext;
  private _localUser: FeedUser;
  private _options: ResolvedFeedOptions;
  private _presenceManager: PresenceManager;
  private _postStore: PostStore;
  private _reactionManager: ReactionManager;
  private _comments = new Map<string, FeedComment[]>();
  private _log: (...args: unknown[]) => void;
  private _isConnected: () => boolean;
  private _unreadCount = 0;
  private _active = false;

  // Stored topic handler refs — cleanup removes exactly these, never all
  // handlers for a topic (the client may be shared with other consumers).
  private _onPostsRef: ((data: unknown, meta: MessageMeta) => void) | null = null;
  private _onReactionsRef: ((data: unknown) => void) | null = null;
  private _onCommentsRef: ((data: unknown, meta: MessageMeta) => void) | null = null;

  /** @internal */
  constructor(
    name: string, roomContext: RoomContext, localUser: FeedUser,
    options: ResolvedFeedOptions, log: (...args: unknown[]) => void,
    isConnected: () => boolean,
  ) {
    super();
    this.name = name;
    this._roomContext = roomContext;
    this._localUser = localUser;
    this._options = options;
    this._log = log;
    this._isConnected = isConnected;
    this._presenceManager = new PresenceManager(localUser.actorTokenId);
    this._postStore = new PostStore(options.maxPostCache);
    this._reactionManager = new ReactionManager();
  }

  get posts(): FeedPost[] { return this._postStore.getAll(); }
  get unreadCount(): number { return this._unreadCount; }
  get active(): boolean { return this._active; }

  createPost(opts: CreatePostOptions): FeedPost {
    const post: FeedPost = {
      id: generateId(), userId: this._localUser.userId, username: this._localUser.username,
      avatar: this._localUser.avatar, content: opts.content, media: opts.media, data: opts.data,
      likeCount: 0, commentCount: 0, likedByMe: false, timestamp: Date.now(), status: 'sending', isReplay: false,
    };
    this._postStore.add(post);
    this.emit('postSent', post);
    this._roomContext.emit(TOPIC_POSTS, {
      id: post.id, userId: post.userId, username: post.username, avatar: post.avatar,
      content: post.content, media: post.media, data: post.data, timestamp: post.timestamp,
    }, { echo: false });
    post.status = 'sent';
    return post;
  }

  getPosts(): FeedPost[] { return this._postStore.getAll(); }

  likePost(postId: string): void {
    const { likeCount, isNew } = this._reactionManager.like(postId, this._localUser.userId);
    if (isNew) {
      this._postStore.updateLikeCount(postId, likeCount, true);
      this._roomContext.emit(TOPIC_REACTIONS, { postId, userId: this._localUser.userId, type: 'like', timestamp: Date.now() }, { echo: false });
      this.emit('postLiked', { postId, userId: this._localUser.userId, likeCount });
    }
  }

  unlikePost(postId: string): void {
    const { likeCount, wasLiked } = this._reactionManager.unlike(postId, this._localUser.userId);
    if (wasLiked) {
      this._postStore.updateLikeCount(postId, likeCount, false);
      this._roomContext.emit(TOPIC_REACTIONS, { postId, userId: this._localUser.userId, type: 'unlike', timestamp: Date.now() }, { echo: false });
      this.emit('postUnliked', { postId, userId: this._localUser.userId, likeCount });
    }
  }

  addComment(postId: string, text: string): FeedComment {
    const comment: FeedComment = {
      id: generateId(), postId, userId: this._localUser.userId, username: this._localUser.username,
      avatar: this._localUser.avatar, text, timestamp: Date.now(), isReplay: false,
    };
    if (!this._comments.has(postId)) this._comments.set(postId, []);
    this._comments.get(postId)!.push(comment);
    this._postStore.incrementCommentCount(postId);
    this.emit('commentSent', comment);
    this._roomContext.emit(TOPIC_COMMENTS, {
      id: comment.id, postId, userId: comment.userId, username: comment.username,
      avatar: comment.avatar, text: comment.text, timestamp: comment.timestamp,
    }, { echo: false });
    return comment;
  }

  getComments(postId: string): FeedComment[] {
    return this._comments.get(postId) ?? [];
  }

  markRead(): void {
    if (this._unreadCount !== 0) {
      this._unreadCount = 0;
      this.emit('unreadChanged', { channel: this.name, count: 0 });
    }
  }

  getUsers(): FeedUser[] { return this._presenceManager.getAll(); }

  /** @internal Subscribe to post/reaction/comment topics and attach listeners (all channels) */
  _subscribe(): void {
    this._log('Channel subscribe:', this.name);

    this._roomContext.subscribe(TOPIC_POSTS);
    this._roomContext.subscribe(TOPIC_REACTIONS);
    this._roomContext.subscribe(TOPIC_COMMENTS);

    // Listen for posts (refs stored for handler-specific removal)
    this._onPostsRef = (data: unknown, meta: MessageMeta) => {
      this._handleIncomingPost(data, meta);
    };
    this._roomContext.on(TOPIC_POSTS, this._onPostsRef);

    // Listen for reactions
    this._onReactionsRef = (data: unknown) => {
      this._handleIncomingReaction(data);
    };
    this._roomContext.on(TOPIC_REACTIONS, this._onReactionsRef);

    // Listen for comments
    this._onCommentsRef = (data: unknown, meta: MessageMeta) => {
      this._handleIncomingComment(data, meta);
    };
    this._roomContext.on(TOPIC_COMMENTS, this._onCommentsRef);
  }

  _activate(): void {
    this._active = true;
    this._markRead();
    this._setPresence();
    this._roomContext.fetchPresence().then((actors) => {
      for (const actor of actors) {
        if (actor.presence) {
          const user = this._presenceManager.addFromPresence(actor.actorTokenId, actor.presence as FeedPresenceData, actor.joinedAt);
          if (user) this.emit('subscriberJoined', user);
        }
      }
    }).catch(() => {});
  }

  _deactivate(): void { this._active = false; this._presenceManager.clear(); }

  _handlePresenceJoin(actorTokenId: string, presenceData: FeedPresenceData): void {
    const user = this._presenceManager.addFromPresence(actorTokenId, presenceData);
    if (user) this.emit('subscriberJoined', user);
  }

  _handlePresenceLeave(actorTokenId: string): void {
    const user = this._presenceManager.removeByActorId(actorTokenId);
    if (user) this.emit('subscriberLeft', user);
  }

  _handlePresenceUpdate(actorTokenId: string, presenceData: FeedPresenceData): void {
    this._presenceManager.addFromPresence(actorTokenId, presenceData);
  }

  _handleReplayStart(count: number): void { this.emit('replayStart', { count }); }
  _handleReplayEnd(replayed: number): void { this.emit('replayEnd', { replayed }); }

  _updateLocalPresence(): void { this._setPresence(); }

  /** @internal Unsubscribe and clean up */
  _cleanup(): void {
    this._log('Channel cleanup:', this.name);

    // Server unsubscribes need a live socket; skip when disconnected
    // (best-effort — the core would no-op with an error callback anyway).
    if (this._isConnected()) {
      this._roomContext.unsubscribe(TOPIC_POSTS);
      this._roomContext.unsubscribe(TOPIC_REACTIONS);
      this._roomContext.unsubscribe(TOPIC_COMMENTS);
    }

    // Handler-specific removal only: the client may be shared, and a bare
    // off(topic) would strip other consumers' handlers too.
    if (this._onPostsRef) this._roomContext.off(TOPIC_POSTS, this._onPostsRef);
    if (this._onReactionsRef) this._roomContext.off(TOPIC_REACTIONS, this._onReactionsRef);
    if (this._onCommentsRef) this._roomContext.off(TOPIC_COMMENTS, this._onCommentsRef);
    this._onPostsRef = null;
    this._onReactionsRef = null;
    this._onCommentsRef = null;

    this._postStore.clear();
    this._reactionManager.clear();
    this._comments.clear();
    this._presenceManager.clear();
    this.removeAllListeners();
  }

  private _handleIncomingPost(data: unknown, meta: MessageMeta): void {
    const raw = data as Record<string, unknown>;
    const post: FeedPost = {
      id: raw.id as string, userId: raw.userId as string, username: raw.username as string,
      avatar: raw.avatar as string | undefined, content: raw.content as string,
      media: raw.media as any, data: raw.data as any,
      likeCount: 0, commentCount: 0, likedByMe: false,
      timestamp: raw.timestamp as number, status: 'delivered', isReplay: meta.isReplay ?? false,
    };
    if (this._postStore.add(post)) {
      this.emit('postCreated', post);
      if (!this._active && !post.isReplay) {
        this._unreadCount++;
        this.emit('unreadChanged', { channel: this.name, count: this._unreadCount });
      }
    }
  }

  private _handleIncomingReaction(data: unknown): void {
    const raw = data as { postId: string; userId: string; type: string };
    if (raw.type === 'like') {
      const { likeCount } = this._reactionManager.like(raw.postId, raw.userId);
      const likedByMe = this._reactionManager.isLikedBy(raw.postId, this._localUser.userId);
      this._postStore.updateLikeCount(raw.postId, likeCount, likedByMe);
      this.emit('postLiked', { postId: raw.postId, userId: raw.userId, likeCount });
    } else if (raw.type === 'unlike') {
      const { likeCount } = this._reactionManager.unlike(raw.postId, raw.userId);
      const likedByMe = this._reactionManager.isLikedBy(raw.postId, this._localUser.userId);
      this._postStore.updateLikeCount(raw.postId, likeCount, likedByMe);
      this.emit('postUnliked', { postId: raw.postId, userId: raw.userId, likeCount });
    }
  }

  private _handleIncomingComment(data: unknown, meta: MessageMeta): void {
    const raw = data as Record<string, unknown>;
    const comment: FeedComment = {
      id: raw.id as string, postId: raw.postId as string, userId: raw.userId as string,
      username: raw.username as string, avatar: raw.avatar as string | undefined,
      text: raw.text as string, timestamp: raw.timestamp as number, isReplay: meta.isReplay ?? false,
    };
    if (!this._comments.has(comment.postId)) this._comments.set(comment.postId, []);
    this._comments.get(comment.postId)!.push(comment);
    this._postStore.incrementCommentCount(comment.postId);
    this.emit('commentAdded', comment);
  }

  private _markRead(): void {
    if (this._unreadCount !== 0) { this._unreadCount = 0; this.emit('unreadChanged', { channel: this.name, count: 0 }); }
  }

  private _setPresence(): void {
    this._roomContext.setPresence({
      userId: this._localUser.userId, username: this._localUser.username,
      avatar: this._localUser.avatar, metadata: this._localUser.metadata,
      // Scope tag: on a shared client, other apps' wrappers filter our
      // presence out by this (and we filter theirs).
      __scope: this._options.appName,
    } as FeedPresenceData);
  }
}
