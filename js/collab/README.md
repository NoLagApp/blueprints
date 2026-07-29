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

The app owns one core NoLag client; wrappers attach to it. Any number of
wrapper SDKs (collab, chat, sync, ...) can share the same connection as
long as each uses its own app.

```typescript
import { NoLag } from "@nolag/js-sdk";
import { NoLagCollab } from "@nolag/collab";

// One client for the whole app. In a browser, use a token provider so the
// SDK can mint fresh short-lived client tokens from your backend.
const client = NoLag(async () => (await (await fetch("/api/nolag-token")).json()).token);
const collab = new NoLagCollab({ client, username: "Alice", color: "#FF6B6B" });

collab.on("userOnline", (user) => console.log(user.username, "is online"));

await client.connect();   // the app owns the connection
await collab.ready();     // wrapper setup done (identity, presence, documents)

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

// Live cursors (throttled by cursorThrottle)
doc.updateCursor({ line: 10, column: 5, path: "/content" });

doc.on("cursorMoved", (cursor) => {
  renderCursor(cursor.userId, cursor.line, cursor.column, cursor.color);
});

// User awareness (idle detection, join/leave)
doc.on("awarenessChanged", ({ userId, status }) => {
  updatePresenceStatus(userId, status);
});

doc.on("userJoined", (user) => {
  console.log(`${user.username} started editing`);
});

// Teardown: the wrapper releases its handlers and topics; the app closes
// the socket (never the other way around).
collab.detach();
client.disconnect();
```

## Lifecycle

- **Construction = attach.** The wrapper wires its handlers onto the injected
  client immediately. If the client is already connected, setup runs on the
  next microtask; otherwise it runs when the client's `connect` event fires.
- **`ready()`** resolves once the first setup completed (identity, the online
  lobby, and any configured documents). Auth failures surface via your own
  `await client.connect()`, not via `ready()`.
- **Reconnects are automatic.** The wrapper re-applies document presence and
  reconciles the online-user list, emitting only real deltas. It emits
  `reconnecting` when a reconnect attempt starts and `reconnected` once setup
  completes again.
- **`detach()`** removes exactly this wrapper's handlers and topics (including
  cursor-throttle and per-user idle timers) and never touches the socket. It
  is terminal: construct a new instance to re-attach. Detach while the client
  is still connected so server-side unsubscribes go through. In frameworks,
  call it from your dispose hook (`onUnmounted`, HMR dispose).
- **One wrapper per (client, app).** Sharing a client across wrappers of
  DIFFERENT apps is the intended pattern; two wrappers on the same app would
  collide on topics and presence (the SDK warns if you do this).

## API Reference

### `NoLagCollab`

#### Constructor

```typescript
const collab = new NoLagCollab(options: NoLagCollabOptions);
```

**Options:**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `client` | `NoLagSocket` | *required* | The injected core NoLag client |
| `username` | `string` | *required* | Display name |
| `avatar` | `string` | — | Avatar URL |
| `color` | `string` | — | Cursor/highlight colour |
| `metadata` | `Record<string, unknown>` | — | Custom data |
| `appName` | `string` | `'collab'` | NoLag app for topic prefixes |
| `documents` | `string[]` | — | Auto-join these documents on connect |
| `maxOperationCache` | `number` | `1000` | Max operations kept in memory |
| `idleTimeout` | `number` | `60000` | Ms before user is marked idle |
| `cursorThrottle` | `number` | `50` | Ms between cursor updates |
| `debug` | `boolean` | `false` | Enable wrapper debug logging |

#### Methods

| Method | Returns | Description |
|--------|---------|-------------|
| `ready()` | `Promise<void>` | Resolves when wrapper setup completed |
| `detach()` | `void` | Release handlers and topics (terminal; never closes the socket) |
| `joinDocument(name)` | `CollabDocument` | Join a document |
| `leaveDocument(name)` | `void` | Leave a document |
| `getDocuments()` | `CollabDocument[]` | Get all joined documents |
| `getOnlineUsers()` | `CollabUser[]` | Get online users |

#### Properties

| Property | Type | Description |
|----------|------|-------------|
| `connected` | `boolean` | Whether currently connected |
| `client` | `NoLagSocket` | The injected core client |
| `localUser` | `CollabUser \| null` | The local user (after ready) |
| `documents` | `Map<string, CollabDocument>` | All joined documents |

#### Events

| Event | Payload | Description |
|-------|---------|-------------|
| `connected` | — | First setup completed |
| `disconnected` | `reason` | Disconnected |
| `reconnecting` | — | Reconnect attempt started |
| `reconnected` | — | Reconnected after disconnect |
| `error` | `Error` | Connection or protocol error |
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
