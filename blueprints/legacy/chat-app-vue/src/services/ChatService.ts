/**
 * ChatService - Framework-Agnostic Chat Service
 *
 * This service handles all NoLag communication for the chat application.
 * It uses an event emitter pattern so it can be used with any framework
 * (Vue, React, vanilla JS, etc.)
 *
 * Usage:
 *   const chatService = new ChatService();
 *   chatService.on('message:received', (message) => { ... });
 *   await chatService.connect('MyUsername');
 *   chatService.sendMessage('Hello!');
 */

import NoLag, { type ActorPresence, type MessageMeta } from '@nolag/js-sdk';
import type {
  ChatMessage,
  ChatUser,
  ChatState,
  ChatEventType,
  ChatServiceConfig,
} from '../types/chat';

// Extend Window interface for NoLag token injection
declare global {
  interface Window {
    NOLAG_PREVIEW_TOKEN?: string;
    NOLAG_TOKEN_EXPIRES_AT?: string;
  }
}

type EventHandler = (...args: unknown[]) => void;

const DEFAULT_APP_NAME = 'chat-app';
const DEFAULT_ROOM_NAME = 'general';
const MESSAGE_TOPIC = 'messages';

export class ChatService {
  private client: ReturnType<typeof NoLag> | null = null;
  private eventHandlers: Map<string, Set<EventHandler>> = new Map();
  private config: Required<ChatServiceConfig>;
  // Map actorTokenId to our custom userId for presence leave handling
  private actorToUserMap: Map<string, string> = new Map();

  private state: ChatState = {
    connected: false,
    currentUser: null,
    users: new Map(),
    messages: [],
  };

  constructor(config: ChatServiceConfig = {}) {
    this.config = {
      appName: config.appName || DEFAULT_APP_NAME,
      roomName: config.roomName || DEFAULT_ROOM_NAME,
      wsUrl: config.wsUrl || 'ws://localhost:8080/ws',
    };
  }

  // ============================================
  // Event Emitter Pattern
  // ============================================

  on(event: ChatEventType, handler: EventHandler): () => void {
    if (!this.eventHandlers.has(event)) {
      this.eventHandlers.set(event, new Set());
    }
    this.eventHandlers.get(event)!.add(handler);

    // Return unsubscribe function
    return () => this.off(event, handler);
  }

  off(event: ChatEventType, handler: EventHandler): void {
    this.eventHandlers.get(event)?.delete(handler);
  }

  private emit(event: ChatEventType, ...args: unknown[]): void {
    this.eventHandlers.get(event)?.forEach((handler) => {
      try {
        handler(...args);
      } catch (err) {
        console.error(`[ChatService] Error in ${event} handler:`, err);
      }
    });
  }

  // ============================================
  // State Management
  // ============================================

  getState(): Readonly<ChatState> {
    return {
      ...this.state,
      users: new Map(this.state.users),
      messages: [...this.state.messages],
    };
  }

  private updateState(partial: Partial<ChatState>): void {
    this.state = { ...this.state, ...partial };
    this.emit('state:change', this.getState());
  }

  // ============================================
  // Connection Management
  // ============================================

  async connect(username: string): Promise<void> {
    const token = this.getToken();
    if (!token) {
      throw new Error('No NoLag token available. Please ensure NOLAG_PREVIEW_TOKEN is set.');
    }

    if (this.client) {
      this.disconnect();
    }

    // Create current user
    const currentUser: ChatUser = {
      id: this.generateId(),
      username,
      status: 'online',
      joinedAt: Date.now(),
    };

    this.client = NoLag(token, {
      debug: false,
      url: this.config.wsUrl,
    });

    // Set up event handlers
    this.setupEventHandlers(currentUser);

    // Connect
    await this.client.connect();

    // Update state with current user
    this.state.currentUser = currentUser;
    this.state.users.set(currentUser.id, currentUser);
  }

  disconnect(): void {
    if (this.client) {
      this.client.disconnect();
      this.client = null;
    }

    this.actorToUserMap.clear();
    this.updateState({
      connected: false,
      currentUser: null,
      users: new Map(),
      messages: [],
    });
  }

  isConnected(): boolean {
    return this.state.connected;
  }

  private getToken(): string | null {
    // Token is injected by Titus preview system
    return window.NOLAG_PREVIEW_TOKEN || null;
  }

  // ============================================
  // Event Handlers Setup
  // ============================================

  private setupEventHandlers(currentUser: ChatUser): void {
    if (!this.client) return;

    this.client.on('connect', () => {
      console.log('[ChatService] Connected to NoLag');
      this.updateState({ connected: true });
      this.emit('connection:change', true);

      // Set up room and subscriptions
      this.setupRoom(currentUser);
    });

    this.client.on('disconnect', (reason: string) => {
      console.log('[ChatService] Disconnected:', reason);
      this.updateState({ connected: false });
      this.emit('connection:change', false);
    });

    this.client.on('error', (error: Error) => {
      console.error('[ChatService] Error:', error);
      this.emit('error', error);
    });

    // Presence events (project-level)
    this.client.on('presence:join', (actor: ActorPresence) => {
      this.handleUserJoin(actor);
    });

    this.client.on('presence:leave', (actor: ActorPresence) => {
      this.handleUserLeave(actor);
    });

    this.client.on('presence:update', (actor: ActorPresence) => {
      this.handleUserUpdate(actor);
    });
  }

  private setupRoom(currentUser: ChatUser): void {
    if (!this.client) return;

    const room = this.client
      .setApp(this.config.appName)
      .setRoom(this.config.roomName);

    // Subscribe to messages
    room.subscribe(MESSAGE_TOPIC);

    // Handle incoming messages
    room.on(MESSAGE_TOPIC, (data: unknown, meta: MessageMeta) => {
      const message = data as ChatMessage;
      // Don't add our own messages (we already added them optimistically)
      if (message.userId !== currentUser.id) {
        this.handleIncomingMessage(message);
      }
    });

    // Set presence with user info
    room.setPresence({
      userId: currentUser.id,
      username: currentUser.username,
      status: currentUser.status,
    });

    // Fetch existing presence
    room.fetchPresence().then((actors) => {
      actors.forEach((actor) => {
        if (actor.presence && actor.actorTokenId !== currentUser.id) {
          this.handleUserJoin(actor);
        }
      });
    }).catch((err) => {
      console.warn('[ChatService] Failed to fetch presence:', err);
    });
  }

  // ============================================
  // Message Handling
  // ============================================

  sendMessage(content: string): ChatMessage | null {
    if (!this.client || !this.state.currentUser || !content.trim()) {
      return null;
    }

    const message: ChatMessage = {
      id: this.generateId(),
      userId: this.state.currentUser.id,
      username: this.state.currentUser.username,
      content: content.trim(),
      timestamp: Date.now(),
      status: 'sending',
    };

    // Add message optimistically
    this.state.messages.push(message);
    this.emit('message:sent', message);
    this.emit('state:change', this.getState());

    // Send via NoLag
    const room = this.client
      .setApp(this.config.appName)
      .setRoom(this.config.roomName);

    room.emit(MESSAGE_TOPIC, message, { echo: false });

    // Update status to sent
    message.status = 'sent';
    this.emit('state:change', this.getState());

    return message;
  }

  private handleIncomingMessage(message: ChatMessage): void {
    // Avoid duplicates
    if (this.state.messages.some((m) => m.id === message.id)) {
      return;
    }

    message.status = 'delivered';
    this.state.messages.push(message);
    this.emit('message:received', message);
    this.emit('state:change', this.getState());
  }

  // ============================================
  // Presence Handling
  // ============================================

  private handleUserJoin(actor: ActorPresence): void {
    if (!actor?.actorTokenId || !actor.presence) return;

    const presence = actor.presence as {
      userId?: string;
      username?: string;
      status?: string;
    };

    if (!presence.userId || !presence.username) return;

    // Don't add ourselves
    if (presence.userId === this.state.currentUser?.id) return;

    // Store mapping for leave handling
    this.actorToUserMap.set(actor.actorTokenId, presence.userId);

    const user: ChatUser = {
      id: presence.userId,
      username: presence.username,
      status: (presence.status as ChatUser['status']) || 'online',
      joinedAt: actor.joinedAt || Date.now(),
    };

    this.state.users.set(user.id, user);
    this.emit('user:joined', user);
    this.emit('state:change', this.getState());
  }

  private handleUserLeave(actor: ActorPresence): void {
    if (!actor?.actorTokenId) return;

    // Use actorTokenId to find the user (presence data may be empty on leave)
    const userId = this.actorToUserMap.get(actor.actorTokenId);
    if (!userId) return;

    // Clean up the mapping
    this.actorToUserMap.delete(actor.actorTokenId);

    const user = this.state.users.get(userId);
    if (user) {
      this.state.users.delete(userId);
      this.emit('user:left', user);
      this.emit('state:change', this.getState());
    }
  }

  private handleUserUpdate(actor: ActorPresence): void {
    if (!actor?.presence) return;

    const presence = actor.presence as {
      userId?: string;
      username?: string;
      status?: string;
    };

    if (!presence.userId) return;

    const existingUser = this.state.users.get(presence.userId);
    if (existingUser) {
      const updatedUser: ChatUser = {
        ...existingUser,
        username: presence.username || existingUser.username,
        status: (presence.status as ChatUser['status']) || existingUser.status,
      };
      this.state.users.set(presence.userId, updatedUser);
      this.emit('user:updated', updatedUser);
      this.emit('state:change', this.getState());
    }
  }

  // ============================================
  // Utilities
  // ============================================

  private generateId(): string {
    return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  getMessages(): ChatMessage[] {
    return [...this.state.messages];
  }

  getUsers(): ChatUser[] {
    return Array.from(this.state.users.values());
  }

  getCurrentUser(): ChatUser | null {
    return this.state.currentUser;
  }
}

// Export singleton instance for convenience
export const chatService = new ChatService();
