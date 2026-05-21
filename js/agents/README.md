# @nolag/agents

Multi-agent coordination SDK for [NoLag](https://nolag.app) — dispatch tasks, share state, observe decisions, gate actions with human approval, and invoke remote tools across connected agents.

## How It Works with NoLag

NoLag is a real-time messaging platform that handles WebSocket connections, message routing, persistence, and scaling. This SDK wraps the low-level [@nolag/js-sdk](https://www.npmjs.com/package/@nolag/js-sdk) and gives you a purpose-built multi-agent coordination API — task handoff, shared blackboard state, tool invocation, approval gates, and observability — without needing to manage topics or subscriptions yourself.

### Getting Your Token

1. Sign up at [nolag.app](https://nolag.app)
2. Create a new **project** in the portal
3. Choose the **Agents** blueprint when creating an app — this pre-configures the topics (`tasks`, `results`, `state`, `events`, `inbox`, `tools`, `approval`), rooms, and lobbies your agent workflow needs
4. Go to the app's **Tokens** page and generate an **actor token** for each agent
5. Use that token when connecting with this SDK

Each token identifies a unique agent (actor) in NoLag. The blueprint handles all the infrastructure setup — you just write your agent logic.

## Install

```bash
npm install @nolag/js-sdk @nolag/agents
```

## Quick Start

```typescript
import { NoLagAgents, Handoff } from "@nolag/agents";

// --- Orchestrator ---
const orchestrator = new NoLagAgents("ORCHESTRATOR_TOKEN", {
  agentId: "orchestrator-1",
  presence: { name: "orchestrator-1", role: "orchestrator" },
});
await orchestrator.connect();

const room = orchestrator.room("default-workflow");
const handoff = new Handoff(room);

// Dispatch a task and wait for the result
const result = await handoff.dispatch("summarize", { text: "..." }, {
  waitForResult: true,
  timeout: 30_000,
});
console.log("Result:", result?.payload);

// --- Worker ---
const worker = new NoLagAgents("WORKER_TOKEN", {
  agentId: "worker-1",
  presence: {
    name: "worker-1",
    role: "agent",
    capabilities: ["summarize"],
  },
});
await worker.connect();

const workerRoom = worker.room("default-workflow");
const workerHandoff = new Handoff(workerRoom);

workerHandoff.onTask(["summarize"], async (task, respond) => {
  const summary = await summarize(task.payload.text);
  respond("success", { summary });
});
```

## Coordination Patterns

### Handoff — Task Dispatch & Results

Dispatch tasks to agents by capability. The SDK uses presence-based service discovery to verify a capable agent is connected before dispatching.

```typescript
import { Handoff } from "@nolag/agents";

const handoff = new Handoff(room);

// Orchestrator: dispatch work
const result = await handoff.dispatch("translate", { text, lang: "es" }, {
  waitForResult: true,
  priority: "high",
});

// Worker: handle tasks
handoff.onTask(["translate"], async (task, respond) => {
  const translated = await translate(task.payload.text, task.payload.lang);
  respond("success", { translated });
});

// Check who can handle a capability
const agents = handoff.getCapableAgents("translate");
```

### Blackboard — Shared State

Read and write key-value pairs visible to all agents in the room. State is retained so new agents receive current values on join.

```typescript
import { Blackboard } from "@nolag/agents";

const board = new Blackboard(room, agentId);

// Write state
board.set("progress", { completed: 3, total: 10 });

// Read state
const progress = board.get("progress");

// React to changes
board.onChange("progress", (envelope) => {
  console.log(`Progress updated by ${envelope.updatedBy}:`, envelope.value);
});
```

### Tools — Remote Tool Invocation

Register tool handlers on one agent, invoke them from another. Uses correlated request/response over pub/sub.

```typescript
import { Tools } from "@nolag/agents";

const tools = new Tools(room, agentId);

// Tool server: register handlers
tools.register("web_search", async (args) => {
  return await search(args.query as string);
});

// Caller: invoke a remote tool
const response = await tools.invoke("web_search", { query: "NoLag docs" });
console.log(response.result);
```

### Approve — Human-in-the-Loop Gates

Request approval before taking actions. Humans or supervisor agents approve, reject, or defer.

```typescript
import { Approve } from "@nolag/agents";

const approve = new Approve(room, agentId);

// Agent: request approval
const response = await approve.request("delete_record", { recordId: 42 }, {
  urgency: "high",
  timeout: 60_000,
});
if (response.decision === "approved") {
  await deleteRecord(42);
}

// Human/supervisor: handle approval requests
approve.onRequest((request, respond) => {
  console.log(`Action: ${request.action}`, request.context);
  respond("approved", "Looks good");
});
```

### Inbox — Direct Agent Messaging

Send messages directly to a specific agent. Messages are addressed by agent ID.

```typescript
import { Inbox } from "@nolag/agents";

const inbox = new Inbox(room, agentId);

// Send a direct message
inbox.send("worker-2", { instruction: "re-process item 7" });

// Receive messages
inbox.onMessage((msg) => {
  console.log(`From ${msg.from}:`, msg.payload);
});
```

### Observe — Observability Events

Emit structured events for monitoring dashboards. Events have severity, category, and agent attribution.

```typescript
import { Observe } from "@nolag/agents";

const observe = new Observe(room, agentId);

// Emit events
observe.emit("task.completed", { taskId: "t-1", duration: 1200 }, "info");
observe.emit("rate_limit", { service: "openai" }, "warning");

// Listen for events (with optional filters)
observe.on((event) => {
  console.log(`[${event.severity}] ${event.category}:`, event.payload);
}, { severity: "warning" });
```

## API Reference

### `NoLagAgents`

#### Constructor

```typescript
const agents = new NoLagAgents(token: string, options?: NoLagAgentsOptions);
```

**Options:**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `appName` | `string` | `"agents"` | App slug for the agents workflow |
| `agentId` | `string` | auto-generated | Unique agent ID |
| `debug` | `boolean` | `false` | Enable debug logging |
| `rooms` | `string[]` | `["default-workflow"]` | Rooms to auto-join on connect |
| `lobby` | `string` | — | Lobby slug for cross-room presence observation |
| `presence` | `AgentPresenceData` | — | Presence data advertised to other agents |
| `clientOptions` | `Partial<NoLagOptions>` | — | Additional options passed to `@nolag/js-sdk` |

#### Methods

| Method | Returns | Description |
|--------|---------|-------------|
| `connect()` | `Promise<void>` | Connect to NoLag and join configured rooms |
| `disconnect()` | `void` | Disconnect and clean up |
| `room(name)` | `AgentRoom` | Get or create a room (auto-joins if not already joined) |
| `subscribeLobby(slug)` | `Promise<Record>` | Subscribe to a lobby for cross-room presence |

#### Properties

| Property | Type | Description |
|----------|------|-------------|
| `agentId` | `string` | The agent's unique ID |
| `connected` | `boolean` | Whether currently connected |
| `rooms` | `ReadonlyMap<string, AgentRoom>` | All joined rooms |

#### Events

| Event | Payload | Description |
|-------|---------|-------------|
| `connected` | — | Connected to NoLag |
| `disconnected` | `reason: string` | Disconnected |
| `reconnected` | — | Reconnected after disconnect |
| `error` | `Error` | Connection or protocol error |

### `AgentRoom`

#### Methods

| Method | Returns | Description |
|--------|---------|-------------|
| `getConnectedAgents()` | `ConnectedAgent[]` | Get all connected agents |
| `findAgents(capability)` | `ConnectedAgent[]` | Find agents with a capability |
| `hasCapability(capability)` | `boolean` | Check if any agent has a capability |
| `getAvailableCapabilities()` | `string[]` | Get all capabilities across connected agents |
| `setPresence(data)` | `void` | Update this agent's presence |
| `fetchPresence()` | `Promise<ConnectedAgent[]>` | Fetch current presence snapshot |
| `publishTask(envelope)` | `void` | Publish to tasks topic |
| `publishResult(envelope)` | `void` | Publish to results topic |
| `publishState(data)` | `void` | Publish to state topic (retained) |
| `publishEvent(data)` | `void` | Publish to events topic |
| `publishInbox(data)` | `void` | Publish to inbox topic |
| `publishTools(data)` | `void` | Publish to tools topic |
| `publishApproval(data)` | `void` | Publish to approval topic (retained) |

#### Properties

| Property | Type | Description |
|----------|------|-------------|
| `name` | `string` | Room name |
| `agentId` | `string` | This agent's ID |
| `context` | `RoomContext` | Underlying `@nolag/js-sdk` room context |

#### Events

| Event | Payload | Description |
|-------|---------|-------------|
| `task` | `TaskEnvelope` | Task dispatched |
| `result` | `ResultEnvelope` | Task result received |
| `stateChange` | `StateEnvelope` | Shared state updated |
| `event` | `EventEnvelope` | Observability event |
| `inbox` | `Record<string, unknown>` | Inbox message received |
| `approvalRequest` | `ApprovalRequestEnvelope` | Approval requested |
| `approvalResponse` | `ApprovalResponseEnvelope` | Approval decision received |
| `toolRequest` | `ToolRequestEnvelope` | Tool invocation requested |
| `toolResponse` | `ToolResponseEnvelope` | Tool result received |
| `presenceJoin` | `actorId, AgentPresenceData` | Agent joined |
| `presenceLeave` | `actorId` | Agent left |
| `presenceUpdate` | `actorId, AgentPresenceData` | Agent presence updated |

## Types

```typescript
interface AgentPresenceData {
  name: string;
  role: string; // "orchestrator" | "agent" | "observer" | "human" | "tool-server"
  capabilities?: string[];
  metadata?: Record<string, unknown>;
}

interface ConnectedAgent {
  actorId: string;
  name: string;
  role: string;
  capabilities: string[];
  metadata?: Record<string, unknown>;
  connectedAt: number;
}

interface TaskEnvelope {
  type: "task";
  taskId: string;
  correlationId: string;
  capability: string;
  priority: "low" | "medium" | "high" | "critical";
  payload: Record<string, unknown>;
  tags?: string[];
  metadata?: Record<string, unknown>;
  createdAt: number;
  createdBy?: string;
  timeout?: number;
}

interface ResultEnvelope {
  type: "result";
  taskId: string;
  correlationId: string;
  status: "success" | "error" | "partial";
  payload: Record<string, unknown>;
  error?: { code: string; message: string };
  completedAt: number;
  completedBy?: string;
}

interface StateEnvelope {
  type: "state";
  key: string;
  value: unknown;
  version: number;
  updatedAt: number;
  updatedBy: string;
}

interface EventEnvelope {
  type: "event";
  eventId: string;
  severity: "debug" | "info" | "warning" | "error" | "critical";
  category: string;
  payload: Record<string, unknown>;
  timestamp: number;
  emittedBy: string;
}
```

## License

MIT
