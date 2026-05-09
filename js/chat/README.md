# @nolag/chat

High-level chat SDK for [NoLag](https://nolag.app) — multi-room chat, presence, typing indicators, and message replay.

## How It Works with NoLag

NoLag is a real-time messaging platform that handles WebSocket connections, message routing, persistence, and scaling. This SDK wraps the low-level [@nolag/js-sdk](https://www.npmjs.com/package/@nolag/js-sdk) and gives you a purpose-built chat API — rooms, messages, typing indicators, and presence — without needing to manage topics or subscriptions yourself.

### Getting Your Token

1. Sign up at [nolag.app](https://nolag.app)
2. Create a new **project** in the portal
3. Choose the **Chat** blueprint when creating an app — this pre-configures the topics (`messages`, `_typing`), rooms, and lobbies your chat app needs
4. Go to the app's **Tokens** page and generate an **actor token**
5. Use that token when connecting with this SDK

Each token identifies a unique user (actor) in NoLag. The blueprint handles all the infrastructure setup — you just write your chat UI.

## Install

```bash
npm install @nolag/js-sdk @nolag/chat
```

## Quick Start

```typescript
import { NoLagChat } from "@nolag/chat";

const chat = new NoLagChat("YOUR_ACTOR_TOKEN", {
  username: "Alice",
});

await chat.connect();

// Join a room and send a message
const room = chat.joinRoom("general");
room.sendMessage("Hello, everyone!");

// Listen for messages
room.on("message", (msg) => {
  console.log(`${msg.username}: ${msg.text}`);
});

// See who's online
chat.on("userOnline", (user) => {
  console.log(`${user.username} came online`);
});

// Typing indicators
room.startTyping(); // auto-stops after timeout
room.on("typing", (users) => {
  console.log("Typing:", users.map((u) => u.username).join(", "));
});
```

## API Reference

### `NoLagChat`

#### Constructor

```typescript
const chat = new NoLagChat(token: string, options: NoLagChatOptions);
```

**Options:**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `username` | `string` | *required* | Display name for this user |
| `avatar` | `string` | — | Avatar URL |
| `metadata` | `Record<string, unknown>` | — | Custom user data |
| `rooms` | `string[]` | — | Auto-join these rooms on connect |
| `typingTimeout` | `number` | `3000` | Ms before typing indicator auto-clears |
| `maxMessageCache` | `number` | `500` | Max messages kept in memory per room |
| `debug` | `boolean` | `false` | Enable debug logging |
| `reconnect` | `boolean` | `true` | Auto-reconnect on disconnect |

#### Methods

| Method | Returns | Description |
|--------|---------|-------------|
| `connect()` | `Promise<void>` | Connect to NoLag |
| `disconnect()` | `void` | Disconnect |
| `joinRoom(name)` | `ChatRoom` | Join a chat room |
| `leaveRoom(name)` | `void` | Leave a room |
| `getRooms()` | `ChatRoom[]` | Get all joined rooms |
| `getOnlineUsers()` | `ChatUser[]` | Get all online users |
| `setStatus(status)` | `void` | Set status: `'online'`, `'away'`, `'busy'`, `'offline'` |
| `updateProfile(updates)` | `void` | Update username, avatar, or metadata |

#### Properties

| Property | Type | Description |
|----------|------|-------------|
| `connected` | `boolean` | Whether currently connected |
| `localUser` | `ChatUser \| null` | The current user |
| `rooms` | `Map<string, ChatRoom>` | All joined rooms |

#### Events

| Event | Payload | Description |
|-------|---------|-------------|
| `connected` | — | Connected to NoLag |
| `disconnected` | — | Disconnected |
| `reconnected` | — | Reconnected after disconnect |
| `error` | `Error` | Connection or protocol error |
| `userOnline` | `ChatUser` | A user came online |
| `userOffline` | `ChatUser` | A user went offline |
| `userUpdated` | `ChatUser` | A user updated their profile/status |

### `ChatRoom`

#### Methods

| Method | Returns | Description |
|--------|---------|-------------|
| `sendMessage(text, options?)` | `ChatMessage` | Send a message |
| `getMessages()` | `ChatMessage[]` | Get cached messages |
| `startTyping()` | `void` | Broadcast typing indicator |
| `stopTyping()` | `void` | Clear typing indicator |
| `getUsers()` | `ChatUser[]` | Get users in this room |
| `getUser(userId)` | `ChatUser \| undefined` | Get a specific user |
| `markRead()` | `void` | Mark all messages as read |

#### Properties

| Property | Type | Description |
|----------|------|-------------|
| `name` | `string` | Room name |
| `messages` | `ChatMessage[]` | Cached messages |
| `typingUsers` | `ChatUser[]` | Users currently typing |
| `unreadCount` | `number` | Number of unread messages |
| `active` | `boolean` | Whether currently joined |

#### Events

| Event | Payload | Description |
|-------|---------|-------------|
| `message` | `ChatMessage` | New message received |
| `messageSent` | `ChatMessage` | Your message was confirmed |
| `userJoined` | `ChatUser` | User joined the room |
| `userLeft` | `ChatUser` | User left the room |
| `typing` | `ChatUser[]` | Typing users changed |
| `replayStart` | — | Message replay started |
| `replayEnd` | — | Message replay finished |
| `unreadChanged` | `number` | Unread count changed |

## Types

```typescript
interface ChatUser {
  userId: string;
  actorTokenId: string;
  username: string;
  avatar?: string;
  metadata?: Record<string, unknown>;
  status: "online" | "away" | "busy" | "offline";
  joinedAt: number;
  isLocal: boolean;
}

interface ChatMessage {
  id: string;
  userId: string;
  username: string;
  avatar?: string;
  text: string;
  data?: Record<string, unknown>;
  timestamp: number;
  status: "sending" | "sent" | "error";
  isReplay: boolean;
}

interface SendMessageOptions {
  data?: Record<string, unknown>;
}
```

## License

MIT
