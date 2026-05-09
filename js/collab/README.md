# @nolag/collab

Real-time collaboration SDK for [NoLag](https://nolag.app) — live cursors, operations, and user awareness.

## How It Works with NoLag

NoLag is a real-time messaging platform that handles WebSocket connections, message routing, persistence, and scaling. This SDK wraps the low-level [@nolag/js-sdk](https://www.npmjs.com/package/@nolag/js-sdk) and gives you a purpose-built collaboration API — broadcast editing operations, show live cursor positions, and track user awareness — without managing topics or subscriptions yourself.

### Getting Your Token

1. Sign up at [nolag.app](https://nolag.app)
2. Create a new **project** in the portal
3. Choose the **Collab** blueprint when creating an app — this pre-configures the topics (`operations`, `_cursors`) and settings your collaborative editor needs
4. Go to the app's **Tokens** page and generate an **actor token**
5. Use that token when connecting with this SDK

Each token identifies a unique collaborator (actor) in NoLag. The blueprint handles all the infrastructure setup — you just build your editor UI.

## Install

```bash
npm install @nolag/js-sdk @nolag/collab
```

## Quick Start

```typescript
import { NoLagCollab } from "@nolag/collab";

const collab = new NoLagCollab("YOUR_ACTOR_TOKEN", {
  username: "Alice",
  color: "#FF6B6B",
});

await collab.connect();

const doc = collab.joinDocument("readme.md");

// Send an editing operation
doc.sendOperation("insert", {
  position: 42,
  content: "Hello, world!",
  path: "/content",
});

// Listen for operations from other users
doc.on("operation", (op) => {
  console.log(`${op.username} ${op.type}d at position ${op.position}`);
  applyOperation(op);
});

// Live cursors
doc.updateCursor({ line: 10, column: 5, path: "/content" });

doc.on("cursorMoved", (cursor) => {
  renderCursor(cursor.userId, cursor.line, cursor.column, cursor.color);
});

// User awareness
doc.on("awarenessChanged", (users) => {
  updatePresenceList(users);
});

doc.on("userJoined", (user) => {
  console.log(`${user.username} started editing`);
});
```

## API Reference

### `NoLagCollab`

#### Constructor

```typescript
const collab = new NoLagCollab(token: string, options: NoLagCollabOptions);
```

**Options:**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `username` | `string` | *required* | Display name |
| `avatar` | `string` | — | Avatar URL |
| `color` | `string` | — | Cursor/highlight colour |
| `metadata` | `Record<string, unknown>` | — | Custom data |
| `documents` | `string[]` | — | Auto-join these documents on connect |
| `maxOperationCache` | `number` | `1000` | Max operations kept in memory |
| `idleTimeout` | `number` | `60000` | Ms before user is marked idle |
| `cursorThrottle` | `number` | `50` | Ms between cursor updates |
| `debug` | `boolean` | `false` | Enable debug logging |
| `reconnect` | `boolean` | `true` | Auto-reconnect on disconnect |

#### Methods

| Method | Returns | Description |
|--------|---------|-------------|
| `connect()` | `Promise<void>` | Connect to NoLag |
| `disconnect()` | `void` | Disconnect |
| `joinDocument(name)` | `CollabDocument` | Join a document |
| `leaveDocument(name)` | `void` | Leave a document |
| `getDocuments()` | `CollabDocument[]` | Get all joined documents |
| `getOnlineUsers()` | `CollabUser[]` | Get online users |

#### Events

| Event | Payload | Description |
|-------|---------|-------------|
| `connected` | — | Connected |
| `disconnected` | — | Disconnected |
| `reconnected` | — | Reconnected |
| `error` | `Error` | Error |
| `userOnline` | `CollabUser` | User came online |
| `userOffline` | `CollabUser` | User went offline |

### `CollabDocument`

#### Methods

| Method | Returns | Description |
|--------|---------|-------------|
| `sendOperation(type, options?)` | `CollabOperation` | Send an editing operation |
| `getOperations()` | `CollabOperation[]` | Get cached operations |
| `updateCursor(options)` | `void` | Broadcast cursor position |
| `getCursors()` | `CursorPosition[]` | Get all cursor positions |
| `getCursor(userId)` | `CursorPosition \| undefined` | Get a user's cursor |
| `setStatus(status)` | `void` | Set status: `'active'`, `'idle'`, `'viewing'` |
| `getUsers()` | `CollabUser[]` | Get users in this document |
| `getUser(userId)` | `CollabUser \| undefined` | Get a specific user |

#### Events

| Event | Payload | Description |
|-------|---------|-------------|
| `operation` | `CollabOperation` | Operation received |
| `cursorMoved` | `CursorPosition` | Cursor position changed |
| `userJoined` | `CollabUser` | User joined document |
| `userLeft` | `CollabUser` | User left document |
| `awarenessChanged` | `CollabUser[]` | User statuses changed |
| `replayStart` / `replayEnd` | — | Operation replay |

## Types

```typescript
interface CollabOperation {
  id: string;
  type: OperationType;
  path?: string;
  position?: number;
  length?: number;
  content?: string;
  data?: Record<string, unknown>;
  userId: string;
  username: string;
  timestamp: number;
  isReplay: boolean;
}

type OperationType = "insert" | "delete" | "replace" | "format" | "custom";

interface CursorPosition {
  userId: string;
  username: string;
  color?: string;
  x?: number;
  y?: number;
  line?: number;
  column?: number;
  selection?: unknown;
  path?: string;
  timestamp: number;
}

interface CollabUser {
  userId: string;
  actorTokenId: string;
  username: string;
  avatar?: string;
  color?: string;
  status: UserStatus;
  metadata?: Record<string, unknown>;
  joinedAt: number;
  isLocal: boolean;
}

type UserStatus = "active" | "idle" | "viewing";
```

## License

MIT
