/**
 * Chat Application Types
 * Framework-agnostic type definitions for the chat service
 */

export interface ChatMessage {
  id: string;
  userId: string;
  username: string;
  content: string;
  timestamp: number;
  status: 'sending' | 'sent' | 'delivered';
}

export interface ChatUser {
  id: string;
  username: string;
  status: 'online' | 'away' | 'offline';
  joinedAt: number;
}

export interface ChatState {
  connected: boolean;
  currentUser: ChatUser | null;
  users: Map<string, ChatUser>;
  messages: ChatMessage[];
}

export type ChatEventType =
  | 'state:change'
  | 'message:received'
  | 'message:sent'
  | 'user:joined'
  | 'user:left'
  | 'user:updated'
  | 'connection:change'
  | 'error';

export interface ChatServiceConfig {
  appName?: string;
  roomName?: string;
  wsUrl?: string;
}
