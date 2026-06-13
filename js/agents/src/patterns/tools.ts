import type { AgentRoom } from "../AgentRoom";
import type { ToolRequestEnvelope, ToolResponseEnvelope } from "../types";
import { CorrelationManager } from "../correlation";
import { createToolRequest, createToolResponse } from "../envelope";
import { IncompatibleProtocolError } from "../errors";

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
  private _warnedMixed = false;

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

      // Direct the response back to the requester's filter sub-topic
      const replyTo = envelope.replyTo ?? envelope.requestedBy;

      if (!handler) {
        // Tool requests are load-balanced to EVERY group in the room, so
        // agents legitimately receive requests meant for other tool servers.
        // Stay silent unless this agent plausibly owns the tool:
        //  - pure requesters (zero handlers) never answer
        //  - servers answer only within their own namespace (the prefix
        //    before the first '.', e.g. 'backend.*', 'chemistry.*') — a
        //    'backend.*' server NACKing 'chemistry.analyze' would race and
        //    beat the real chemistry server's response
        if (!this._ownsNamespace(envelope.toolName)) return;

        // A tool SERVER missing a handler in ITS OWN namespace NACKs instead
        // of silently ignoring — silence means the requester burns its full
        // timeout. (Requires homogeneous tool sets within a loadBalanceGroup
        // — see AGENTS-PROTOCOL.md.)
        const nack = createToolResponse(
          envelope.requestId,
          envelope.correlationId,
          "error",
          null,
          {
            code: "NO_HANDLER",
            message: `Agent '${this._agentId}' has no handler for tool '${envelope.toolName}'`,
          },
          this._agentId,
          replyTo,
        );
        this._room.publishTools(nack as unknown as Record<string, unknown>);
        return;
      }

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

  /** True when this agent hosts handlers in the tool's namespace (prefix
   *  before the first '.'); unprefixed tools match any unprefixed handler. */
  private _ownsNamespace(toolName: string): boolean {
    if (this._handlers.size === 0) return false;
    const ns = toolName.includes(".") ? toolName.slice(0, toolName.indexOf(".")) : null;
    for (const name of this._handlers.keys()) {
      const handlerNs = name.includes(".") ? name.slice(0, name.indexOf(".")) : null;
      if (handlerNs === ns) return true;
    }
    return false;
  }

  /**
   * Invoke a remote tool and wait for the response.
   */
  async invoke(
    toolName: string,
    args: Record<string, unknown>,
    options?: { timeout?: number; allowLegacyResponders?: boolean },
  ): Promise<ToolResponseEnvelope> {
    // Fail fast when the outcome is deterministic: tool servers are visible
    // in presence; if some exist and ALL advertise protocol < 2, their
    // replies cannot reach this requester. Mixed pools proceed with a
    // warning (presence is eventually consistent — hard-failing on one
    // stale entry would flake).
    const servers = this._room
      .getConnectedAgents()
      .filter((a) => a.role === "tool-server");
    if (!options?.allowLegacyResponders && servers.length > 0) {
      const modern = servers.filter((a) => a.protocol >= 2);
      if (modern.length === 0) {
        throw new IncompatibleProtocolError(
          `Tool '${toolName}' invocation`,
          servers.map((a) => ({ name: a.name, protocol: a.protocol })),
        );
      }
      if (modern.length < servers.length && !this._warnedMixed) {
        this._warnedMixed = true;
        console.warn(
          `[nolag-agents] Room '${this._room.name}' has tool servers on agents-protocol < 2: ` +
            servers.filter((a) => a.protocol < 2).map((a) => a.name).join(", ") +
            ". Their replies may not be delivered — upgrade them.",
        );
      }
    }

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

    const serverCount = servers.length;
    return this._correlations.register(
      envelope.correlationId,
      options?.timeout,
      `Tool '${toolName}' invocation in room '${this._room.name}' ` +
        `(${serverCount} tool-server${serverCount === 1 ? "" : "s"} visible). ` +
        `Likely causes: no agent has this tool registered (pre-0.3.0 responders ` +
        `don't NACK), the responder is offline, or the room is not deliverable ` +
        `(watch the room 'error' events)`,
    );
  }

  /** Cancel all pending correlations */
  dispose(): void {
    this._correlations.clear();
    this._handlers.clear();
  }
}
