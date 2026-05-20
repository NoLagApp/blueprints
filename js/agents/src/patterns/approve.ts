import type { AgentRoom } from "../AgentRoom";
import type {
  ApprovalRequestEnvelope,
  ApprovalResponseEnvelope,
} from "../types";
import { CorrelationManager } from "../correlation";
import { createApprovalRequest, createApprovalResponse } from "../envelope";

/**
 * Approve pattern — human-in-the-loop approval gates.
 *
 * Agents request approval before taking actions; humans (or other agents)
 * approve or reject via the approval topic.
 */
export class Approve {
  private _room: AgentRoom;
  private _agentId: string;
  private _correlations =
    new CorrelationManager<ApprovalResponseEnvelope>();

  constructor(room: AgentRoom, agentId: string) {
    this._room = room;
    this._agentId = agentId;

    // Wire approval response correlation
    this._room.on("approvalResponse", (envelope) => {
      this._correlations.resolve(envelope.correlationId, envelope);
    });
  }

  /**
   * Request approval for an action. Returns the approval response.
   */
  async request(
    action: string,
    context: unknown,
    options?: {
      urgency?: ApprovalRequestEnvelope["urgency"];
      timeout?: number;
      expiresAt?: number;
    },
  ): Promise<ApprovalResponseEnvelope> {
    const envelope = createApprovalRequest(
      action,
      context,
      this._agentId,
      {
        urgency: options?.urgency,
        expiresAt: options?.expiresAt,
      },
    );
    this._room.publishApproval(
      envelope as unknown as Record<string, unknown>,
    );

    return this._correlations.register(
      envelope.correlationId,
      options?.timeout,
    );
  }

  /**
   * Register a handler for incoming approval requests.
   * The handler receives the request and a respond function.
   */
  onRequest(
    handler: (
      request: ApprovalRequestEnvelope,
      respond: (
        decision: ApprovalResponseEnvelope["decision"],
        reason?: string,
      ) => void,
    ) => void,
  ): void {
    this._room.on("approvalRequest", (request) => {
      const respond = (
        decision: ApprovalResponseEnvelope["decision"],
        reason?: string,
      ) => {
        const response = createApprovalResponse(
          request.requestId,
          request.correlationId,
          decision,
          this._agentId,
          reason,
        );
        this._room.publishApproval(
          response as unknown as Record<string, unknown>,
        );
      };
      handler(request, respond);
    });
  }

  /** Cancel all pending correlations */
  dispose(): void {
    this._correlations.clear();
  }
}
