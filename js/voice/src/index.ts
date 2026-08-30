/**
 * @nolag/voice
 *
 * Turns a live phone call into a NoLag room: the call publishes its transcript
 * and timings as they happen, and anything with access to the room can steer it
 * mid-conversation.
 *
 * Pair it with `@nolag/voice-engine`, which does the real-time audio work. This
 * package is only the coordination layer, and is small on purpose.
 */

export { NoLagVoice } from "./NoLagVoice.js";
export type {
  NoLagVoiceOptions,
  CallPublisher,
  CallWatcher,
} from "./NoLagVoice.js";

export {
  OrchestratorBridge,
  orchestratorPoolOptions,
  ORCHESTRATOR_ROOM,
  ORCHESTRATOR_CAPABILITY,
  ORCHESTRATOR_POOL,
} from "./orchestrator.js";
export type {
  OrchestratorBridgeOptions,
  OrchestratorRequest,
  OrchestratorAnswer,
  PendingAsk,
} from "./orchestrator.js";

export { orchestratedModel } from "./orchestrated-model.js";
export type {
  OrchestratedModelOptions,
  OrchestratedLines,
  OrchestratorAskEvent,
  VoiceFloor,
} from "./orchestrated-model.js";

export { createRoomProvisioner, callRoomSlug, callAgentId } from "./rooms.js";
export type { RoomProvisioner, RoomProvisionerOptions } from "./rooms.js";

export { VOICE_TOPICS } from "./types.js";
export type {
  CallInfo,
  CallEvent,
  CallEventName,
  CallControl,
  CallControlHandlers,
  CallWatchHandlers,
  TranscriptLine,
  TurnMetrics,
} from "./types.js";
