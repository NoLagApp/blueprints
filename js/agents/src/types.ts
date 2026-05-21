import type { NoLagOptions } from "@nolag/js-sdk";

// ============================================================
// Options
// ============================================================

export interface NoLagAgentsOptions {
  /** NoLag app slug for the agents workflow */
  appName?: string;
  /** Unique agent ID (defaults to a generated UUID) */
  agentId?: string;
  /** Enable debug logging */
  debug?: boolean;
  /** Rooms to auto-join on connect */
  rooms?: string[];
  /** Lobby slug to subscribe to for cross-room presence observation */
  lobby?: string;
  /** Agent presence data (advertised to other agents in the room) */
  presence?: AgentPresenceData;
  /** Additional NoLag client options */
  clientOptions?: Partial<NoLagOptions>;
}

export interface ResolvedAgentsOptions {
  appName: string;
  agentId: string;
  debug: boolean;
  rooms: string[];
  lobby?: string;
  presence?: AgentPresenceData;
  clientOptions?: Partial<NoLagOptions>;
}

// ============================================================
// Envelopes
// ============================================================

export interface TaskEnvelope {
  type: "task";
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
  taskId: string;
  correlationId: string;
  status: "success" | "error" | "partial";
  payload: Record<string, unknown>;
  error?: { code: string; message: string };
  completedAt: number;
  completedBy?: string;
}

export interface StateEnvelope {
  type: "state";
  key: string;
  value: unknown;
  version: number;
  updatedAt: number;
  updatedBy: string;
}

export interface EventEnvelope {
  type: "event";
  eventId: string;
  severity: "debug" | "info" | "warning" | "error" | "critical";
  category: string;
  payload: Record<string, unknown>;
  timestamp: number;
  emittedBy: string;
}

export interface ApprovalRequestEnvelope {
  type: "approval_request";
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
  requestId: string;
  correlationId: string;
  decision: "approved" | "rejected" | "deferred";
  reason?: string;
  respondedBy: string;
  respondedAt: number;
}

export interface ToolRequestEnvelope {
  type: "tool_request";
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
  requestId: string;
  correlationId: string;
  status: "success" | "error";
  result: unknown;
  error?: { code: string; message: string };
  respondedBy?: string;
  respondedAt: number;
}

// ============================================================
// Presence
// ============================================================

export interface AgentPresenceData {
  /** Agent display name */
  name: string;
  /** Agent role: orchestrator, agent, observer, human, tool-server */
  role: string;
  /** Agent capabilities (for task routing) */
  capabilities?: string[];
  /** Custom metadata */
  metadata?: Record<string, unknown>;
}

// ============================================================
// Events
// ============================================================

export interface AgentClientEvents {
  connected: [];
  disconnected: [reason: string];
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
