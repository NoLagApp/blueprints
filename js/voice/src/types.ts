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

// ============ Filters ============

/**
 * A single subscription filter value.
 *
 * A plain string is an OR term: `['a', 'b']` matches either. A nested array is
 * an AND group: `[['a', 'b']]` matches only what was published tagged with
 * both.
 */
export type FilterValue = string | string[];

/**
 * The category a call's transcript lines are published under, and the value to
 * filter on to receive only the conversation.
 */
export const CALL_TRANSCRIPT = "call.transcript";

/** Prefix shared by every call lifecycle event category. */
export const CALL_EVENT_PREFIX = "call.";

/**
 * The filter value for one call event — `callEventCategory('turn-complete')`
 * is `'call.turn-complete'`.
 */
export function callEventCategory(event: CallEventName): string {
  return `${CALL_EVENT_PREFIX}${event}`;
}

/** Options for `NoLagVoice.watchCall()`. */
export interface WatchCallOptions {
  /**
   * Only receive events published under one of these categories — use
   * `CALL_TRANSCRIPT` and `callEventCategory(name)` to name them.
   *
   * A transcript is the loud part of a call: one line per utterance, against a
   * handful of lifecycle events. A dashboard that only plots turn metrics can
   * skip the transcript entirely rather than receiving and discarding it.
   *
   * Scoped to the events topic, so steering via `say`/`instruct` keeps working.
   * Omit (or pass an empty array) to receive everything.
   *
   * @example
   * ```ts
   * // transcript only
   * voice.watchCall(id, handlers, { filters: [CALL_TRANSCRIPT] });
   * // lifecycle only
   * voice.watchCall(id, handlers, {
   *   filters: [callEventCategory('call-ended'), callEventCategory('error')],
   * });
   * ```
   */
  filters?: FilterValue[];
}

/** Options for `NoLagVoice.publishCall()`. */
export interface PublishCallOptions {
  /**
   * Tag each published event with its category so watchers can subscribe to
   * just the parts they want (default: true).
   *
   * Safe to leave on: a watcher with no filters receives tagged events exactly
   * as before. Set it to false only to reproduce pre-filter wire behaviour.
   */
  tagCategories?: boolean;
}

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
