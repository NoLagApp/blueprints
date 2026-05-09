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

```typescript
import { NoLagSync } from "@nolag/sync";

const sync = new NoLagSync("YOUR_ACTOR_TOKEN", {
  username: "Alice",
});

await sync.connect();

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
collection.on("documentCreated", (change) => {
  console.log(`New doc: ${change.documentId}`);
});

collection.on("documentUpdated", (change) => {
  const doc = collection.getDocument(change.documentId);
  console.log(`Updated:`, doc.data);
});

// Handle conflicts
collection.on("conflict", (conflict) => {
  console.log("Conflict on", conflict.documentId);
  // Resolve manually or let last-write-wins
});
```

## API Reference

### `NoLagSync`

#### Constructor

```typescript
const sync = new NoLagSync(token: string, options?: NoLagSyncOptions);
```

**Options:**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `userId` | `string` | auto-generated | Unique user ID |
| `username` | `string` | — | Display name |
| `metadata` | `Record<string, unknown>` | — | Custom data |
| `collections` | `string[]` | — | Auto-join these collections on connect |
| `debug` | `boolean` | `false` | Enable debug logging |
| `reconnect` | `boolean` | `true` | Auto-reconnect on disconnect |

#### Methods

| Method | Returns | Description |
|--------|---------|-------------|
| `connect()` | `Promise<void>` | Connect to NoLag |
| `disconnect()` | `void` | Disconnect |
| `joinCollection(name)` | `SyncRoom` | Join a collection |
| `leaveCollection(name)` | `void` | Leave a collection |
| `getCollections()` | `SyncRoom[]` | Get all joined collections |
| `getOnlineCollaborators()` | `SyncCollaborator[]` | Get online collaborators |

#### Events

| Event | Payload | Description |
|-------|---------|-------------|
| `connected` | — | Connected |
| `disconnected` | — | Disconnected |
| `reconnected` | — | Reconnected |
| `error` | `Error` | Error |
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
| `getDocuments()` | `SyncDocument[]` | Get all documents |

#### Events

| Event | Payload | Description |
|-------|---------|-------------|
| `documentCreated` | `SyncChange` | Document created |
| `documentUpdated` | `SyncChange` | Document updated |
| `documentDeleted` | `SyncChange` | Document deleted |
| `localChange` | `SyncChange` | Your change confirmed |
| `conflict` | `SyncConflict` | Conflicting changes detected |
| `synced` | — | All changes synced |
| `collaboratorJoined` | `SyncCollaborator` | Collaborator joined |
| `collaboratorLeft` | `SyncCollaborator` | Collaborator left |
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
  resolved: boolean;
}
```

## License

MIT
