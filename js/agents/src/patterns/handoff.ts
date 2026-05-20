import type { AgentRoom } from "../AgentRoom";
import type { TaskEnvelope, ResultEnvelope } from "../types";
import { CorrelationManager } from "../correlation";
import { createTaskEnvelope, createResultEnvelope } from "../envelope";

/**
 * Handoff pattern — dispatch tasks to agents and receive results.
 *
 * Orchestrators use `dispatch()` to send work, agents use `onTask()` to receive it.
 * Results are correlated back to the original dispatch call.
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
   * Dispatch a task and optionally wait for a correlated result.
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
      createdBy?: string;
    },
  ): Promise<ResultEnvelope | void> {
    const envelope = createTaskEnvelope(capability, payload, options);
    this._room.publishTask(envelope);

    if (options?.waitForResult) {
      return this._correlations.register(
        envelope.correlationId,
        options.timeout,
      );
    }
  }

  /**
   * Register a handler for incoming tasks.
   */
  onTask(
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
        );
        this._room.publishResult(result);
      };
      handler(task, respond);
    });
  }

  /** Cancel all pending correlations */
  dispose(): void {
    this._correlations.clear();
  }
}
