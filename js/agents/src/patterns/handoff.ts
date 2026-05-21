import type { AgentRoom } from "../AgentRoom";
import type { TaskEnvelope, ResultEnvelope } from "../types";
import { CorrelationManager } from "../correlation";
import { createTaskEnvelope, createResultEnvelope } from "../envelope";

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
      /** Skip the capability check (dispatch even if no workers are connected) */
      allowNoWorkers?: boolean;
    },
  ): Promise<ResultEnvelope | void> {
    // Service discovery: check if any agent can handle this capability
    if (!options?.allowNoWorkers) {
      const capable = this._room.findAgents(capability);
      if (capable.length === 0) {
        throw new Error(
          `No agent with capability "${capability}" is connected. ` +
          `Available capabilities: [${this._room.getAvailableCapabilities().join(', ')}]. ` +
          `Connected agents: ${this._room.getConnectedAgents().length}. ` +
          `Use { allowNoWorkers: true } to dispatch anyway.`
        );
      }
    }

    const envelope = createTaskEnvelope(capability, payload, {
      ...options,
      createdBy: this._room.agentId,
    });
    this._room.publishTask(envelope);

    if (options?.waitForResult) {
      return this._correlations.register(
        envelope.correlationId,
        options.timeout,
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
  onTask(
    capabilities: string[] | '*',
    handler: (
      task: TaskEnvelope,
      respond: (
        status: ResultEnvelope["status"],
        payload: Record<string, unknown>,
        error?: { code: string; message: string },
      ) => void,
    ) => void,
  ): void {
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
