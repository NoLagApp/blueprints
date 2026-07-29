# @nolag/queue

Real-time job queue SDK for [NoLag](https://nolag.app) — job lifecycle, progress tracking, and worker management.

## How It Works with NoLag

NoLag is a real-time messaging platform that handles WebSocket connections, message routing, persistence, and scaling. This SDK wraps the low-level [@nolag/js-sdk](https://www.npmjs.com/package/@nolag/js-sdk) and gives you a purpose-built queue API — add jobs, claim and process them with workers, track progress in real-time — without managing topics or subscriptions yourself.

### Getting Your Token

1. Sign up at [nolag.app](https://nolag.app)
2. Create a new **project** in the portal
3. Choose the **Queue** blueprint when creating an app — this pre-configures the topics (`jobs`, `_progress`) and settings your queue needs
4. Go to the app's **Tokens** page and generate an **actor token**
5. Use that token when connecting with this SDK

Each token identifies a unique worker, producer, or monitor (actor) in NoLag. The blueprint handles all the infrastructure setup — you just build your queue logic.

## Install

```bash
npm install @nolag/js-sdk @nolag/queue
```

## Quick Start

The app owns one core NoLag client; wrappers attach to it. Any number of
wrapper SDKs (queue, chat, notify, ...) can share the same connection as
long as each uses its own app.

```typescript
import { NoLag } from "@nolag/js-sdk";
import { NoLagQueue } from "@nolag/queue";

// One client for the whole app. In a browser, use a token provider so the
// SDK can mint fresh short-lived client tokens from your backend.
const client = NoLag(async () => (await (await fetch("/api/nolag-token")).json()).token);

// --- Worker: processes jobs ---
const queue = new NoLagQueue({ client, role: "worker", concurrency: 3 });

await client.connect();   // the app owns the connection
await queue.ready();      // wrapper setup done (identity, presence, queues)

const room = queue.joinQueue("image-processing");

room.on("jobAdded", (job) => {
  const claimed = room.claimJob(job.id);
  if (claimed) {
    processImage(claimed.payload, (progress) => {
      room.reportProgress(job.id, progress);
    }).then((result) => {
      room.completeJob(job.id, result);
    }).catch((err) => {
      room.failJob(job.id, err.message);
    });
  }
});

// --- Producer: adds jobs (uses the SAME client, its own wrapper) ---
const producer = new NoLagQueue({ client, role: "producer" });
await producer.ready();
producer.joinQueue("image-processing").addJob({
  type: "resize",
  payload: { imageUrl: "https://example.com/photo.jpg", width: 800 },
  priority: "high",
});

// See who's online
queue.on("workerOnline", (w) => console.log(`Worker ${w.workerId} online`));

// Teardown: the wrapper releases its handlers and topics; the app closes
// the socket (never the other way around).
queue.detach();
client.disconnect();
```

## Lifecycle

- **Construction = attach.** The wrapper wires its handlers onto the injected
  client immediately. If the client is already connected, setup runs on the
  next microtask; otherwise it runs when the client's `connect` event fires.
- **`ready()`** resolves once the first setup completed (identity, online
  lobby, configured queues). Auth failures surface via your own
  `await client.connect()`, not via `ready()`.
- **Reconnects are automatic.** The wrapper restores worker presence and
  reconciles the online-worker list, emitting only real deltas.
- **`detach()`** removes exactly this wrapper's handlers and topics and never
  touches the socket. It is terminal: construct a new instance to re-attach.
  Detach while the client is still connected so server-side unsubscribes go
  through. In frameworks, call it from your dispose hook (`onUnmounted`,
  HMR dispose).
- **One wrapper per (client, app).** Sharing a client across wrappers of
  DIFFERENT apps is the intended pattern; two wrappers on the same app would
  collide on topics and presence (the SDK warns if you do this).

## API Reference

### `NoLagQueue`

#### Constructor

```typescript
const queue = new NoLagQueue(options: NoLagQueueOptions);
```

**Options:**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `client` | `NoLagSocket` | *required* | The injected core NoLag client |
| `workerId` | `string` | auto-generated | Unique worker ID |
| `role` | `WorkerRole` | `'monitor'` | `'producer'`, `'worker'`, or `'monitor'` |
| `concurrency` | `number` | `1` | Max concurrent jobs (workers) |
| `metadata` | `Record<string, unknown>` | — | Custom data |
| `appName` | `string` | `'queue'` | NoLag app for topic prefixes |
| `queues` | `string[]` | — | Auto-join these queues on connect |
| `maxJobCache` | `number` | `1000` | Max jobs kept in memory |
| `loadBalanceGroup` | `string` | — | Worker partitioning group (subscribe-level) |
| `debug` | `boolean` | `false` | Enable debug logging |

#### Methods

| Method | Returns | Description |
|--------|---------|-------------|
| `ready()` | `Promise<void>` | Resolves when wrapper setup completed |
| `detach()` | `void` | Release handlers and topics (terminal; never closes the socket) |
| `joinQueue(name)` | `QueueRoom` | Join a queue |
| `leaveQueue(name)` | `void` | Leave a queue |
| `getQueues()` | `QueueRoom[]` | Get all joined queues |
| `getOnlineWorkers()` | `QueueWorker[]` | Get online workers |

#### Properties

| Property | Type | Description |
|----------|------|-------------|
| `connected` | `boolean` | Whether currently connected |
| `localWorker` | `QueueWorker \| null` | The local worker |
| `queues` | `Map<string, QueueRoom>` | All joined queues |

#### Events

| Event | Payload | Description |
|-------|---------|-------------|
| `connected` | — | Connected |
| `disconnected` | `string` | Disconnected |
| `reconnecting` | — | Reconnect attempt started |
| `reconnected` | — | Reconnected after disconnect |
| `error` | `Error` | Error |
| `workerOnline` | `QueueWorker` | Worker came online |
| `workerOffline` | `QueueWorker` | Worker went offline |

### `QueueRoom`

#### Methods

| Method | Returns | Description |
|--------|---------|-------------|
| `addJob(options)` | `Job` | Add a job (producer only) |
| `claimJob(jobId)` | `Job \| null` | Claim a pending job (worker only) |
| `reportProgress(jobId, progress)` | `void` | Report progress 0–100 (worker only) |
| `completeJob(jobId, result?)` | `Job \| null` | Mark job complete (worker only) |
| `failJob(jobId, error)` | `Job \| null` | Mark job failed (worker only) |
| `retryJob(jobId)` | `Job \| null` | Retry a failed job (worker only) |
| `getJob(jobId)` | `Job \| undefined` | Get a specific job |
| `getJobs(filter?)` | `Job[]` | Get jobs, optionally filtered |
| `getWorkers()` | `QueueWorker[]` | Get workers in this queue |

#### Events

| Event | Payload | Description |
|-------|---------|-------------|
| `jobAdded` | `Job` | New job added |
| `jobClaimed` | `Job` | Job claimed by a worker |
| `jobProgress` | `JobProgress` | Job progress updated |
| `jobCompleted` | `Job` | Job completed |
| `jobFailed` | `Job` | Job failed |
| `jobRetrying` | `Job` | Job being retried |
| `workerJoined` | `QueueWorker` | Worker joined |
| `workerLeft` | `QueueWorker` | Worker left |
| `replayStart` / `replayEnd` | — | Job replay |

## Types

```typescript
interface Job {
  id: string;
  type: string;
  payload?: Record<string, unknown>;
  priority: JobPriority;
  status: JobStatus;
  progress: number;
  result?: unknown;
  error?: string;
  attempts: number;
  maxAttempts: number;
  claimedBy?: string;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  isReplay: boolean;
}

type JobStatus = "pending" | "claimed" | "active" | "completed" | "failed";
type JobPriority = "low" | "normal" | "high" | "critical";

interface QueueWorker {
  workerId: string;
  actorTokenId: string;
  role: WorkerRole;
  activeJobs: number;
  concurrency: number;
  metadata?: Record<string, unknown>;
  joinedAt: number;
  isLocal: boolean;
}

interface JobProgress {
  jobId: string;
  progress: number;
  workerId: string;
  timestamp: number;
}
```

## License

MIT
