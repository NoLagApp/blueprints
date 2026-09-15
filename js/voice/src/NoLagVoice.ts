/**
 * A live phone call as a NoLag room.
 *
 * The call joins its own room as an agent with a predictable id, and two of the
 * Agents SDK's coordination patterns carry the whole feature:
 *
 *   Observe  the call publishes what is happening, turn by turn, with timings
 *   Inbox    anything addressed to the call's agent id steers it mid-sentence
 *
 * That is the entire surface, and it is small on purpose. The hard real-time
 * work belongs to `@nolag/voice-engine`; this is only the part that makes a
 * call something other software can watch and influence while it is happening.
 *
 * Injection goes one level further than the other blueprints: rather than
 * taking a core client and constructing its own agents wrapper, this takes an
 * already-constructed `NoLagAgents`. The application then owns one agents
 * instance and one version of it, instead of every wrapper reaching for its
 * own, and upgrading the agents SDK is a change in one place.
 *
 * Note a call's room must exist before the injected client authenticated,
 * which is why the server side calls `ensureRoom` first (see rooms.ts).
 */

import { Observe, Inbox, type NoLagAgents } from "@nolag/agents";
import { OrchestratorBridge, type OrchestratorBridgeOptions } from "./orchestrator.js";
import { callAgentId, callRoomSlug } from "./rooms.js";
import {
  CALL_EVENT_PREFIX,
  CALL_TRANSCRIPT,
  type CallControlHandlers,
  type CallEvent,
  type CallEventName,
  type CallInfo,
  type CallWatchHandlers,
  type FilterValue,
  type PublishCallOptions,
  type TranscriptLine,
  type TurnMetrics,
  type WatchCallOptions,
} from "./types.js";

/** Category prefix, so voice events are distinguishable in a shared room. */
const TRANSCRIPT = CALL_TRANSCRIPT;
const EVENT_PREFIX = CALL_EVENT_PREFIX;

export interface NoLagVoiceOptions {
  /**
   * An already-constructed agents wrapper, connected and ready. The
   * application owns it, its identity, its rooms and its lifetime, so several
   * wrappers can share one instance and one version of the SDK.
   */
  agents: NoLagAgents;
}

/**
 * Publishes a call into its room. Deliberately shaped to match the engine's
 * session observer, so it can be handed straight to a VoiceSession.
 */
export interface CallPublisher {
  readonly agentId: string;
  readonly roomSlug: string;
  onCallStarted(info: CallInfo): void;
  onCallEnded(reason: string): void;
  onCallerSpeech(text: string, meta: { sttMs: number }): void;
  onAgentSpeech(text: string, meta: { kind: string; llmMs?: number }): void;
  onScreening(kind: string, turn: number): void;
  onBargeIn(): void;
  onTurnComplete(metrics: TurnMetrics): void;
  onError(error: Error): void;
}

/** Watches a call and can steer it. */
export interface CallWatcher {
  readonly roomSlug: string;
  /** Speak this to the caller now. */
  say(text: string): void;
  /** Silently add guidance the model sees from the next turn on. */
  instruct(text: string): void;
  /**
   * Change which event categories this watcher receives, mid-call — e.g. drop
   * the transcript when a dashboard collapses it.
   *
   * Only affects the events topic, so `say` and `instruct` keep working. An
   * empty array restores the full stream.
   */
  setFilters(values: FilterValue[]): void;
}

export class NoLagVoice {
  private readonly agents: NoLagAgents;

  constructor(options: NoLagVoiceOptions) {
    if (!options?.agents) {
      throw new Error(
        "NoLagVoice needs an injected NoLagAgents instance: " +
          "new NoLagVoice({ agents }). Construct and await agents.ready() first."
      );
    }
    this.agents = options.agents;
  }

  /** The injected wrapper, for callers that want the rest of its surface. */
  get agentsInstance(): NoLagAgents {
    return this.agents;
  }

  /**
   * The call's link to something that can actually do the work.
   *
   * One per process, not one per call: the orchestrator room is static and
   * shared, so this is opened at startup and every call dispatches through it.
   * Call `ready()` on the result before taking calls, so capabilities are known
   * before a caller is waiting on them.
   */
  orchestrator(options: Omit<OrchestratorBridgeOptions, "agents"> = {}): OrchestratorBridge {
    return new OrchestratorBridge({ ...options, agents: this.agents });
  }

  /**
   * Server side: publish a call into its room, and accept steering.
   *
   * The room must already exist, and this client must have connected after it
   * was created, otherwise the broker will not route anything.
   */
  publishCall(
    callId: string,
    handlers: CallControlHandlers = {},
    options: PublishCallOptions = {},
  ): CallPublisher {
    const roomSlug = callRoomSlug(callId);
    const agentId = callAgentId(callId);
    const room = this.agents.room(roomSlug);
    const observe = new Observe(room, agentId);
    const inbox = new Inbox(room, agentId);
    const tagCategories = options.tagCategories ?? true;

    inbox.onMessage((message) => {
      const payload = message.payload as { type?: string; text?: string };
      if (typeof payload?.text !== "string") return;
      if (payload.type === "say") handlers.onSay?.(payload.text);
      else if (payload.type === "instruct" || payload.type === "instruction") {
        handlers.onInstruct?.(payload.text);
      }
    });

    // Tagging routes each event to its own sub-topic, so a watcher can ask for
    // the transcript without the lifecycle events or the other way round.
    // Untagged watchers are unaffected: a wildcard subscription matches the
    // sub-topics too.
    const routed = (category: string) => (tagCategories ? { filter: category } : undefined);

    const emit = (event: CallEventName, data: Record<string, unknown> = {}) => {
      const category = `${EVENT_PREFIX}${event}`;
      observe.emit(category, data, event === "error" ? "error" : "info", routed(category));
    };
    const line = (role: "caller" | "agent", text: string, meta: Record<string, unknown>) => {
      observe.emit(TRANSCRIPT, { role, text, ...meta }, "info", routed(TRANSCRIPT));
    };

    return {
      agentId,
      roomSlug,
      onCallStarted: (info) => emit("call-started", { ...info }),
      onCallEnded: (reason) => emit("call-ended", { reason }),
      onCallerSpeech: (text, meta) => line("caller", text, meta),
      onAgentSpeech: (text, meta) => line("agent", text, meta),
      onScreening: (kind, turn) => emit("screening-detected", { kind, turn }),
      onBargeIn: () => emit("barge-in"),
      onTurnComplete: (metrics) => emit("turn-complete", { ...metrics }),
      onError: (error) => emit("error", { message: error.message }),
    };
  }

  /**
   * Dashboard side: stream a live call and steer it.
   *
   * Must authenticate as a DIFFERENT actor than the call itself. The broker
   * never delivers a message back to the actor that published it, so a watcher
   * sharing the call's token connects happily and then shows nothing at all.
   */
  watchCall(
    callId: string,
    handlers: CallWatchHandlers = {},
    options: WatchCallOptions = {},
  ): CallWatcher {
    const roomSlug = callRoomSlug(callId);
    const target = callAgentId(callId);
    const room = this.agents.room(roomSlug);
    const observe = new Observe(room, this.agents.agentId);
    const inbox = new Inbox(room, this.agents.agentId);

    // Scoped to the events topic by Observe. Applying filters room-wide would
    // also filter `inbox`, whose messages are published unfiltered — steering
    // would stop arriving with nothing to show for it.
    if (options.filters?.length) observe.setFilters(options.filters);

    observe.on((envelope) => {
      const payload = (envelope.payload ?? {}) as Record<string, unknown>;
      const at = typeof envelope.timestamp === "number" ? envelope.timestamp : Date.now();
      if (envelope.category === TRANSCRIPT) {
        handlers.onTranscript?.({ at, ...payload } as unknown as TranscriptLine);
        return;
      }
      if (typeof envelope.category === "string" && envelope.category.startsWith(EVENT_PREFIX)) {
        handlers.onEvent?.({
          event: envelope.category.slice(EVENT_PREFIX.length) as CallEventName,
          at,
          ...payload,
        });
      }
    });

    return {
      roomSlug,
      say: (text: string) => inbox.send(target, { type: "say", text }),
      instruct: (text: string) => inbox.send(target, { type: "instruct", text }),
      setFilters: (values) => observe.setFilters(values),
    };
  }

}
