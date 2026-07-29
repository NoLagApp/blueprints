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

The app owns one core NoLag client; wrappers attach to it. Any number of
wrapper SDKs (chat, notify, dash, ...) can share the same connection as
long as each uses its own app.

```typescript
import { NoLag } from "@nolag/js-sdk";
import { NoLagChat } from "@nolag/chat";

// One client for the whole app. In a browser, use a token provider so the
// SDK can mint fresh short-lived client tokens from your backend.
const client = NoLag(async () => (await (await fetch("/api/nolag-token")).json()).token);
const chat = new NoLagChat({ client, username: "Alice" });

await client.connect();   // the app owns the connection
await chat.ready();       // wrapper setup done (identity, presence, rooms)

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

// Teardown: the wrapper releases its handlers and topics; the app closes
// the socket (never the other way around).
chat.detach();
client.disconnect();
```

## Lifecycle

- **Construction = attach.** The wrapper wires its handlers onto the injected
  client immediately. If the client is already connected, setup runs on the
  next microtask; otherwise it runs when the client's `connect` event fires.
- **`ready()`** resolves once the first setup completed (identity, online
  lobby, configured rooms). Auth failures surface via your own
  `await client.connect()`, not via `ready()`.
- **Reconnects are automatic.** The wrapper restores presence and reconciles
  the online-user list, emitting only real deltas.
- **`detach()`** removes exactly this wrapper's handlers and topics and never
  touches the socket. It is terminal: construct a new instance to re-attach.
  Detach while the client is still connected so server-side unsubscribes go
  through. In frameworks, call it from your dispose hook (`onUnmounted`,
  HMR dispose).
- **One wrapper per (client, app).** Sharing a client across wrappers of
  DIFFERENT apps is the intended pattern; two wrappers on the same app would
  collide on topics and presence (the SDK warns if you do this).

## API Reference

### `NoLagChat`

#### Constructor

```typescript
const chat = new NoLagChat(options: NoLagChatOptions);
```

**Options:**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `client` | `NoLagSocket` | *required* | The injected core NoLag client |
| `username` | `string` | *required* | Display name for this user |
| `avatar` | `string` | — | Avatar URL |
| `metadata` | `Record<string, unknown>` | — | Custom user data |
| `appName` | `string` | `'chat'` | NoLag app for topic prefixes |
| `rooms` | `string[]` | — | Auto-join these rooms on connect |
| `typingTimeout` | `number` | `3000` | Ms before typing indicator auto-clears |
| `maxMessageCache` | `number` | `500` | Max messages kept in memory per room |
| `debug` | `boolean` | `false` | Enable wrapper debug logging |

#### Methods

| Method | Returns | Description |
|--------|---------|-------------|
| `ready()` | `Promise<void>` | Resolves when wrapper setup completed |
| `detach()` | `void` | Release handlers and topics (terminal; never closes the socket) |
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
