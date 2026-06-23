import type { AgentRoom } from "../AgentRoom";
import type { TaskEnvelope, ResultEnvelope } from "../types";
import { CorrelationManager } from "../correlation";
import { createTaskEnvelope, createResultEnvelope } from "../envelope";
import { IncompatibleProtocolError } from "../errors";

type TaskHandler = (
  task: TaskEnvelope,
  respond: (
    status: ResultEnvelope["status"],
    payload: Record<string, unknown>,
    error?: { code: string; message: string },
  ) => void,
) => void;

/**
 * Handoff pattern — dispatch tasks to agents and receive results.
 *
 * Orchestrators use `dispatch()` to send work. The SDK checks if any
 * connected agent has the requested capability (via presence-based
 * service discovery) before dispatching.
 *
 * Workers use `onTask()` with a capabilities filter — they only receive
 * tasks matching their registered capabilities.
 *
 * @example
 * ```typescript
 * // Orchestrator
 * const handoff = new Handoff(room);
 * const result = await handoff.dispatch('summarize', { text }, { waitForResult: true });
 *
 * // Worker
 * const handoff = new Handoff(room);
 * handoff.onTask(['summarize', 'translate'], async (task, respond) => {
 *   const output = await processTask(task);
 *   respond('success', { output });
 * });
 * ```
 */
export class Handoff {
  private _room: AgentRoom;
  private _correlations = new CorrelationManager<ResultEnvelope>();
  private _warnedMixed = false;

  constructor(room: AgentRoom) {
    this._room = room;

    // Wire result correlation
    this._room.on("result", (envelope) => {
      this._correlations.resolve(envelope.correlationId, envelope);
    });
  }

  /**
   * Dispatch a task to agents with the given capability.
   *
   * Uses presence-based service discovery to verify at least one agent
   * can handle the capability before dispatching. Throws if no capable
   * agent is connected (unless `allowNoWorkers` is set).
   */
  async dispatch(
    capability: string,
    payload: Record<string, unknown>,
    options?: {
      tags?: string[];
      priority?: TaskEnvelope["priority"];
      timeout?: number;
      waitForResult?: boolean;
      metadata?: Record<string, unknown>;
      /** Attribution override; defaults to the room's agentId */
      createdBy?: string;
      /** Reply address override; defaults to the room's agentId (its results filter) */
      replyTo?: string;
      /** Skip the capability check (dispatch even if no workers are connected) */
      allowNoWorkers?: boolean;
      /**
       * Persistent Presence: require an ONLINE capable agent. By default the gate
       * also accepts an offline persistent agent (discoverable, and woken by the
       * broker on publish) — set this to restore strict, low-latency behaviour.
       */
      requireOnline?: boolean;
      /** Skip the protocol fail-fast (responders on 0.2.x have directed replies but don't advertise protocol yet) */
      allowLegacyResponders?: boolean;
    },
  ): Promise<ResultEnvelope | void> {
    // Service discovery: check if any agent can handle this capability.
    // Persistent Presence: findAgents includes offline persistent agents, which
    // the broker wakes on publish — so they satisfy the gate unless requireOnline.
    if (!options?.allowNoWorkers) {
      const capable = this._room.findAgents(capability);
      const usable = options?.requireOnline
        ? capable.filter((a) => a.status === undefined || a.status === "online")
        : capable;
      if (usable.length === 0) {
        throw new Error(
          `No ${options?.requireOnline ? "online " : ""}agent with capability "${capability}" is available. ` +
          `Available capabilities: [${this._room.getAvailableCapabilities().join(', ')}]. ` +
          `Connected agents: ${this._room.getConnectedAgents().length}. ` +
          `Use { allowNoWorkers: true } to dispatch anyway.`
        );
      }
    }

    const envelope = createTaskEnvelope(capability, payload, {
      ...options,
      createdBy: options?.createdBy ?? this._room.agentId,
      // Reply address: workers publish the result filter-directed to this
      // room's results subscription
      replyTo: options?.replyTo ?? this._room.agentId,
    });
    this._room.publishTask(envelope);

    if (options?.waitForResult) {
      // Fail fast when the outcome is deterministic: if capable workers are
      // visible and ALL advertise agents-protocol < 2, their results cannot
      // reach this dispatcher's filtered subscription. Mixed pools proceed
      // with a warning (presence is eventually consistent).
      const capable = this._room.findAgents(capability);
      if (!options?.allowLegacyResponders && capable.length > 0) {
        const modern = capable.filter((a) => a.protocol >= 2);
        if (modern.length === 0) {
          throw new IncompatibleProtocolError(
            `Task '${capability}' dispatch with waitForResult`,
            capable.map((a) => ({ name: a.name, protocol: a.protocol })),
          );
        }
        if (modern.length < capable.length && !this._warnedMixed) {
          this._warnedMixed = true;
          console.warn(
            `[nolag-agents] Capability '${capability}' has workers on agents-protocol < 2: ` +
              capable.filter((a) => a.protocol < 2).map((a) => a.name).join(", ") +
              ". Their results may not be delivered — upgrade them.",
          );
        }
      }

      return this._correlations.register(
        envelope.correlationId,
        options.timeout,
        `Task '${capability}' dispatch (${capable.length} capable worker${capable.length === 1 ? "" : "s"} visible). ` +
          `Likely causes: worker crashed mid-task, worker on agents-protocol < 2 ` +
          `(results not directed), or the room is not deliverable`,
      );
    }
  }

  /**
   * Register a handler for incoming tasks, filtered by capabilities.
   *
   * Only tasks whose `capability` field matches one of the provided
   * capabilities will be delivered to the handler. Non-matching tasks
   * are silently ignored.
   *
   * @param capabilities - Array of capabilities this worker handles.
   *                       Pass `'*'` to receive all tasks.
   * @param handler - Async handler called with the task and a respond function.
   */
  onTask(handler: TaskHandler): void;
  onTask(capabilities: string[] | '*', handler: TaskHandler): void;
  onTask(
    capabilitiesOrHandler: string[] | '*' | TaskHandler,
    maybeHandler?: TaskHandler,
  ): void {
    // Single-arg form: onTask(handler) receives all tasks
    const capabilities: string[] | '*' =
      typeof capabilitiesOrHandler === "function" ? '*' : capabilitiesOrHandler;
    const handler: TaskHandler =
      typeof capabilitiesOrHandler === "function" ? capabilitiesOrHandler : maybeHandler!;

    this._room.on("task", (task) => {
      // Filter by capability unless wildcard
      if (capabilities !== '*' && !capabilities.includes(task.capability)) {
        return;
      }

      const respond = (
        status: ResultEnvelope["status"],
        payload: Record<string, unknown>,
        error?: { code: string; message: string },
      ) => {
        const result = createResultEnvelope(
          task.taskId,
          task.correlationId,
          status,
          payload,
          error,
          this._room.agentId,
          // Direct the result to the dispatcher's filter sub-topic
          task.replyTo ?? task.createdBy,
        );
        this._room.publishResult(result);
      };
      handler(task, respond);
    });
  }

  /**
   * Get agents capable of handling a specific task type.
   * Delegates to the room's presence-based service discovery.
   */
  getCapableAgents(capability: string) {
    return this._room.findAgents(capability);
  }

  /** Cancel all pending correlations */
  dispose(): void {
    this._correlations.clear();
  }
}
