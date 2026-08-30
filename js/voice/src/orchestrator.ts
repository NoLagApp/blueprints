/**
 * The call's one link to something that can actually do things.
 *
 * The model answering the phone has about a second to reply, which means it is
 * small, which means it is the wrong thing to decide whether a booking can be
 * moved. It also has no tools, so left alone it will say "I have updated that
 * for you" while nothing has changed.
 *
 * The work that matters runs on a different clock. A lookup, a mutation, a
 * human approving a refund: five to thirty seconds, sometimes minutes. None of
 * that fits inside a one second budget, so it cannot live inside the call. It
 * has to be something the call talks to, and talking to it has to be
 * asynchronous, because the caller is still on the line.
 *
 * One capability rather than many is the point. A small model handed twenty
 * tools has to choose between them, and choosing badly is where small models
 * fail. Handed one, its only judgement is "do I need help, and how do I phrase
 * it". Tool selection moves to the orchestrator, which is large enough to do it
 * well.
 *
 * ## Where the orchestrator lives
 *
 * A room of its own, shared by every call, not one room per call. Orchestrators
 * join it once at startup, so a thousand concurrent calls are not a thousand
 * joins, and the capabilities on offer are known before a caller ever waits on
 * them. The call id travels in the payload instead.
 *
 * That also side-steps the rule that a connection only sees rooms that existed
 * when it authenticated: this room is static, so one long-lived connection can
 * hold it for the life of the process.
 *
 * ## Scaling the orchestrator, and the mistake that costs real money
 *
 * The `tasks` topic broadcasts by default: every subscriber in the room gets
 * every task. Run three orchestrator replicas that way and one question buys
 * three identical inferences on a large model, and three answers race back to
 * the same call.
 *
 * One-of-N delivery is opted into on the replica's core client, not here, and
 * not on the room:
 *
 *     NoLag(token, { loadBalance: true, loadBalanceGroup: "orchestrator-pool" })
 *
 * The group is the part that is easy to miss. It defaults to the actor token
 * id, so replicas holding different tokens land in different groups, and the
 * broker delivers one copy to each group. That looks exactly like working
 * software and bills like three of it. `orchestratorPoolOptions()` exists to
 * make that hard to get wrong.
 *
 * The voice side must stay out of that group. A `VoiceSession` server joins
 * this room to dispatch, and the Agents SDK subscribes every joined room to
 * `tasks` whether or not anything handles them, so sharing the group would hand
 * some tasks to a process that silently drops them.
 */

import {
  CorrelationManager,
  createTaskEnvelope,
  type AgentRoom,
  type NoLagAgents,
  type ResultEnvelope,
} from "@nolag/agents";

/** The room orchestrators and calls meet in. Static, and shared by every call. */
export const ORCHESTRATOR_ROOM = "orchestrator-work";

/** The capability a call dispatches to. One, deliberately. */
export const ORCHESTRATOR_CAPABILITY = "orchestrate";

/** Default pool name for orchestrator replicas sharing the work. */
export const ORCHESTRATOR_POOL = "orchestrator-pool";

/**
 * Core client options for an orchestrator replica, so a pool shares the work
 * instead of each member duplicating it.
 *
 *     const client = NoLag(token, { url, ...orchestratorPoolOptions() });
 *
 * Every replica must pass the same group. Both halves matter and neither fails
 * loudly: without `loadBalance` the broker sends every task to every replica,
 * and with `loadBalance` but no explicit group each replica forms a group of
 * its own and gets a copy anyway. Either way N replicas run N identical
 * inferences on a large model, N answers race back to one call, and the only
 * symptom is the bill.
 *
 * Do not use these options on the voice server's client. It joins the same room
 * to dispatch, the Agents SDK subscribes every joined room to `tasks` whether
 * or not anything handles them, and a voice process inside the pool would be
 * handed tasks it silently drops.
 */
export function orchestratorPoolOptions(group: string = ORCHESTRATOR_POOL): {
  loadBalance: true;
  loadBalanceGroup: string;
} {
  return { loadBalance: true, loadBalanceGroup: group };
}

export interface OrchestratorBridgeOptions {
  /** An already-constructed agents wrapper, connected and ready. */
  agents: NoLagAgents;
  /** Room to work in. Defaults to `orchestrator-work`. */
  room?: string;
  /** Capability to dispatch to. Defaults to `orchestrate`. */
  capability?: string;
  /**
   * How long to wait before giving up on an answer. There is no default
   * anywhere in the Agents SDK, and an ask with no timeout leaves a pending
   * promise and a map entry behind for the life of the process.
   */
  timeoutMs?: number;
  /**
   * Longest answer that will be accepted. An answer past the room's payload
   * limit fails to publish rather than arriving truncated, and a spoken answer
   * that runs for a paragraph is unusable on a phone call anyway.
   */
  maxAnswerChars?: number;
}

/** What the call wants to know, in its own words. */
export interface OrchestratorRequest {
  /** The question, phrased by the model in the conversation. */
  question: string;
  /** Anything from the conversation that makes the question answerable. */
  context?: string;
  /** Which call is asking, since the orchestrator serves all of them. */
  callId: string;
}

export interface OrchestratorAnswer {
  ok: boolean;
  /**
   * What to say to the caller, and it has to stand on its own: it may be
   * spoken a turn or two after the question, so "the 1:15 is free" needs to be
   * "about that pickup, the 1:15 is free".
   */
  speech: string;
  /** Detail for the model rather than the caller. Never spoken as-is. */
  detail?: string;
  /** Why there is no answer. */
  reason?: "timeout" | "error" | "cancelled" | "undeliverable";
  /** Which agent answered. */
  from?: string;
}

export interface PendingAsk {
  readonly correlationId: string;
  /** Settles exactly once, and never rejects. */
  readonly answer: Promise<OrchestratorAnswer>;
  /** Give up on it. The answer settles as cancelled. */
  cancel(): void;
}

/**
 * Dispatches work to the orchestrator room and reconciles the answers.
 *
 * Envelopes are built by hand rather than through `Handoff.dispatch`, which
 * resolves to `undefined` when not waiting for a result and hands back no
 * correlation id. Without one there is nothing to match a later answer
 * against, which is the whole job here.
 */
export class OrchestratorBridge {
  readonly roomSlug: string;
  readonly capability: string;

  private readonly room: AgentRoom;
  private readonly correlations = new CorrelationManager<ResultEnvelope>();
  private readonly timeoutMs: number;
  private readonly maxAnswerChars: number;
  private seeded: string[] = [];
  private detached = false;

  private readonly onResult = (envelope: ResultEnvelope): void => {
    if (!envelope?.correlationId) return;
    this.correlations.resolve(envelope.correlationId, envelope);
  };

  constructor(options: OrchestratorBridgeOptions) {
    if (!options?.agents) {
      throw new Error(
        "OrchestratorBridge needs an injected NoLagAgents instance. " +
          "Construct it and await agents.ready() first."
      );
    }
    this.roomSlug = options.room ?? ORCHESTRATOR_ROOM;
    this.capability = options.capability ?? ORCHESTRATOR_CAPABILITY;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.maxAnswerChars = options.maxAnswerChars ?? 600;

    this.room = options.agents.room(this.roomSlug);
    this.room.on("result", this.onResult);
  }

  /** How this process is addressed. Answers come back to exactly this id. */
  get agentId(): string {
    return this.room.agentId;
  }

  /** Asks still waiting for an answer. */
  get pending(): number {
    return this.correlations.size;
  }

  /**
   * Settles who is out there before the first call needs them.
   *
   * Worth doing at startup rather than lazily: the room's presence registry is
   * filled by a fetch the constructor starts and does not wait for, so asking
   * in the same tick reports an empty room, and the first caller of the day
   * would be told nobody can help.
   */
  async ready(): Promise<string[]> {
    const present = await this.room.fetchPresence();
    this.seeded = [...new Set(present.flatMap((agent) => agent.capabilities ?? []))];
    return this.capabilities();
  }

  /**
   * What the room can currently do.
   *
   * The union of what was there at startup and what presence has reported
   * since, because neither view is complete on its own: `fetchPresence`
   * returns a snapshot without populating the registry, and it returns an
   * empty array on failure rather than throwing, which is indistinguishable
   * from an empty room. A stale entry costs one ask that times out and is
   * answered with a spoken apology, which is a bounded and handled failure.
   */
  capabilities(): string[] {
    const all = new Set(this.seeded);
    for (const name of this.room.getAvailableCapabilities()) all.add(name);
    return [...all].sort();
  }

  /** True when something in the room advertises the capability being asked for. */
  get available(): boolean {
    return this.capabilities().includes(this.capability);
  }

  /**
   * Dispatches a question and hands back a promise for the answer.
   *
   * Never throws and never rejects: this sits in the middle of a live phone
   * call, where an unhandled rejection is a dropped call and a thrown error is
   * a caller listening to silence. Every failure arrives as an answer with
   * `ok: false` and a reason.
   */
  ask(request: OrchestratorRequest): PendingAsk {
    const envelope = createTaskEnvelope(
      this.capability,
      {
        question: request.question,
        context: request.context ?? "",
        callId: request.callId,
        source: "voice",
      },
      {
        // Results are published with a filter on this address and subscribed
        // with a filter on this room's agent id, so two processes sharing an
        // agent id send each other's answers to the wrong call.
        replyTo: this.room.agentId,
        createdBy: this.room.agentId,
        timeout: this.timeoutMs,
      }
    );

    const correlationId = envelope.correlationId;

    // Registered before publishing, because a fast orchestrator can answer
    // before the next line of this function runs.
    const settled = this.correlations.register(
      correlationId,
      this.timeoutMs,
      `orchestrator ask for call ${request.callId}`
    );

    const answer: Promise<OrchestratorAnswer> = settled.then(
      (result) => this.toAnswer(result),
      (error: Error) => ({
        ok: false,
        speech: "",
        reason: /timed out/i.test(error?.message ?? "") ? "timeout" : "cancelled",
      })
    );

    try {
      this.room.publishTask(envelope);
    } catch (error) {
      this.correlations.reject(correlationId, error as Error);
      return {
        correlationId,
        answer: answer.then((settledAnswer) => ({
          ...settledAnswer,
          reason: "undeliverable" as const,
        })),
        cancel: () => undefined,
      };
    }

    return {
      correlationId,
      answer,
      cancel: () => {
        this.correlations.reject(correlationId, new Error("cancelled"));
      },
    };
  }

  private toAnswer(result: ResultEnvelope): OrchestratorAnswer {
    const payload = (result?.payload ?? {}) as Record<string, unknown>;
    const raw = typeof payload.speech === "string" ? payload.speech : "";
    const speech = raw.trim().slice(0, this.maxAnswerChars);
    const detail = typeof payload.detail === "string" ? payload.detail : undefined;

    return {
      ok: result?.status === "success" && speech.length > 0,
      speech,
      detail,
      from: result?.completedBy,
      reason: result?.status === "success" ? undefined : "error",
    };
  }

  /**
   * Releases the room listener and settles every outstanding ask.
   *
   * Not optional on a long-running server. Each unsettled ask holds a promise,
   * a map entry and a timer, and whatever is awaiting it holds the call's
   * whole context.
   */
  detach(): void {
    if (this.detached) return;
    this.detached = true;
    this.room.off("result", this.onResult);
    this.correlations.clear();
  }
}
