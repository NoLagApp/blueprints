import { EventEmitter } from "./EventEmitter";
import type { AgentRoomEvents, TaskEnvelope, ResultEnvelope } from "./types";
import {
  TOPIC_TASKS,
  TOPIC_RESULTS,
  TOPIC_STATE,
  TOPIC_EVENTS,
  TOPIC_INBOX,
  TOPIC_TOOLS,
  TOPIC_APPROVAL,
} from "./constants";

/**
 * AgentRoom — wraps a RoomContext from @nolag/js-sdk.
 *
 * Provides typed pub/sub for agent coordination topics.
 * Used by all pattern classes (Handoff, Blackboard, Inbox, etc.).
 *
 * @example
 * ```typescript
 * const room = agents.room('default-workflow');
 * room.on('task', (envelope) => console.log('New task:', envelope));
 * ```
 */
export class AgentRoom extends EventEmitter<AgentRoomEvents> {
  readonly name: string;
  private _roomContext: any; // RoomContext from js-sdk
  private _log: (...args: unknown[]) => void;

  constructor(
    name: string,
    roomContext: any,
    log: (...args: unknown[]) => void,
  ) {
    super();
    this.name = name;
    this._roomContext = roomContext;
    this._log = log;
    this._wireTopicListeners();
  }

  /** Get the underlying RoomContext for advanced usage */
  get context(): any {
    return this._roomContext;
  }

  /** Publish to the tasks topic */
  publishTask(envelope: TaskEnvelope): void {
    this._publish(TOPIC_TASKS, envelope);
  }

  /** Publish to the results topic */
  publishResult(envelope: ResultEnvelope): void {
    this._publish(TOPIC_RESULTS, envelope);
  }

  /** Publish to the state topic (retained) */
  publishState(data: Record<string, unknown>): void {
    this._publish(TOPIC_STATE, data, { retain: true });
  }

  /** Publish to the events topic */
  publishEvent(data: Record<string, unknown>): void {
    this._publish(TOPIC_EVENTS, data);
  }

  /** Publish to the inbox topic */
  publishInbox(data: Record<string, unknown>): void {
    this._publish(TOPIC_INBOX, data);
  }

  /** Publish to the tools topic */
  publishTools(data: Record<string, unknown>): void {
    this._publish(TOPIC_TOOLS, data);
  }

  /** Publish to the approval topic (retained) */
  publishApproval(data: Record<string, unknown>): void {
    this._publish(TOPIC_APPROVAL, data, { retain: true });
  }

  private _publish(topic: string, data: unknown, options?: { retain?: boolean }): void {
    this._log(`publish to ${topic} in room ${this.name}`);
    if (options) {
      this._roomContext.emit(topic, data, options);
    } else {
      this._roomContext.emit(topic, data);
    }
  }

  private _wireTopicListeners(): void {
    // All topics that need broker subscriptions
    const allTopics = [
      TOPIC_TASKS,
      TOPIC_RESULTS,
      TOPIC_STATE,
      TOPIC_EVENTS,
      TOPIC_INBOX,
      TOPIC_TOOLS,
      TOPIC_APPROVAL,
    ];
    for (const topic of allTopics) {
      this._roomContext.subscribe(topic);
    }

    // Simple 1:1 mappings
    const simpleMap: Array<{ topic: string; event: keyof AgentRoomEvents }> = [
      { topic: TOPIC_TASKS, event: "task" },
      { topic: TOPIC_RESULTS, event: "result" },
      { topic: TOPIC_STATE, event: "stateChange" },
      { topic: TOPIC_EVENTS, event: "event" },
      { topic: TOPIC_INBOX, event: "inbox" },
    ];
    for (const { topic, event } of simpleMap) {
      this._roomContext.on(topic, (data: any) => {
        this._log(`received ${topic} in room ${this.name}`);
        this.emit(event, data);
      });
    }

    // Multiplexed: approval topic carries requests + responses
    this._roomContext.on(TOPIC_APPROVAL, (data: any) => {
      this._log(`received ${TOPIC_APPROVAL} in room ${this.name}`);
      if (data?.type === "approval_response") {
        this.emit("approvalResponse", data);
      } else {
        this.emit("approvalRequest", data);
      }
    });

    // Multiplexed: tools topic carries requests + responses
    this._roomContext.on(TOPIC_TOOLS, (data: any) => {
      this._log(`received ${TOPIC_TOOLS} in room ${this.name}`);
      if (data?.type === "tool_response") {
        this.emit("toolResponse", data);
      } else {
        this.emit("toolRequest", data);
      }
    });
  }
}
