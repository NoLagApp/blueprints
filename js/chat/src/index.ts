/**
 * @nolag/chat
 * High-level chat SDK for Node.js
 */

export { NoLagChat } from './NoLagChat';
export { ChatRoom } from './ChatRoom';
export { EventEmitter } from './EventEmitter';

export type {
  NoLagChatOptions,
  ChatUser,
  ChatMessage,
  ChatClientEvents,
  ChatRoomEvents,
  ChatPresenceData,
  SendMessageOptions,
} from './types';
