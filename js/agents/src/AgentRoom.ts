import { EventEmitter } from "./EventEmitter";
import type { AgentRoomEvents, TaskEnvelope, ResultEnvelope, AgentPresenceData } from "./types";
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
 * ConnectedAgent — represents an agent discovered via presence.
 */
export interface ConnectedAgent {
  actorId: string;
  name: string;
  role: string;
  capabilities: string[];
  metadata?: Record<string, unknown>;
  connectedAt: number;
}

/**
 * AgentRoom — wraps a RoomContext from @nolag/js-sdk.
 *
 * Provides typed pub/sub for agent coordination topics,
 * presence-based service discovery, and capability routing.
 *
 * @example
 * ```typescript
 * const room = agents.room('default-workflow');
 *
 * // Service discovery - see who's connected
 * const agents = room.getConnectedAgents();
 * const summarizers = room.findAgents('summarize');
 *
 * // Capability-filtered task handler
 * room.on('task', (envelope) => console.log('New task:', envelope));
 * ```
 */
export class AgentRoom extends EventEmitter<AgentRoomEvents> {
  readonly name: string;
  readonly agentId: string;
  private _roomContext: any; // RoomContext from js-sdk
  private _client: any; // NoLagSocket from js-sdk (for presence events)
  private _log: (...args: unknown[]) => void;
  private _presence: AgentPresenceData | undefined;

  /** Registry of connected agents discovered via presence */
  private _agents = new Map<string, ConnectedAgent>();

  constructor(
    name: string,
    roomContext: any,
    client: any,
    log: (...args: unknown[]) => void,
    agentId: string,
    presence?: AgentPresenceData,
  ) {
    super();
    this.name = name;
    this.agentId = agentId;
    this._roomContext = roomContext;
    this._client = client;
    this._log = log;
    this._presence = presence;
    this._wireTopicListeners();
    this._wirePresenceListeners();

    // Set presence if provided
    if (presence) {
      this._log(`setting presence in room ${name}:`, presence);
      this._roomContext.setPresence(presence);
    }

    // Fetch initial presence snapshot
    this._fetchInitialPresence();
  }

  // ============================================================
  // SERVICE DISCOVERY
  // ============================================================

  /** Get all currently connected agents */
  getConnectedAgents(): ConnectedAgent[] {
    return Array.from(this._agents.values());
  }

  /** Find agents that have a specific capability */
  findAgents(capability: string): ConnectedAgent[] {
    return Array.from(this._agents.values()).filter(
      (a) => a.capabilities.includes(capability),
    );
  }

  /** Check if any connected agent can handle a capability */
  hasCapability(capability: string): boolean {
    return this.findAgents(capability).length > 0;
  }

  /** Get all capabilities available across connected agents */
  getAvailableCapabilities(): string[] {
    const caps = new Set<string>();
    for (const agent of this._agents.values()) {
      for (const cap of agent.capabilities) {
        caps.add(cap);
      }
    }
    return Array.from(caps);
  }

  // ============================================================
  // PRESENCE
  // ============================================================

  /** Update this agent's presence data */
  setPresence(data: AgentPresenceData): void {
    this._presence = data;
    this._log(`updating presence in room ${this.name}`);
    this._roomContext.setPresence(data);
  }

  /** Fetch current presence snapshot for this room */
  async fetchPresence(): Promise<ConnectedAgent[]> {
    try {
      const actors = await this._roomContext.fetchPresence();
      return (actors || []).map((a: any) => this._toConnectedAgent(a));
    } catch {
      return [];
    }
  }

  /**
   * @internal Emit a presence event (used by NoLagAgents for lobby forwarding)
   */
  _emitPresence(event: 'presenceJoin' | 'presenceLeave' | 'presenceUpdate', actorId: string, data?: AgentPresenceData): void {
    if (event === 'presenceLeave') {
      this.emit('presenceLeave', actorId);
    } else {
      this.emit(event, actorId, data || {} as AgentPresenceData);
    }
  }

  // ============================================================
  // PUBLISH (with automatic agentId injection)
  // ============================================================

  /** Get the underlying RoomContext for advanced usage */
  get context(): any {
    return this._roomContext;
  }

  /** Publish to the tasks topic */
  publishTask(envelope: TaskEnvelope): void {
    // Auto-set createdBy if not set
    if (!envelope.createdBy) {
      envelope.createdBy = this.agentId;
    }
    this._publish(TOPIC_TASKS, envelope);
  }

  /** Publish to the results topic — directed to the dispatcher via filter when replyTo is set */
  publishResult(envelope: ResultEnvelope): void {
    // Auto-set completedBy if not set
    if (!envelope.completedBy) {
      envelope.completedBy = this.agentId;
    }
    if (envelope.replyTo) {
      this._publish(TOPIC_RESULTS, envelope, { filter: envelope.replyTo });
    } else {
      // Legacy: no reply address — unfiltered publish (only reaches
      // wildcard subscribers, i.e. pre-0.2.0 SDKs)
      this._publish(TOPIC_RESULTS, envelope);
    }
  }

  /** Publish to the state topic (retained) */
  publishState(data: Record<string, unknown>): void {
    // Auto-set updatedBy if not set
    if (!(data as any).updatedBy) {
      (data as any).updatedBy = this.agentId;
    }
    this._publish(TOPIC_STATE, data, { retain: true });
  }

  /** Publish to the events topic */
  publishEvent(data: Record<string, unknown>): void {
    // Auto-set emittedBy if not set
    if (!(data as any).emittedBy) {
      (data as any).emittedBy = this.agentId;
    }
    this._publish(TOPIC_EVENTS, data);
  }

  /** Publish to the inbox topic */
  publishInbox(data: Record<string, unknown>): void {
    this._publish(TOPIC_INBOX, data);
  }

  /**
   * Publish a tool message.
   * Requests go to the tools topic (load-balanced one-of-N across server
   * replicas). Responses are directed to the requester on the results topic
   * via filter — never load-balanced, never broadcast.
   */
  publishTools(data: Record<string, unknown>): void {
    if (data?.type === "tool_response" && typeof data.replyTo === "string" && data.replyTo) {
      this._publish(TOPIC_RESULTS, data, { filter: data.replyTo });
      return;
    }
    this._publish(TOPIC_TOOLS, data);
  }

  /** Publish to the approval topic (retained) */
  publishApproval(data: Record<string, unknown>): void {
    this._publish(TOPIC_APPROVAL, data, { retain: true });
  }

  // ============================================================
  // INTERNALS
  // ============================================================

  private _publish(topic: string, data: unknown, options?: { retain?: boolean; filter?: string }): void {
    this._log(`publish to ${topic} in room ${this.name}`);
    if (options) {
      this._roomContext.emit(topic, data, options);
    } else {
      this._roomContext.emit(topic, data);
    }
  }

  private _toConnectedAgent(actor: any): ConnectedAgent {
    const presence = actor.presence || actor.data || {};
    return {
      actorId: actor.actorTokenId || actor.actorId || '',
      name: presence.name || actor.actorTokenId || '',
      role: presence.role || 'agent',
      capabilities: presence.capabilities || [],
      metadata: presence.metadata,
      connectedAt: actor.joinedAt || Date.now(),
    };
  }

  private async _fetchInitialPresence(): Promise<void> {
    try {
      const actors = await this._roomContext.fetchPresence();
      if (Array.isArray(actors)) {
        for (const actor of actors) {
          const connected = this._toConnectedAgent(actor);
          if (connected.actorId) {
            this._agents.set(connected.actorId, connected);
          }
        }
        this._log(`discovered ${this._agents.size} agents in room ${this.name}`);
      }
    } catch {
      // fetchPresence may not be available yet
    }
  }

  private _wirePresenceListeners(): void {
    if (!this._client) return;
    const client = this._client;

    client.on?.('presence:join', (evt: any) => {
      if (evt?.roomId === this.name || !evt?.roomId) {
        const id = evt?.actorId || evt?.actorTokenId;
        const data = evt?.data || evt?.presence || {};
        if (id) {
          const agent: ConnectedAgent = {
            actorId: id,
            name: data.name || id,
            role: data.role || 'agent',
            capabilities: data.capabilities || [],
            metadata: data.metadata,
            connectedAt: Date.now(),
          };
          this._agents.set(id, agent);
          this._log(`agent joined room ${this.name}:`, agent.name, agent.capabilities);
          this.emit('presenceJoin', id, data);
        }
      }
    });

    client.on?.('presence:leave', (evt: any) => {
      if (evt?.roomId === this.name || !evt?.roomId) {
        const id = evt?.actorId || evt?.actorTokenId;
        if (id) {
          const agent = this._agents.get(id);
          this._agents.delete(id);
          this._log(`agent left room ${this.name}:`, agent?.name || id);
          this.emit('presenceLeave', id);
        }
      }
    });

    client.on?.('presence:update', (evt: any) => {
      if (evt?.roomId === this.name || !evt?.roomId) {
        const id = evt?.actorId || evt?.actorTokenId;
        const data = evt?.data || evt?.presence || {};
        if (id) {
          const existing = this._agents.get(id);
          const agent: ConnectedAgent = {
            actorId: id,
            name: data.name || existing?.name || id,
            role: data.role || existing?.role || 'agent',
            capabilities: data.capabilities || existing?.capabilities || [],
            metadata: data.metadata || existing?.metadata,
            connectedAt: existing?.connectedAt || Date.now(),
          };
          this._agents.set(id, agent);
          this.emit('presenceUpdate', id, data);
        }
      }
    });
  }

  private _wireTopicListeners(): void {
    // Work distribution topics honour the connection-level loadBalance
    // setting, so a pool shares each message one-of-N (no double handling):
    //  - tasks: each task goes to exactly one worker in the group
    //  - tools: each tool REQUEST goes to exactly one tool-server replica
    this._roomContext.subscribe(TOPIC_TASKS);
    this._roomContext.subscribe(TOPIC_TOOLS);

    // Replies are DIRECTED, not broadcast: the results topic carries task
    // results and tool responses published with `filter: <recipient agentId>`,
    // and each agent subscribes only to its own filter sub-topic. The broker
    // routes each reply straight to the requester — no fan-out waste, and
    // immune to load-balance groups (a broadcast or LB'd reply could land on
    // a group member that doesn't hold the pending correlation, timing out
    // the requester even though the responder did the work).
    this._roomContext.subscribe(TOPIC_RESULTS, {
      loadBalance: false,
      filters: [this.agentId],
    });

    // Broadcast topics must always fan out, even when the connection enables
    // loadBalance for work distribution: state/events are broadcasts by
    // nature; inbox and approval messages are claimed client-side.
    const broadcastTopics = [TOPIC_STATE, TOPIC_EVENTS, TOPIC_INBOX, TOPIC_APPROVAL];
    for (const topic of broadcastTopics) {
      this._roomContext.subscribe(topic, { loadBalance: false });
    }

    // Simple 1:1 mappings
    const simpleMap: Array<{ topic: string; event: keyof AgentRoomEvents }> = [
      { topic: TOPIC_TASKS, event: "task" },
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

    // Multiplexed: results topic carries task results AND tool responses,
    // both filter-directed to this agent.
    this._roomContext.on(TOPIC_RESULTS, (data: any) => {
      this._log(`received ${TOPIC_RESULTS} in room ${this.name}`);
      if (data?.type === "tool_response") {
        this.emit("toolResponse", data);
      } else {
        this.emit("result", data);
      }
    });

    // Multiplexed: approval topic carries requests + responses
    this._roomContext.on(TOPIC_APPROVAL, (data: any) => {
      this._log(`received ${TOPIC_APPROVAL} in room ${this.name}`);
      if (data?.type === "approval_response") {
        this.emit("approvalResponse", data);
      } else {
        this.emit("approvalRequest", data);
      }
    });

    // Tools topic carries requests; tool_response is still accepted here for
    // backward compatibility with responders on older SDK versions (their
    // responses are only reliable when the requester is not load-balanced).
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
