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

```typescript
import { NoLagQueue } from "@nolag/queue";

// --- Producer: adds jobs ---
const producer = new NoLagQueue("PRODUCER_TOKEN", { role: "producer" });
await producer.connect();

const queue = producer.joinQueue("image-processing");
queue.addJob({
  type: "resize",
  payload: { imageUrl: "https://example.com/photo.jpg", width: 800 },
  priority: "high",
});

// --- Worker: processes jobs ---
const worker = new NoLagQueue("WORKER_TOKEN", {
  role: "worker",
  concurrency: 3,
});
await worker.connect();

const workerQueue = worker.joinQueue("image-processing");

workerQueue.on("jobAdded", (job) => {
  const claimed = workerQueue.claimJob(job.id);
  if (claimed) {
    processImage(claimed.payload, (progress) => {
      workerQueue.reportProgress(job.id, progress);
    }).then((result) => {
      workerQueue.completeJob(job.id, result);
    }).catch((err) => {
      workerQueue.failJob(job.id, err.message);
    });
  }
});

// --- Monitor: watches progress ---
const monitor = new NoLagQueue("MONITOR_TOKEN", { role: "monitor" });
await monitor.connect();

const monitorQueue = monitor.joinQueue("image-processing");
monitorQueue.on("jobProgress", (p) => {
  updateProgressBar(p.jobId, p.progress);
});
monitorQueue.on("jobCompleted", (job) => {
  console.log(`Job ${job.id} done:`, job.result);
});
```

## API Reference

### `NoLagQueue`

#### Constructor

```typescript
const queue = new NoLagQueue(token: string, options?: NoLagQueueOptions);
```

**Options:**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `workerId` | `string` | auto-generated | Unique worker ID |
| `role` | `WorkerRole` | `'monitor'` | `'producer'`, `'worker'`, or `'monitor'` |
| `concurrency` | `number` | `1` | Max concurrent jobs (workers) |
| `metadata` | `Record<string, unknown>` | — | Custom data |
| `queues` | `string[]` | — | Auto-join these queues on connect |
| `maxJobCache` | `number` | `1000` | Max jobs kept in memory |
| `loadBalanceGroup` | `string` | — | Worker partitioning group |
| `debug` | `boolean` | `false` | Enable debug logging |
| `reconnect` | `boolean` | `true` | Auto-reconnect on disconnect |

#### Methods

| Method | Returns | Description |
|--------|---------|-------------|
| `connect()` | `Promise<void>` | Connect to NoLag |
| `disconnect()` | `void` | Disconnect |
| `joinQueue(name)` | `QueueRoom` | Join a queue |
| `leaveQueue(name)` | `void` | Leave a queue |
| `getQueues()` | `QueueRoom[]` | Get all joined queues |
| `getOnlineWorkers()` | `QueueWorker[]` | Get online workers |

#### Events

| Event | Payload | Description |
|-------|---------|-------------|
| `connected` | — | Connected |
| `disconnected` | — | Disconnected |
| `reconnected` | — | Reconnected |
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
