# @nolag/sync

Real-time data sync SDK for [NoLag](https://nolag.app) — document CRUD, conflict resolution, and version tracking.

## How It Works with NoLag

NoLag is a real-time messaging platform that handles WebSocket connections, message routing, persistence, and scaling. This SDK wraps the low-level [@nolag/js-sdk](https://www.npmjs.com/package/@nolag/js-sdk) and gives you a purpose-built sync API — create, update, and delete documents across clients with automatic conflict detection and version tracking — without managing topics or subscriptions yourself.

### Getting Your Token

1. Sign up at [nolag.app](https://nolag.app)
2. Create a new **project** in the portal
3. Choose the **Sync** blueprint when creating an app — this pre-configures the `changes` topic and settings your sync system needs
4. Go to the app's **Tokens** page and generate an **actor token**
5. Use that token when connecting with this SDK

Each token identifies a unique collaborator (actor) in NoLag. The blueprint handles all the infrastructure setup — you just build your app.

## Install

```bash
npm install @nolag/js-sdk @nolag/sync
```

## Quick Start

The app owns one core NoLag client; wrappers attach to it. Any number of
wrapper SDKs (sync, chat, dash, ...) can share the same connection as
long as each uses its own app.

```typescript
import { NoLag } from "@nolag/js-sdk";
import { NoLagSync } from "@nolag/sync";

// One client for the whole app. In a browser, use a token provider so the
// SDK can mint fresh short-lived client tokens from your backend.
const client = NoLag(async () => (await (await fetch("/api/nolag-token")).json()).token);
const sync = new NoLagSync({ client, username: "Alice" });

await client.connect();   // the app owns the connection
await sync.ready();       // wrapper setup done (identity, presence, collections)

const collection = sync.joinCollection("tasks");

// Create a document
collection.createDocument("task-1", {
  title: "Ship feature",
  status: "in-progress",
  assignee: "Alice",
});

// Update a document
collection.updateDocument("task-1", { status: "done" });

// Listen for changes from other clients
collection.on("documentCreated", (doc) => {
  console.log(`New doc: ${doc.id}`);
});

collection.on("documentUpdated", (doc) => {
  console.log("Updated:", doc.data);
});

// Handle conflicts
collection.on("conflict", (conflict) => {
  console.log("Conflict on", conflict.documentId);
  // Last-writer-wins is applied automatically; the resolved doc is on conflict.resolved
});

// Teardown: the wrapper releases its handlers and topics; the app closes
// the socket (never the other way around).
sync.detach();
client.disconnect();
```

## Lifecycle

- **Construction = attach.** The wrapper wires its handlers onto the injected
  client immediately. If the client is already connected, setup runs on the
  next microtask; otherwise it runs when the client's `connect` event fires.
- **`ready()`** resolves once the first setup completed (identity, the online
  lobby, and any configured collections). Auth failures surface via your own
  `await client.connect()`, not via `ready()`.
- **Reconnects are automatic.** The wrapper restores collection presence and
  reconciles the online-collaborator list, emitting only real deltas.
- **`detach()`** removes exactly this wrapper's handlers and topics and never
  touches the socket. It is terminal: construct a new instance to re-attach.
  Detach while the client is still connected so server-side unsubscribes go
  through. In frameworks, call it from your dispose hook (`onUnmounted`,
  HMR dispose).
- **One wrapper per (client, app).** Sharing a client across wrappers of
  DIFFERENT apps is the intended pattern; two wrappers on the same app would
  collide on topics and presence (the SDK warns if you do this).

## API Reference

### `NoLagSync`

#### Constructor

```typescript
const sync = new NoLagSync(options: NoLagSyncOptions);
```

**Options:**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `client` | `NoLagSocket` | *required* | The injected core NoLag client |
| `userId` | `string` | auto-generated | Stable user ID |
| `username` | `string` | — | Display name |
| `metadata` | `Record<string, unknown>` | — | Custom collaborator data |
| `appName` | `string` | `'sync'` | NoLag app for topic prefixes |
| `collections` | `string[]` | — | Auto-join these collections on connect |
| `debug` | `boolean` | `false` | Enable wrapper debug logging |

#### Methods

| Method | Returns | Description |
|--------|---------|-------------|
| `ready()` | `Promise<void>` | Resolves when wrapper setup completed |
| `detach()` | `void` | Release handlers and topics (terminal; never closes the socket) |
| `joinCollection(name)` | `SyncRoom` | Join a collection |
| `leaveCollection(name)` | `void` | Leave a collection |
| `getCollections()` | `SyncRoom[]` | Get all joined collections |
| `getCollaborators()` | `SyncCollaborator[]` | Get all online collaborators |

#### Properties

| Property | Type | Description |
|----------|------|-------------|
| `connected` | `boolean` | Whether currently connected |
| `localCollaborator` | `SyncCollaborator \| null` | The local collaborator |
| `collections` | `Map<string, SyncRoom>` | All joined collections |

#### Events

| Event | Payload | Description |
|-------|---------|-------------|
| `connected` | — | First setup completed |
| `disconnected` | `reason` | Disconnected |
| `reconnecting` | — | Reconnect attempt started |
| `reconnected` | — | Reconnected after disconnect |
| `error` | `Error` | Connection or protocol error |
| `collaboratorOnline` | `SyncCollaborator` | Collaborator came online |
| `collaboratorOffline` | `SyncCollaborator` | Collaborator went offline |

### `SyncRoom`

#### Methods

| Method | Returns | Description |
|--------|---------|-------------|
| `createDocument(id, data)` | `SyncDocument` | Create a document |
| `updateDocument(id, fields)` | `SyncDocument \| null` | Update document fields |
| `deleteDocument(id)` | `SyncDocument \| null` | Delete a document |
| `getDocument(id)` | `SyncDocument \| undefined` | Get a document |
| `getAllDocuments()` | `SyncDocument[]` | Get all non-deleted documents |

#### Events

| Event | Payload | Description |
|-------|---------|-------------|
| `documentCreated` | `SyncDocument` | Document created |
| `documentUpdated` | `SyncDocument` | Document updated |
| `documentDeleted` | `SyncDocument` | Document deleted |
| `localChange` | `SyncChange` | Your local change (before broadcast) |
| `conflict` | `SyncConflict` | Conflicting changes detected |
| `synced` | `SyncDocument` | A remote change was applied |
| `collaboratorJoined` | `SyncCollaborator` | Collaborator joined a collection |
| `collaboratorLeft` | `SyncCollaborator` | Collaborator left a collection |
| `replayStart` / `replayEnd` | — | Document replay |

## Types

```typescript
interface SyncDocument {
  id: string;
  data: Record<string, unknown>;
  version: number;
  updatedBy: string;
  updatedAt: number;
  createdAt: number;
  deleted: boolean;
}

interface SyncChange {
  id: string;
  documentId: string;
  type: "create" | "update" | "delete";
  fields?: Record<string, unknown>;
  version: number;
  updatedBy: string;
  timestamp: number;
  optimistic: boolean;
  isReplay: boolean;
}

interface SyncConflict {
  documentId: string;
  localChange: SyncChange;
  remoteChange: SyncChange;
  resolved: SyncDocument;
}
```

## License

MIT
