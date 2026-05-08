/**
 * ChatService - Framework-Agnostic Chat Service
 *
 * Handles all NoLag communication for the chat application.
 * Uses an event emitter pattern for vanilla JS usage.
 *
 * Usage:
 *   const chatService = new ChatService();
 *   chatService.on('state:change', (state) => { ... });
 *   await chatService.connect('MyUsername');
 *   chatService.sendMessage('Hello!');
 */

import NoLag, { type ActorPresence, type MessageMeta } from '@nolag/js-sdk'

// Extend Window interface for NoLag token injection
declare global {
  interface Window {
    NOLAG_PREVIEW_TOKEN?: string
    NOLAG_TOKEN_EXPIRES_AT?: string
  }
}

export interface ChatMessage {
  id: string
  userId: string
  username: string
  content: string
  timestamp: number
  status: 'sending' | 'sent' | 'delivered'
}

export interface ChatUser {
  id: string
  username: string
  status: 'online' | 'away' | 'offline'
  joinedAt: number
}

export interface ChatState {
  connected: boolean
  currentUser: ChatUser | null
  users: Map<string, ChatUser>
  messages: ChatMessage[]
}

export type ChatEventType =
  | 'state:change'
  | 'message:received'
  | 'message:sent'
  | 'user:joined'
  | 'user:left'
  | 'user:updated'
  | 'connection:change'
  | 'error'

type EventHandler = (...args: unknown[]) => void

const DEFAULT_APP_NAME = 'chat-app'
const DEFAULT_ROOM_NAME = 'general'
const MESSAGE_TOPIC = 'messages'

interface ChatServiceConfig {
  appName?: string
  roomName?: string
  wsUrl?: string
}

export class ChatService {
  private client: ReturnType<typeof NoLag> | null = null
  private eventHandlers: Map<string, Set<EventHandler>> = new Map()
  private config: Required<ChatServiceConfig>
  private actorToUserMap: Map<string, string> = new Map()

  private state: ChatState = {
    connected: false,
    currentUser: null,
    users: new Map(),
    messages: [],
  }

  constructor(config: ChatServiceConfig = {}) {
    this.config = {
      appName: config.appName || DEFAULT_APP_NAME,
      roomName: config.roomName || DEFAULT_ROOM_NAME,
      // Broker URL — change to wss://broker.dev.nolag.app/ws for development
      wsUrl: config.wsUrl || 'wss://broker.nolag.app/ws',
    }
  }

  on(event: ChatEventType, handler: EventHandler): () => void {
    if (!this.eventHandlers.has(event)) {
      this.eventHandlers.set(event, new Set())
    }
    this.eventHandlers.get(event)!.add(handler)
    return () => this.off(event, handler)
  }

  off(event: ChatEventType, handler: EventHandler): void {
    this.eventHandlers.get(event)?.delete(handler)
  }

  private emit(event: ChatEventType, ...args: unknown[]): void {
    this.eventHandlers.get(event)?.forEach((handler) => {
      try {
        handler(...args)
      } catch (err) {
        console.error(`[ChatService] Error in ${event} handler:`, err)
      }
    })
  }

  getState(): Readonly<ChatState> {
    return {
      ...this.state,
      users: new Map(this.state.users),
      messages: [...this.state.messages],
    }
  }

  private updateState(partial: Partial<ChatState>): void {
    this.state = { ...this.state, ...partial }
    this.emit('state:change', this.getState())
  }

  async connect(username: string): Promise<void> {
    const token = this.getToken()
    if (!token) {
      throw new Error('No NoLag token available. Please ensure NOLAG_PREVIEW_TOKEN is set.')
    }

    if (this.client) {
      this.disconnect()
    }

    const currentUser: ChatUser = {
      id: this.generateId(),
      username,
      status: 'online',
      joinedAt: Date.now(),
    }

    this.client = NoLag(token, {
      debug: false,
      url: this.config.wsUrl,
    })

    this.setupEventHandlers(currentUser)
    await this.client.connect()

    this.state.currentUser = currentUser
    this.state.users.set(currentUser.id, currentUser)
  }

  disconnect(): void {
    if (this.client) {
      this.client.disconnect()
      this.client = null
    }

    this.actorToUserMap.clear()
    this.updateState({
      connected: false,
      currentUser: null,
      users: new Map(),
      messages: [],
    })
  }

  isConnected(): boolean {
    return this.state.connected
  }

  private getToken(): string | null {
    return window.NOLAG_PREVIEW_TOKEN || null
  }

  private setupEventHandlers(currentUser: ChatUser): void {
    if (!this.client) return

    this.client.on('connect', () => {
      console.log('[ChatService] Connected to NoLag')
      this.updateState({ connected: true })
      this.emit('connection:change', true)
      this.setupRoom(currentUser)
    })

    this.client.on('disconnect', (reason: string) => {
      console.log('[ChatService] Disconnected:', reason)
      this.updateState({ connected: false })
      this.emit('connection:change', false)
    })

    this.client.on('error', (error: Error) => {
      console.error('[ChatService] Error:', error)
      this.emit('error', error)
    })

    this.client.on('presence:join', (actor: ActorPresence) => {
      this.handleUserJoin(actor)
    })

    this.client.on('presence:leave', (actor: ActorPresence) => {
      this.handleUserLeave(actor)
    })

    this.client.on('presence:update', (actor: ActorPresence) => {
      this.handleUserUpdate(actor)
    })
  }

  private setupRoom(currentUser: ChatUser): void {
    if (!this.client) return

    const room = this.client
      .setApp(this.config.appName)
      .setRoom(this.config.roomName)

    room.subscribe(MESSAGE_TOPIC)

    room.on(MESSAGE_TOPIC, (data: unknown, _meta: MessageMeta) => {
      const message = data as ChatMessage
      if (message.userId !== currentUser.id) {
        this.handleIncomingMessage(message)
      }
    })

    room.setPresence({
      userId: currentUser.id,
      username: currentUser.username,
      status: currentUser.status,
    })

    room.fetchPresence().then((actors) => {
      actors.forEach((actor) => {
        if (actor.presence && actor.actorTokenId !== currentUser.id) {
          this.handleUserJoin(actor)
        }
      })
    }).catch((err) => {
      console.warn('[ChatService] Failed to fetch presence:', err)
    })
  }

  sendMessage(content: string): ChatMessage | null {
    if (!this.client || !this.state.currentUser || !content.trim()) {
      return null
    }

    const message: ChatMessage = {
      id: this.generateId(),
      userId: this.state.currentUser.id,
      username: this.state.currentUser.username,
      content: content.trim(),
      timestamp: Date.now(),
      status: 'sending',
    }

    this.state.messages.push(message)
    this.emit('message:sent', message)
    this.emit('state:change', this.getState())

    const room = this.client
      .setApp(this.config.appName)
      .setRoom(this.config.roomName)

    room.emit(MESSAGE_TOPIC, message, { echo: false })

    message.status = 'sent'
    this.emit('state:change', this.getState())

    return message
  }

  private handleIncomingMessage(message: ChatMessage): void {
    if (this.state.messages.some((m) => m.id === message.id)) {
      return
    }

    message.status = 'delivered'
    this.state.messages.push(message)
    this.emit('message:received', message)
    this.emit('state:change', this.getState())
  }

  private handleUserJoin(actor: ActorPresence): void {
    if (!actor?.actorTokenId || !actor.presence) return

    const presence = actor.presence as {
      userId?: string
      username?: string
      status?: string
    }

    if (!presence.userId || !presence.username) return
    if (presence.userId === this.state.currentUser?.id) return

    this.actorToUserMap.set(actor.actorTokenId, presence.userId)

    const user: ChatUser = {
      id: presence.userId,
      username: presence.username,
      status: (presence.status as ChatUser['status']) || 'online',
      joinedAt: actor.joinedAt || Date.now(),
    }

    this.state.users.set(user.id, user)
    this.emit('user:joined', user)
    this.emit('state:change', this.getState())
  }

  private handleUserLeave(actor: ActorPresence): void {
    if (!actor?.actorTokenId) return

    const userId = this.actorToUserMap.get(actor.actorTokenId)
    if (!userId) return

    this.actorToUserMap.delete(actor.actorTokenId)

    const user = this.state.users.get(userId)
    if (user) {
      this.state.users.delete(userId)
      this.emit('user:left', user)
      this.emit('state:change', this.getState())
    }
  }

  private handleUserUpdate(actor: ActorPresence): void {
    if (!actor?.presence) return

    const presence = actor.presence as {
      userId?: string
      username?: string
      status?: string
    }

    if (!presence.userId) return

    const existingUser = this.state.users.get(presence.userId)
    if (existingUser) {
      const updatedUser: ChatUser = {
        ...existingUser,
        username: presence.username || existingUser.username,
        status: (presence.status as ChatUser['status']) || existingUser.status,
      }
      this.state.users.set(presence.userId, updatedUser)
      this.emit('user:updated', updatedUser)
      this.emit('state:change', this.getState())
    }
  }

  private generateId(): string {
    return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
  }
}
