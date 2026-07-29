import type { RoomContext, MessageMeta } from '@nolag/js-sdk';
import { EventEmitter } from './EventEmitter';
import { CommentStore } from './CommentStore';
import { ReactionManager } from './ReactionManager';
import { PollManager } from './PollManager';
import { PresenceManager } from './PresenceManager';
import { generateId } from './utils';
import { TOPIC_COMMENTS, TOPIC_REACTIONS, TOPIC_POLLS } from './constants';
import type {
  StreamRoomEvents,
  StreamComment,
  StreamViewer,
  StreamPresenceData,
  ResolvedStreamOptions,
  SendCommentOptions,
  CreatePollOptions,
  Poll,
} from './types';

export class StreamRoom extends EventEmitter<StreamRoomEvents> {
  readonly name: string;

  private _roomContext: RoomContext;
  private _localViewer: StreamViewer;
  private _options: ResolvedStreamOptions;
  private _presenceManager: PresenceManager;
  private _commentStore: CommentStore;
  private _reactionManager: ReactionManager;
  private _pollManager: PollManager;
  private _log: (...args: unknown[]) => void;
  private _isConnected: () => boolean;
  private _active = false;

  // Stored topic handler refs — cleanup removes exactly these, never all
  // handlers for a topic (the client may be shared with other consumers).
  private _onCommentsRef: ((data: unknown, meta: MessageMeta) => void) | null = null;
  private _onReactionsRef: ((data: unknown) => void) | null = null;
  private _onPollsRef: ((data: unknown) => void) | null = null;

  /** @internal */
  constructor(
    name: string,
    roomContext: RoomContext,
    localViewer: StreamViewer,
    options: ResolvedStreamOptions,
    log: (...args: unknown[]) => void,
    isConnected: () => boolean,
  ) {
    super();
    this.name = name;
    this._roomContext = roomContext;
    this._localViewer = localViewer;
    this._options = options;
    this._log = log;
    this._isConnected = isConnected;

    this._presenceManager = new PresenceManager(localViewer.actorTokenId);
    this._commentStore = new CommentStore(options.maxCommentCache);
    this._reactionManager = new ReactionManager(options.reactionWindow);
    this._pollManager = new PollManager();

    this._reactionManager.onBurst((burst) => {
      this.emit('reaction', burst);
    });

    this._pollManager.onPollCreated((poll) => this.emit('pollCreated', poll));
    this._pollManager.onPollUpdated((poll) => this.emit('pollUpdated', poll));
    this._pollManager.onPollClosed((poll) => this.emit('pollClosed', poll));
  }

  get comments(): StreamComment[] {
    return this._commentStore.getAll();
  }

  get activePoll(): Poll | undefined {
    return this._pollManager.getActivePoll();
  }

  get viewerCount(): number {
    return this._presenceManager.getAll().length + 1;
  }

  get viewers(): Map<string, StreamViewer> {
    return this._presenceManager.users;
  }

  sendComment(text: string, options?: SendCommentOptions): StreamComment {
    const comment: StreamComment = {
      id: generateId(),
      viewerId: this._localViewer.viewerId,
      username: this._localViewer.username,
      avatar: this._localViewer.avatar,
      text,
      data: options?.data,
      timestamp: Date.now(),
      status: 'sending',
      isReplay: false,
    };

    this._commentStore.add(comment);
    this.emit('commentSent', comment);

    this._roomContext.emit(TOPIC_COMMENTS, {
      id: comment.id,
      viewerId: comment.viewerId,
      username: comment.username,
      avatar: comment.avatar,
      text: comment.text,
      data: comment.data,
      timestamp: comment.timestamp,
    }, { echo: false });

    comment.status = 'sent';
    return comment;
  }

  getComments(): StreamComment[] {
    return this._commentStore.getAll();
  }

  sendReaction(emoji: string): void {
    this._reactionManager.sendReaction(emoji);
    this._roomContext.emit(TOPIC_REACTIONS, { emoji }, { echo: false });
  }

  createPoll(opts: CreatePollOptions): Poll {
    const poll = this._pollManager.createPoll(opts, this._localViewer.viewerId);
    this._roomContext.emit(TOPIC_POLLS, poll, { echo: false });
    return poll;
  }

  votePoll(pollId: string, optionIndex: number): void {
    const poll = this._pollManager.votePoll(pollId, optionIndex, this._localViewer.viewerId);
    if (poll) {
      this._roomContext.emit(TOPIC_POLLS, {
        type: 'vote',
        pollId,
        optionIndex,
        viewerId: this._localViewer.viewerId,
      }, { echo: false });
    }
  }

  closePoll(pollId: string): void {
    const poll = this._pollManager.closePoll(pollId);
    if (poll) {
      this._roomContext.emit(TOPIC_POLLS, poll, { echo: false });
    }
  }

  getViewers(): StreamViewer[] {
    return this._presenceManager.getAll();
  }

  /** @internal Subscribe to comment/reaction/poll topics and attach listeners */
  _subscribe(): void {
    this._log('Room subscribe:', this.name);

    this._roomContext.subscribe(TOPIC_COMMENTS);
    this._roomContext.subscribe(TOPIC_REACTIONS);
    this._roomContext.subscribe(TOPIC_POLLS);

    // Listen for comments (refs stored for handler-specific removal)
    this._onCommentsRef = (data: unknown, meta: MessageMeta) => {
      this._handleIncomingComment(data, meta);
    };
    this._roomContext.on(TOPIC_COMMENTS, this._onCommentsRef);

    // Listen for reactions
    this._onReactionsRef = (data: unknown) => {
      const { emoji } = data as { emoji: string };
      this._reactionManager.handleRemoteReaction(emoji);
    };
    this._roomContext.on(TOPIC_REACTIONS, this._onReactionsRef);

    // Listen for polls (create / vote / close)
    this._onPollsRef = (data: unknown) => {
      const raw = data as Record<string, unknown>;
      if (raw.type === 'vote') {
        this._pollManager.handleRemoteVote(raw as any);
      } else {
        this._pollManager.handleRemotePoll(data);
      }
    };
    this._roomContext.on(TOPIC_POLLS, this._onPollsRef);
  }

  _activate(): void {
    this._log('Room activate:', this.name);
    this._active = true;
    this._setPresence();

    this._roomContext.fetchPresence().then((actors) => {
      for (const actor of actors) {
        if (actor.presence) {
          const viewer = this._presenceManager.addFromPresence(
            actor.actorTokenId,
            actor.presence as StreamPresenceData,
            actor.joinedAt,
          );
          if (viewer) this.emit('viewerJoined', viewer);
        }
      }
    }).catch(() => {});
  }

  _deactivate(): void {
    this._active = false;
    this._presenceManager.clear();
  }

  _handlePresenceJoin(actorTokenId: string, presenceData: StreamPresenceData): void {
    const viewer = this._presenceManager.addFromPresence(actorTokenId, presenceData);
    if (viewer) {
      this.emit('viewerJoined', viewer);
      this.emit('viewerCountChanged', this.viewerCount);
    }
  }

  _handlePresenceLeave(actorTokenId: string): void {
    const viewer = this._presenceManager.removeByActorId(actorTokenId);
    if (viewer) {
      this.emit('viewerLeft', viewer);
      this.emit('viewerCountChanged', this.viewerCount);
    }
  }

  _handlePresenceUpdate(actorTokenId: string, presenceData: StreamPresenceData): void {
    this._presenceManager.addFromPresence(actorTokenId, presenceData);
  }

  _handleReplayStart(count: number): void {
    this.emit('replayStart', { count });
  }

  _handleReplayEnd(replayed: number): void {
    this.emit('replayEnd', { replayed });
  }

  _updateLocalPresence(): void {
    this._setPresence();
  }

  /** @internal Unsubscribe and clean up */
  _cleanup(): void {
    this._log('Room cleanup:', this.name);

    // Server unsubscribes need a live socket; skip when disconnected
    // (best-effort — the core would no-op with an error callback anyway).
    if (this._isConnected()) {
      this._roomContext.unsubscribe(TOPIC_COMMENTS);
      this._roomContext.unsubscribe(TOPIC_REACTIONS);
      this._roomContext.unsubscribe(TOPIC_POLLS);
    }

    // Handler-specific removal only: the client may be shared, and a bare
    // off(topic) would strip other consumers' handlers too.
    if (this._onCommentsRef) this._roomContext.off(TOPIC_COMMENTS, this._onCommentsRef);
    if (this._onReactionsRef) this._roomContext.off(TOPIC_REACTIONS, this._onReactionsRef);
    if (this._onPollsRef) this._roomContext.off(TOPIC_POLLS, this._onPollsRef);
    this._onCommentsRef = null;
    this._onReactionsRef = null;
    this._onPollsRef = null;

    this._reactionManager.dispose();
    this._pollManager.dispose();
    this._commentStore.clear();
    this._presenceManager.clear();
    this.removeAllListeners();
  }

  private _handleIncomingComment(data: unknown, meta: MessageMeta): void {
    const msg = data as Record<string, unknown>;
    const comment: StreamComment = {
      id: msg.id as string,
      viewerId: msg.viewerId as string,
      username: msg.username as string,
      avatar: msg.avatar as string | undefined,
      text: msg.text as string,
      data: msg.data as Record<string, unknown> | undefined,
      timestamp: msg.timestamp as number,
      status: 'delivered',
      isReplay: meta.isReplay ?? false,
    };

    if (this._commentStore.add(comment)) {
      this.emit('comment', comment);
    }
  }

  private _setPresence(): void {
    const presenceData: StreamPresenceData = {
      viewerId: this._localViewer.viewerId,
      username: this._localViewer.username,
      avatar: this._localViewer.avatar,
      role: this._localViewer.role,
      metadata: this._localViewer.metadata,
      // Scope tag: on a shared client, other apps' wrappers filter our
      // presence out by this (and we filter theirs).
      __scope: this._options.appName,
    };
    this._roomContext.setPresence(presenceData);
  }
}
