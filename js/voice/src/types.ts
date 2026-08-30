/**
 * The shape of what a voice call reports, and what can be sent back to it.
 *
 * These are declared structurally rather than imported from
 * `@nolag/voice-engine`, so a dashboard in a browser never has to install a
 * server-side package to get types. A `CallPublisher` is deliberately
 * compatible with the engine's session observer: hand one straight to a
 * VoiceSession and the call streams itself into the room.
 */

/** Topics on the call's room. Matches the Agents blueprint schema. */
export const VOICE_TOPICS = [
  "tasks",
  "results",
  "state",
  "events",
  "inbox",
  "tools",
  "approval",
] as const;

export interface CallInfo {
  callId: string;
  peer: string;
  outbound: boolean;
}

export interface TurnMetrics {
  sttMs: number;
  llmMs: number;
  firstAudioMs: number | null;
  clips: number;
  totalMs: number;
}

/** A line of the conversation, as it happens. */
export interface TranscriptLine {
  role: "caller" | "agent";
  text: string;
  /** "greeting", "reply", "filler", "scripted", "injected". */
  kind?: string;
  sttMs?: number;
  llmMs?: number;
  at: number;
}

export type CallEventName =
  | "call-started"
  | "call-ended"
  | "screening-detected"
  | "barge-in"
  | "turn-complete"
  | "error";

export interface CallEvent {
  event: CallEventName;
  at: number;
  [key: string]: unknown;
}

/** Instructions a supervisor can send to a live call. */
export type CallControl =
  | { type: "say"; text: string }
  | { type: "instruct"; text: string };

export interface CallControlHandlers {
  /** Speak this to the caller now. */
  onSay?: (text: string) => void;
  /** Add guidance the model sees from the next turn on, without speaking. */
  onInstruct?: (text: string) => void;
}

export interface CallWatchHandlers {
  onTranscript?: (line: TranscriptLine) => void;
  onEvent?: (event: CallEvent) => void;
}
