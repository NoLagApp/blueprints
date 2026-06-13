/**
 * @nolag/agents
 * Multi-agent coordination SDK for Node.js
 */

export { NoLagAgents } from "./NoLagAgents";
export { AgentRoom, type ConnectedAgent } from "./AgentRoom";
export { EventEmitter } from "./EventEmitter";
export { IncompatibleProtocolError } from "./errors";
export { AGENTS_PROTOCOL_VERSION } from "./constants";
export { CorrelationManager } from "./correlation";

// Patterns
export { Handoff } from "./patterns/handoff";
export { Inbox } from "./patterns/inbox";
export { Blackboard } from "./patterns/blackboard";
export { Observe } from "./patterns/observe";
export { Approve } from "./patterns/approve";
export { Tools } from "./patterns/tools";

// Tags
export { TAG_PREFIX, TAG_FLAGS, tag } from "./tags";

// Envelope helpers
export {
  createTaskEnvelope,
  createResultEnvelope,
  createStateEnvelope,
  createEventEnvelope,
  createApprovalRequest,
  createApprovalResponse,
  createToolRequest,
  createToolResponse,
} from "./envelope";

// Types
export type {
  NoLagAgentsOptions,
  TaskEnvelope,
  ResultEnvelope,
  StateEnvelope,
  EventEnvelope,
  ApprovalRequestEnvelope,
  ApprovalResponseEnvelope,
  ToolRequestEnvelope,
  ToolResponseEnvelope,
  AgentPresenceData,
  AgentClientEvents,
  AgentRoomEvents,
} from "./types";
