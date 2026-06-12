import type { AgentRoom } from "../AgentRoom";
import type { ToolRequestEnvelope, ToolResponseEnvelope } from "../types";
import { CorrelationManager } from "../correlation";
import { createToolRequest, createToolResponse } from "../envelope";

type ToolHandler = (
  args: Record<string, unknown>,
) => Promise<unknown> | unknown;

/**
 * Tools pattern — typed RPC over pub/sub for tool invocations.
 *
 * Agents register tool handlers; callers invoke tools and receive
 * correlated responses.
 */
export class Tools {
  private _room: AgentRoom;
  private _agentId: string;
  private _correlations = new CorrelationManager<ToolResponseEnvelope>();
  private _handlers = new Map<string, ToolHandler>();

  constructor(room: AgentRoom, agentId: string) {
    this._room = room;
    this._agentId = agentId;

    // Wire response correlation
    this._room.on("toolResponse", (envelope) => {
      this._correlations.resolve(envelope.correlationId, envelope);
    });

    // Wire request handling
    this._room.on("toolRequest", async (envelope) => {
      const handler = this._handlers.get(envelope.toolName);
      if (!handler) return;

      // Direct the response back to the requester's filter sub-topic
      const replyTo = envelope.replyTo ?? envelope.requestedBy;

      try {
        const result = await handler(envelope.arguments);
        const response = createToolResponse(
          envelope.requestId,
          envelope.correlationId,
          "success",
          result,
          undefined,
          this._agentId,
          replyTo,
        );
        this._room.publishTools(
          response as unknown as Record<string, unknown>,
        );
      } catch (err) {
        const response = createToolResponse(
          envelope.requestId,
          envelope.correlationId,
          "error",
          null,
          {
            code: "TOOL_ERROR",
            message: err instanceof Error ? err.message : String(err),
          },
          this._agentId,
          replyTo,
        );
        this._room.publishTools(
          response as unknown as Record<string, unknown>,
        );
      }
    });
  }

  /**
   * Register a tool handler.
   */
  register(toolName: string, handler: ToolHandler): void {
    this._handlers.set(toolName, handler);
  }

  /**
   * Invoke a remote tool and wait for the response.
   */
  async invoke(
    toolName: string,
    args: Record<string, unknown>,
    options?: { timeout?: number },
  ): Promise<ToolResponseEnvelope> {
    // replyTo is the room's agentId — the filter sub-topic this room's
    // results subscription listens on. (this._agentId may differ when a
    // caller attributes requests to a logical agent; delivery must use the
    // address that is actually subscribed.)
    const envelope = createToolRequest(toolName, args, this._agentId, {
      replyTo: this._room.agentId,
    });
    this._room.publishTools(
      envelope as unknown as Record<string, unknown>,
    );

    return this._correlations.register(
      envelope.correlationId,
      options?.timeout,
    );
  }

  /** Cancel all pending correlations */
  dispose(): void {
    this._correlations.clear();
    this._handlers.clear();
  }
}
