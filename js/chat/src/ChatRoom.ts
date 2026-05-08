import type { RoomContext, MessageMeta } from '@nolag/js-sdk';
import { EventEmitter } from './EventEmitter';
import { MessageStore } from './MessageStore';
import { PresenceManager } from './PresenceManager';
import { TypingManager } from './TypingManager';
import { generateId } from './utils';
import { TOPIC_MESSAGES, TOPIC_TYPING } from './constants';
import type {
  ChatRoomEvents,
  ChatMessage,
  ChatUser,
  ChatPresenceData,
  ResolvedChatOptions,
  SendMessageOptions,
} from './types';

/**
 * ChatRoom — a single chat room with messages, users, and typing indicators.
 *
 * Created via `NoLagChat.joinRoom(name)`. Do not instantiate directly.
 */
export class ChatRoom extends EventEmitter<ChatRoomEvents> {
  /** Room name */
  readonly name: string;

  private _roomContext: RoomContext;
  private _localUser: ChatUser;
  private _options: ResolvedChatOptions;
  private _presenceManager: PresenceManager;
  private _typingManager: TypingManager;
  private _messageStore: MessageStore;
  private _log: (...args: unknown[]) => void;
  private _unreadCount = 0;
  private _active = false;

  /** @internal */
  constructor(
    name: string,
    roomContext: RoomContext,
    localUser: ChatUser,
    options: ResolvedChatOptions,
    log: (...args: unknown[]) => void,
  ) {
    super();
    this.name = name;
    this._roomContext = roomContext;
    this._localUser = localUser;
    this._options = options;
    this._log = log;

    this._presenceManager = new PresenceManager(localUser.actorTokenId);
    this._typingManager = new TypingManager(options.typingTimeout);
    this._messageStore = new MessageStore(options.maxMessageCache);

    // Wire typing send callback
    this._typingManager.onSend((typing) => {
      this._roomContext.emit(TOPIC_TYPING, {
        userId: this._localUser.userId,
        typing,
      }, { echo: false });
    });

    // Wire typing change callback
    this._typingManager.onChange(() => {
      this.emit('typing', { users: this.typingUsers });
    });
  }

  // ============ Public Properties ============

  /** All remote users currently in this room */
  get users(): Map<string, ChatUser> {
    return this._presenceManager.users;
  }

  /** All messages in this room (timestamp order) */
  get messages(): ChatMessage[] {
    return this._messageStore.getAll();
  }

  /** Users currently typing */
  get typingUsers(): ChatUser[] {
    const typingIds = this._typingManager.getTypingUserIds();
    const users: ChatUser[] = [];
    for (const userId of typingIds) {
      const user = this._presenceManager.getUser(userId);
      if (user) users.push(user);
    }
    return users;
  }

  /** Number of unread messages (increments when room is not active) */
  get unreadCount(): number {
    return this._unreadCount;
  }

  /** Whether this room is the currently active (visible) room */
  get active(): boolean {
    return this._active;
  }

  /** Reset the unread count to zero */
  markRead(): void {
    if (this._unreadCount !== 0) {
      this._unreadCount = 0;
      this.emit('unreadChanged', { room: this.name, count: 0 });
    }
  }

  // ============ Messaging ============

  /**
   * Send a text message to this room. Returns an optimistic ChatMessage.
   */
  sendMessage(text: string, options?: SendMessageOptions): ChatMessage {
    const message: ChatMessage = {
      id: generateId(),
      userId: this._localUser.userId,
      username: this._localUser.username,
      avatar: this._localUser.avatar,
      text,
      data: options?.data,
      timestamp: Date.now(),
      status: 'sending',
      isReplay: false,
    };

    // Add to local store (optimistic)
    this._messageStore.add(message);
    this.emit('messageSent', message);

    // Publish to room (echo: false prevents duplicate)
    this._roomContext.emit(TOPIC_MESSAGES, {
      id: message.id,
      userId: message.userId,
      username: message.username,
      avatar: message.avatar,
      text: message.text,
      data: message.data,
      timestamp: message.timestamp,
    }, { echo: false });

    // Mark as sent
    message.status = 'sent';

    // Stop typing on send
    this._typingManager.stopTyping();

    return message;
  }

  /**
   * Get all messages (alias for the messages getter).
   */
  getMessages(): ChatMessage[] {
    return this._messageStore.getAll();
  }

  // ============ Typing ============

  /**
   * Signal that the local user is typing. Auto-stops after timeout.
   */
  startTyping(): void {
    this._typingManager.startTyping();
  }

  /**
   * Explicitly signal that the local user has stopped typing.
   */
  stopTyping(): void {
    this._typingManager.stopTyping();
  }

  // ============ Users ============

  /**
   * Get all remote users in this room.
   */
  getUsers(): ChatUser[] {
    return this._presenceManager.getAll();
  }

  /**
   * Get a specific user by userId.
   */
  getUser(userId: string): ChatUser | undefined {
    return this._presenceManager.getUser(userId);
  }

  // ============ Internal (called by NoLagChat) ============

  /** @internal Subscribe to message/typing topics and attach listeners (all rooms) */
  _subscribe(): void {
    this._log('Room subscribe:', this.name);

    // Subscribe to topics
    this._roomContext.subscribe(TOPIC_MESSAGES);
    this._roomContext.subscribe(TOPIC_TYPING);

    // Listen for messages
    this._roomContext.on(TOPIC_MESSAGES, (data: unknown, meta: MessageMeta) => {
      this._handleIncomingMessage(data, meta);
    });

    // Listen for typing
    this._roomContext.on(TOPIC_TYPING, (data: unknown) => {
      const { userId, typing } = data as { userId: string; typing: boolean };
      if (userId !== this._localUser.userId) {
        this._typingManager.handleRemote(userId, typing);
      }
    });
  }

  /** @internal Set presence and fetch room members (active room only) */
  _activate(): void {
    this._log('Room activate:', this.name);
    this._active = true;
    this._markRead();

    // Set room presence
    this._setPresence();

    // Fetch existing users
    this._roomContext.fetchPresence().then((actors) => {
      this._log('Room presence fetched:', this.name, actors.length, 'actors');
      for (const actor of actors) {
        if (actor.presence) {
          const user = this._presenceManager.addFromPresence(
            actor.actorTokenId,
            actor.presence as ChatPresenceData,
            actor.joinedAt,
          );
          if (user) {
            this.emit('userJoined', user);
          }
        }
      }
    }).catch((err) => {
      this._log('Failed to fetch room presence:', err);
    });
  }

  /** @internal Clear presence state but keep subscriptions alive */
  _deactivate(): void {
    this._log('Room deactivate:', this.name);
    this._active = false;
    this._presenceManager.clear();
  }

  /** @internal Handle a lobby presence:join event routed from NoLagChat */
  _handlePresenceJoin(actorTokenId: string, presenceData: ChatPresenceData): void {
    const user = this._presenceManager.addFromPresence(actorTokenId, presenceData);
    if (user) {
      this._log('User joined room:', this.name, user.username);
      this.emit('userJoined', user);
    }
  }

  /** @internal Handle a lobby presence:leave event routed from NoLagChat */
  _handlePresenceLeave(actorTokenId: string): void {
    const user = this._presenceManager.removeByActorId(actorTokenId);
    if (user) {
      this._log('User left room:', this.name, user.username);
      // Remove from typing
      this._typingManager.handleRemote(user.userId, false);
      this.emit('userLeft', user);
    }
  }

  /** @internal Handle a lobby presence:update event routed from NoLagChat */
  _handlePresenceUpdate(actorTokenId: string, presenceData: ChatPresenceData): void {
    this._presenceManager.addFromPresence(actorTokenId, presenceData);
  }

  /** @internal Handle replay start event */
  _handleReplayStart(count: number): void {
    this.emit('replayStart', { count });
  }

  /** @internal Handle replay end event */
  _handleReplayEnd(replayed: number): void {
    this.emit('replayEnd', { replayed });
  }

  /** @internal Re-set presence after reconnect */
  _updateLocalPresence(): void {
    this._setPresence();
  }

  /** @internal Unsubscribe and clean up */
  _cleanup(): void {
    this._log('Room cleanup:', this.name);

    this._roomContext.unsubscribe(TOPIC_MESSAGES);
    this._roomContext.unsubscribe(TOPIC_TYPING);
    this._roomContext.off(TOPIC_MESSAGES);
    this._roomContext.off(TOPIC_TYPING);

    this._typingManager.dispose();
    this._messageStore.clear();
    this._presenceManager.clear();
    this.removeAllListeners();
  }

  // ============ Private ============

  private _handleIncomingMessage(data: unknown, meta: MessageMeta): void {
    const msg = data as Record<string, unknown>;

    const chatMessage: ChatMessage = {
      id: msg.id as string,
      userId: msg.userId as string,
      username: msg.username as string,
      avatar: msg.avatar as string | undefined,
      text: msg.text as string,
      data: msg.data as Record<string, unknown> | undefined,
      timestamp: msg.timestamp as number,
      status: 'delivered',
      isReplay: meta.isReplay ?? false,
    };

    if (this._messageStore.add(chatMessage)) {
      this.emit('message', chatMessage);

      // Track unread when not the active room
      if (!this._active && !chatMessage.isReplay) {
        this._unreadCount++;
        this.emit('unreadChanged', { room: this.name, count: this._unreadCount });
      }
    }
  }

  private _markRead(): void {
    if (this._unreadCount !== 0) {
      this._unreadCount = 0;
      this.emit('unreadChanged', { room: this.name, count: 0 });
    }
  }

  private _setPresence(): void {
    const presenceData: ChatPresenceData = {
      userId: this._localUser.userId,
      username: this._localUser.username,
      avatar: this._localUser.avatar,
      status: this._localUser.status,
      metadata: this._localUser.metadata,
    };
    this._roomContext.setPresence(presenceData);
  }
}
