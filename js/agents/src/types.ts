import type { NoLagSocket } from "@nolag/js-sdk";

// ============================================================
// Options
// ============================================================

export interface NoLagAgentsOptions {
  /**
   * The injected core NoLag client. The app owns and connects it; the wrapper
   * attaches to it at construction and releases it via `detach()`. Required.
   */
  client: NoLagSocket;
  /** NoLag app slug for the agents workflow */
  appName?: string;
  /** Unique agent ID (defaults to a generated UUID) */
  agentId?: string;
  /** Agent display name (advertised via presence; defaults to agentId) */
  name?: string;
  /** Agent role: orchestrator, agent, observer, human, tool-server (defaults to "agent") */
  role?: string;
  /** Enable debug logging */
  debug?: boolean;
  /** Rooms to auto-join on connect */
  rooms?: string[];
  /** Lobby slug to subscribe to for cross-room presence observation */
  lobby?: string;
  /** Agent presence data (advertised to other agents in the room) */
  presence?: AgentPresenceData;
}

export interface ResolvedAgentsOptions {
  appName: string;
  agentId: string;
  name?: string;
  role?: string;
  debug: boolean;
  rooms: string[];
  lobby?: string;
  presence?: AgentPresenceData;
}

// ============================================================
// Envelopes
// ============================================================

export interface TaskEnvelope {
  type: "task";
  /** Agents-protocol version of the sender (absent = 1, pre-directed-replies) */
  protocol?: number;
  taskId: string;
  correlationId: string;
  replyTo?: string;
  capability: string;
  priority: "low" | "medium" | "high" | "critical";
  payload: Record<string, unknown>;
  tags?: string[];
  metadata?: Record<string, unknown>;
  createdAt: number;
  createdBy?: string;
  timeout?: number;
}

export interface ResultEnvelope {
  type: "result";
  /** Agents-protocol version of the sender (absent = 1, pre-directed-replies) */
  protocol?: number;
  taskId: string;
  correlationId: string;
  status: "success" | "error" | "partial";
  payload: Record<string, unknown>;
  error?: { code: string; message: string };
  completedAt: number;
  completedBy?: string;
  /** Reply address (agentId of the dispatcher) — used as the publish filter for directed delivery */
  replyTo?: string;
}

export interface StateEnvelope {
  type: "state";
  /** Agents-protocol version of the sender (absent = 1, pre-directed-replies) */
  protocol?: number;
  key: string;
  value: unknown;
  version: number;
  updatedAt: number;
  updatedBy: string;
}

export interface EventEnvelope {
  type: "event";
  /** Agents-protocol version of the sender (absent = 1, pre-directed-replies) */
  protocol?: number;
  eventId: string;
  severity: "debug" | "info" | "warning" | "error" | "critical";
  category: string;
  payload: Record<string, unknown>;
  timestamp: number;
  emittedBy: string;
}

export interface ApprovalRequestEnvelope {
  type: "approval_request";
  /** Agents-protocol version of the sender (absent = 1, pre-directed-replies) */
  protocol?: number;
  requestId: string;
  correlationId: string;
  action: string;
  context: unknown;
  urgency: "low" | "medium" | "high" | "critical";
  expiresAt?: number;
  requestedBy: string;
  requestedAt: number;
}

export interface ApprovalResponseEnvelope {
  type: "approval_response";
  /** Agents-protocol version of the sender (absent = 1, pre-directed-replies) */
  protocol?: number;
  requestId: string;
  correlationId: string;
  decision: "approved" | "rejected" | "deferred";
  reason?: string;
  respondedBy: string;
  respondedAt: number;
}

export interface ToolRequestEnvelope {
  type: "tool_request";
  /** Agents-protocol version of the sender (absent = 1, pre-directed-replies) */
  protocol?: number;
  requestId: string;
  correlationId: string;
  replyTo?: string;
  toolName: string;
  arguments: Record<string, unknown>;
  requestedBy: string;
  requestedAt: number;
}

export interface ToolResponseEnvelope {
  type: "tool_response";
  /** Agents-protocol version of the sender (absent = 1, pre-directed-replies) */
  protocol?: number;
  requestId: string;
  correlationId: string;
  status: "success" | "error";
  result: unknown;
  error?: { code: string; message: string };
  respondedBy?: string;
  respondedAt: number;
  /** Reply address (agentId of the requester) — used as the publish filter for directed delivery */
  replyTo?: string;
}

// ============================================================
// Presence
// ============================================================

export interface AgentPresenceData {
  /** Agent display name */
  name: string;
  /** Agent role: orchestrator, agent, observer, human, tool-server */
  role: string;
  /** Agents-protocol version (auto-injected by the SDK; absent = 1) */
  protocol?: number;
  /** Agent capabilities (for task routing) */
  capabilities?: string[];
  /** Custom metadata */
  metadata?: Record<string, unknown>;
  /**
   * Persistent Presence: keep a durable, discoverable, wakeable presence record
   * even while the agent is disconnected (e.g. scaled to zero). Requires a broker
   * with the feature; ignored otherwise.
   */
  persistent?: boolean;
  /** Persistent Presence: where NoLag fires the HMAC-signed wake webhook. */
  wake?: { url: string; timeoutMs?: number; enabled?: boolean };
}

// ============================================================
// Events
// ============================================================

export interface AgentClientEvents {
  connected: [];
  disconnected: [reason: string];
  reconnecting: [];
  reconnected: [];
  error: [error: Error];
}

export interface AgentRoomEvents {
  task: [envelope: TaskEnvelope];
  result: [envelope: ResultEnvelope];
  stateChange: [envelope: StateEnvelope];
  event: [envelope: EventEnvelope];
  inbox: [envelope: Record<string, unknown>];
  approvalRequest: [envelope: ApprovalRequestEnvelope];
  approvalResponse: [envelope: ApprovalResponseEnvelope];
  toolRequest: [envelope: ToolRequestEnvelope];
  toolResponse: [envelope: ToolResponseEnvelope];
  presenceJoin: [actorId: string, data: AgentPresenceData];
  presenceLeave: [actorId: string];
  presenceUpdate: [actorId: string, data: AgentPresenceData];
}


/**
 * The topics an agent room can filter.
 *
 * `results` is deliberately absent: it carries directed replies, routed by the
 * recipient's agentId, and repointing its filters would strand every pending
 * task result and tool response.
 */
export type AgentFilterTopic =
  | "tasks"
  | "tools"
  | "state"
  | "events"
  | "inbox"
  | "approval";

/** Scope a filter call to one topic instead of all of them. */
export interface AgentFilterOptions {
  /** Which topic to filter. Omit to apply the call to every filterable topic. */
  topic?: AgentFilterTopic;
}

/** Publish-side filter options for an agent message. */
export interface AgentPublishOptions {
  /**
   * Route this message to agents filtering on this value — for tasks, the
   * capability that handles it. Agents subscribed without filters still
   * receive it.
   */
  filter?: string;
  /**
   * AND composite filter — reaches only agents filtering on all of these
   * values together. Ignored when `filter` is also set.
   */
  filters?: string[];
}

/** Options for `NoLagAgents.room()`. */
export interface JoinAgentRoomOptions {
  /**
   * Only receive messages published with one of these filter values. For a
   * worker these are its capabilities, which moves capability matching from
   * client-side discards to server-side routing.
   *
   * With load balancing on, every worker in a pool must use the same filter
   * shape: the broker treats a wildcard subscription and a filtered one as
   * separate share groups, so a mixed pool delivers each task twice.
   *
   * Does not affect `results`, which stays keyed to this agent's id.
   */
  filters?: FilterValue[];
}

// ============ Filters ============

/**
 * A single subscription filter value.
 *
 * A plain string is an OR term: `['alice', 'bob']` matches either. A nested
 * array is an AND group: `[['alice', 'admin']]` matches only what was
 * published tagged with both.
 */
export type FilterValue = string | string[];
