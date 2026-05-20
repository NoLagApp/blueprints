import type { AgentRoom } from "../AgentRoom";
import { generateId, createTimestamp } from "../utils";

interface InboxMessage {
  messageId: string;
  from: string;
  to: string;
  payload: Record<string, unknown>;
  createdAt: number;
}

/**
 * Inbox pattern — per-agent durable message queues.
 *
 * Agents send direct messages to other agents via their inbox.
 * Messages are persisted and replayed on reconnect (requires persistent sessions).
 */
export class Inbox {
  private _room: AgentRoom;
  private _agentId: string;

  constructor(room: AgentRoom, agentId: string) {
    this._room = room;
    this._agentId = agentId;
  }

  /**
   * Send a message to another agent's inbox.
   */
  send(
    to: string,
    payload: Record<string, unknown>,
  ): void {
    const message: InboxMessage = {
      messageId: generateId(),
      from: this._agentId,
      to,
      payload,
      createdAt: createTimestamp(),
    };
    this._room.publishInbox(message as unknown as Record<string, unknown>);
  }

  /**
   * Register a handler for incoming inbox messages.
   */
  onMessage(
    handler: (message: InboxMessage) => void,
  ): void {
    this._room.on("inbox", (envelope) => {
      const msg = envelope as unknown as InboxMessage;
      if (msg.to === this._agentId) {
        handler(msg);
      }
    });
  }
}
