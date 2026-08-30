/**
 * Gives the model in the conversation one way to ask for help, and makes the
 * waiting sound like a person rather than a hang.
 *
 * ## Why the tool is in-band text and not a function call
 *
 * The voice engine's model interface streams: synthesis of the first finished
 * sentence starts while the model is still writing, and that head start is most
 * of what makes the agent feel responsive. A function-calling round trip has to
 * complete before you know whether it was a call or an answer, which throws the
 * head start away on every turn, including the great majority that never need
 * the orchestrator at all.
 *
 * So the ask travels in the reply itself, as `[[ask: ...]]`, and is filtered out
 * of what gets spoken. Turns that do not ask cost exactly nothing, and it works
 * with any provider rather than only those with a tool-calling API.
 *
 * The cost is that a small model can garble the marker. That fails safe: an
 * unrecognised marker is stripped from speech rather than read out, and the
 * turn continues without help.
 *
 * ## Why waiting is a first-class outcome
 *
 * A turn cannot be held open for thirty seconds. When the answer does not
 * arrive inside the grace window the turn ends, the caller is told something is
 * being looked into, and the answer is spoken whenever it lands, in a gap. That
 * is not the fallback path, it is the point: it is what lets the agent reach
 * something slow without the call stalling.
 */

import type { OrchestratorAnswer, OrchestratorBridge } from "./orchestrator.js";

/**
 * The part of a live call this needs.
 *
 * Declared structurally rather than imported, so this package keeps no
 * dependency on `@nolag/voice-engine` and a browser build never pulls it in. A
 * `VoiceSession` satisfies it as it stands.
 */
export interface VoiceFloor {
  /** Say something once there is room to say it, without talking over anyone. */
  speakUnprompted(speech: {
    text: string;
    kind?: string;
    remember?: boolean;
    expiresInMs?: number;
  }): { readonly done: Promise<string>; readonly started: boolean; cancel(): boolean };
  /** Keep the caller company while something slow happens. */
  beginStall(options: {
    lines: string[];
    everyMs?: number;
    remember?: boolean;
    kind?: string;
  }): { stop(): void; readonly stage: number };
}

/** The voice engine's model interface, declared structurally for the same reason. */
export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatRequest {
  messages: ChatMessage[];
  signal?: AbortSignal;
  onSentence?: (sentence: string) => void;
}

export interface LanguageModel {
  chat(request: ChatRequest): Promise<string>;
}

export interface OrchestratedLines {
  /** Said when the answer is going to take longer than a turn. */
  acknowledge?: string;
  /** Said as the wait goes on, in order. */
  stall?: string[];
  /** Said when no answer ever came back. */
  timeout?: string;
  /** Said when the orchestrator answered but could not help. */
  failure?: string;
}

export interface OrchestratedModelOptions {
  /** The fast model that carries the conversation. */
  model: LanguageModel;
  /** The link to whatever can actually do the work. */
  bridge: OrchestratorBridge;
  /** The live call, for speaking outside a turn. */
  floor: VoiceFloor;
  /** Which call this is, so the orchestrator knows who is asking. */
  callId: string;
  /**
   * How long a turn may be held open waiting. Long enough that a quick lookup
   * folds invisibly into the reply, short enough that the caller does not sit
   * in silence wondering whether the line dropped.
   */
  graceMs?: number;
  /** Gap between stall lines once the wait is out in the open. */
  stallEveryMs?: number;
  /**
   * A late answer is dropped rather than spoken after this long without a gap.
   * Talking over someone is worse than staying quiet, and by then the next
   * ordinary turn can carry the point instead.
   */
  lateExpiryMs?: number;
  /**
   * Most asks a single call may make. A backstop, not a policy: one inviting
   * tool gets reached for constantly, and each reach costs the caller seconds.
   */
  maxAsksPerCall?: number;
  lines?: OrchestratedLines;
  /** Reports what the bridge did, for logging and dashboards. */
  onAsk?: (event: OrchestratorAskEvent) => void;
}

export interface OrchestratorAskEvent {
  question: string;
  correlationId: string;
  /** "folded" when it came back inside the turn, "deferred" when it did not. */
  outcome: "folded" | "deferred" | "refused";
  waitedMs: number;
}

const MARKER = /\[\[\s*ask\s*:\s*([\s\S]*?)(?:\]\]|$)/i;

const DEFAULT_LINES: Required<OrchestratedLines> = {
  acknowledge: "Let me look into that, one moment.",
  stall: ["Still checking on that.", "The system is a bit slow today, bear with me."],
  timeout: "Sorry, I could not get that looked up just now.",
  failure: "Sorry, I was not able to get an answer on that.",
};

/**
 * Wraps a model so it can reach the orchestrator, and returns something the
 * voice engine can use as its model with no other changes.
 */
export function orchestratedModel(options: OrchestratedModelOptions): LanguageModel {
  const { model, bridge, floor, callId } = options;
  const graceMs = options.graceMs ?? 1200;
  const stallEveryMs = options.stallEveryMs ?? 6000;
  const lateExpiryMs = options.lateExpiryMs ?? 20_000;
  const maxAsks = options.maxAsksPerCall ?? 6;
  const lines = { ...DEFAULT_LINES, ...options.lines };

  let asksUsed = 0;
  let outstanding = false;

  return {
    async chat(request: ChatRequest): Promise<string> {
      const capabilities = bridge.capabilities();
      // One ask at a time. Without this the model asks again while the first
      // answer is still coming, and the caller gets two apologies and two
      // answers to questions they asked once.
      const mayAsk = capabilities.length > 0 && !outstanding && asksUsed < maxAsks;

      const spoken: string[] = [];
      let marker: string | null = null;

      const reply = await model.chat({
        messages: mayAsk ? withProtocol(request.messages, capabilities) : request.messages,
        signal: request.signal,
        onSentence: (sentence) => {
          const found = MARKER.exec(sentence);
          if (found) {
            marker ??= found[1].trim();
            return; // never spoken, whatever else the sentence contains
          }
          if (marker !== null) return; // the ask ends the spoken part of the turn
          spoken.push(sentence);
          request.onSentence?.(sentence);
        },
      });

      const question = marker ?? extractMarker(reply);
      if (!question) return reply;

      // The marker was used when it should not have been. Strip it rather than
      // letting a speech model read the brackets out loud.
      if (!mayAsk) {
        options.onAsk?.({ question, correlationId: "", outcome: "refused", waitedMs: 0 });
        return spoken.join(" ");
      }

      asksUsed += 1;
      outstanding = true;
      const startedAt = Date.now();
      const pending = bridge.ask({ question, context: recentContext(request.messages), callId });

      const early = await within(pending.answer, graceMs);
      if (early) {
        outstanding = false;
        options.onAsk?.({
          question,
          correlationId: pending.correlationId,
          outcome: "folded",
          waitedMs: Date.now() - startedAt,
        });
        // Fast enough to hide entirely: fold it in and answer normally, so the
        // caller never learns anything was asked on their behalf.
        return model.chat({
          messages: [...request.messages, { role: "system", content: note(early) }],
          signal: request.signal,
          onSentence: request.onSentence,
        });
      }

      options.onAsk?.({
        question,
        correlationId: pending.correlationId,
        outcome: "deferred",
        waitedMs: Date.now() - startedAt,
      });

      // Too slow to hold the turn open. Say so, keep them company, and deliver
      // the answer whenever it arrives.
      if (!spoken.length && lines.acknowledge) {
        floor.speakUnprompted({ text: lines.acknowledge, kind: "acknowledge", remember: true });
      }
      const stall = floor.beginStall({
        lines: lines.stall,
        everyMs: stallEveryMs,
        kind: "stall",
      });

      void pending.answer.then((answer) => {
        outstanding = false;
        stall.stop();
        const text = lateText(answer, lines);
        if (!text) return;
        floor.speakUnprompted({
          text,
          kind: "orchestrator",
          remember: true,
          expiresInMs: lateExpiryMs,
        });
      });

      // Ends the turn. Anything already spoken is returned so the model
      // remembers saying it; the rest of this exchange arrives unprompted.
      return spoken.join(" ");
    },
  };
}

function lateText(answer: OrchestratorAnswer, lines: Required<OrchestratedLines>): string {
  if (answer.ok && answer.speech) return answer.speech;
  if (answer.reason === "cancelled") return "";
  if (answer.reason === "timeout" || answer.reason === "undeliverable") return lines.timeout;
  return lines.failure;
}

/** The answer as something the model can write from, not as speech. */
function note(answer: OrchestratorAnswer): string {
  if (!answer.ok) {
    return (
      "The orchestrator could not answer that. Tell the caller plainly, " +
      "without guessing at an answer."
    );
  }
  const detail = answer.detail ? `\nDetail: ${answer.detail}` : "";
  return (
    `The orchestrator answered: ${answer.speech}${detail}\n` +
    "Use this to reply in one or two short spoken sentences. Do not ask again."
  );
}

/** The last few turns, so the orchestrator can make sense of the question. */
function recentContext(messages: ChatMessage[], turns = 6): string {
  return messages
    .filter((message) => message.role !== "system")
    .slice(-turns)
    .map((message) => `${message.role}: ${message.content}`)
    .join("\n");
}

function extractMarker(reply: string): string | null {
  const found = MARKER.exec(reply);
  const question = found?.[1]?.trim();
  return question ? question : null;
}

/**
 * Teaches the protocol, and names what is on offer without listing it as
 * choices. Capability names only, because that is all presence carries, and
 * because the orchestrator is the thing that decides which of its tools to use.
 */
function withProtocol(messages: ChatMessage[], capabilities: string[]): ChatMessage[] {
  const instruction =
    "You have one way to get help. When you need information or an action you " +
    "do not already have, reply with exactly:\n" +
    "[[ask: what you need, in one sentence]]\n" +
    "Put nothing else in that reply. A colleague with access to " +
    `${capabilities.join(", ")} will answer, and may take a few seconds. ` +
    "Do not use it for anything you can already answer, and never mention it " +
    "or read the brackets aloud.";

  const at = messages.findIndex((message) => message.role === "system");
  if (at < 0) return [{ role: "system", content: instruction }, ...messages];

  const merged = [...messages];
  merged[at] = { role: "system", content: `${messages[at].content}\n\n${instruction}` };
  return merged;
}

/** Resolves with the value if it arrives in time, or null if it does not. */
function within<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    void promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      }
    );
  });
}
