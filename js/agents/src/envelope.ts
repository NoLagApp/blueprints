import { generateId, createTimestamp } from "./utils";
import { AGENTS_PROTOCOL_VERSION } from "./constants";
import type {
  TaskEnvelope,
  ResultEnvelope,
  StateEnvelope,
  EventEnvelope,
  ApprovalRequestEnvelope,
  ApprovalResponseEnvelope,
  ToolRequestEnvelope,
  ToolResponseEnvelope,
} from "./types";

export function createTaskEnvelope(
  capability: string,
  payload: Record<string, unknown>,
  options?: {
    tags?: string[];
    priority?: TaskEnvelope["priority"];
    timeout?: number;
    replyTo?: string;
    metadata?: Record<string, unknown>;
    createdBy?: string;
  },
): TaskEnvelope {
  return {
    type: "task",
    protocol: AGENTS_PROTOCOL_VERSION,
    taskId: generateId(),
    correlationId: generateId(),
    replyTo: options?.replyTo,
    capability,
    payload,
    tags: options?.tags,
    priority: options?.priority ?? "medium",
    metadata: options?.metadata,
    createdAt: createTimestamp(),
    createdBy: options?.createdBy,
    timeout: options?.timeout,
  };
}

export function createResultEnvelope(
  taskId: string,
  correlationId: string,
  status: ResultEnvelope["status"],
  payload: Record<string, unknown>,
  error?: { code: string; message: string },
  completedBy?: string,
  replyTo?: string,
): ResultEnvelope {
  return {
    type: "result",
    protocol: AGENTS_PROTOCOL_VERSION,
    correlationId,
    taskId,
    status,
    payload,
    error,
    completedAt: createTimestamp(),
    completedBy,
    replyTo,
  };
}

export function createStateEnvelope(
  key: string,
  value: unknown,
  version: number,
  updatedBy: string,
): StateEnvelope {
  return {
    type: "state",
    protocol: AGENTS_PROTOCOL_VERSION,
    key,
    value,
    version,
    updatedBy,
    updatedAt: createTimestamp(),
  };
}

export function createEventEnvelope(
  category: string,
  emittedBy: string,
  payload: Record<string, unknown>,
  severity: EventEnvelope["severity"] = "info",
): EventEnvelope {
  return {
    type: "event",
    protocol: AGENTS_PROTOCOL_VERSION,
    eventId: generateId(),
    severity,
    category,
    emittedBy,
    payload,
    timestamp: createTimestamp(),
  };
}

export function createApprovalRequest(
  action: string,
  context: unknown,
  requestedBy: string,
  options?: {
    urgency?: ApprovalRequestEnvelope["urgency"];
    expiresAt?: number;
  },
): ApprovalRequestEnvelope {
  return {
    type: "approval_request",
    protocol: AGENTS_PROTOCOL_VERSION,
    requestId: generateId(),
    correlationId: generateId(),
    action,
    context,
    urgency: options?.urgency ?? "medium",
    requestedBy,
    requestedAt: createTimestamp(),
    expiresAt: options?.expiresAt,
  };
}

export function createApprovalResponse(
  requestId: string,
  correlationId: string,
  decision: ApprovalResponseEnvelope["decision"],
  respondedBy: string,
  reason?: string,
): ApprovalResponseEnvelope {
  return {
    type: "approval_response",
    protocol: AGENTS_PROTOCOL_VERSION,
    requestId,
    correlationId,
    decision,
    respondedBy,
    reason,
    respondedAt: createTimestamp(),
  };
}

export function createToolRequest(
  toolName: string,
  args: Record<string, unknown>,
  requestedBy: string,
  options?: { replyTo?: string },
): ToolRequestEnvelope {
  return {
    type: "tool_request",
    protocol: AGENTS_PROTOCOL_VERSION,
    requestId: generateId(),
    correlationId: generateId(),
    replyTo: options?.replyTo,
    toolName,
    arguments: args,
    requestedBy,
    requestedAt: createTimestamp(),
  };
}

export function createToolResponse(
  requestId: string,
  correlationId: string,
  status: ToolResponseEnvelope["status"],
  result: unknown,
  error?: { code: string; message: string },
  respondedBy?: string,
  replyTo?: string,
): ToolResponseEnvelope {
  return {
    type: "tool_response",
    protocol: AGENTS_PROTOCOL_VERSION,
    requestId,
    correlationId,
    status,
    result,
    error,
    respondedBy,
    respondedAt: createTimestamp(),
    replyTo,
  };
}
