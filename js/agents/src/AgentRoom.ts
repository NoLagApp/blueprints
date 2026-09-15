import type { RoomContext } from "@nolag/js-sdk";
import { EventEmitter } from "./EventEmitter";
import type {
  AgentRoomEvents, TaskEnvelope, ResultEnvelope, AgentPresenceData,
  FilterValue, AgentFilterOptions, AgentFilterTopic, AgentPublishOptions,
} from "./types";
import { filterEmitOptions, mergeFilters, withoutFilters } from "./utils";
import {
  AGENTS_PROTOCOL_VERSION,
  TOPIC_TASKS,
  TOPIC_RESULTS,
  TOPIC_STATE,
  TOPIC_EVENTS,
  TOPIC_INBOX,
  TOPIC_TOOLS,
  TOPIC_APPROVAL,
} from "./constants";

type TopicHandler = (data: unknown) => void;

/**
 * Maps the public topic names onto the wire topics. `results` is absent by
 * design — it is reserved for directed replies keyed to this agent's id.
 */
const FILTER_TOPICS: Record<AgentFilterTopic, string> = {
  tasks: TOPIC_TASKS,
  tools: TOPIC_TOOLS,
  state: TOPIC_STATE,
  events: TOPIC_EVENTS,
  inbox: TOPIC_INBOX,
  approval: TOPIC_APPROVAL,
};

const ALL_FILTER_TOPICS = Object.keys(FILTER_TOPICS) as AgentFilterTopic[];

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
  /** Agents-protocol version the agent advertised (absent presence field = 1) */
  protocol: number;
  /**
   * Persistent Presence status: "online" (connected), "offline" (registered but
   * disconnected — discoverable + wakeable), or "waking". Undefined for ordinary
   * ephemeral agents (treat as online when present).
   */
  status?: "online" | "offline" | "waking";
}

/**
 * AgentRoom — a single agent-coordination room (scoped unit).
 *
 * Wraps a RoomContext from @nolag/js-sdk with typed pub/sub for agent
 * coordination topics, presence-based service discovery, and capability
 * routing.
 *
 * Created via `NoLagAgents.room(name)`. Do not instantiate directly. Presence
 * events are routed in by the parent NoLagAgents (which owns the shared
 * client's connection-level presence handlers); the room only wires its own
 * topic handlers on its RoomContext, and cleanup removes exactly those.
 *
 * @example
 * ```typescript
 * const room = agents.room('default-workflow');
 *
 * // Service discovery - see who's connected
 * const connected = room.getConnectedAgents();
 * const summarizers = room.findAgents('summarize');
 *
 * // Capability-filtered task handler
 * room.on('task', (envelope) => console.log('New task:', envelope));
 * ```
 */
export class AgentRoom extends EventEmitter<AgentRoomEvents> {
  readonly name: string;
  readonly agentId: string;
  private _roomContext: RoomContext;
  private _log: (...args: unknown[]) => void;
  private _presence: AgentPresenceData | undefined;
  private _appName: string;
  private _isConnected: () => boolean;

  /** Registry of connected agents discovered via presence */
  private _agents = new Map<string, ConnectedAgent>();

  // Stored topic handler refs — cleanup removes exactly these, never all
  // handlers for a topic (the client may be shared with other consumers).
  private _topicHandlers: Array<{ topic: string; handler: TopicHandler }> = [];

  /** Filter values applied per topic. `results` is never included. */
  private _filters: Record<AgentFilterTopic, FilterValue[]> = {
    tasks: [], tools: [], state: [], events: [], inbox: [], approval: [],
  };

  /** @internal */
  constructor(
    name: string,
    roomContext: RoomContext,
    log: (...args: unknown[]) => void,
    agentId: string,
    appName: string,
    isConnected: () => boolean,
    presence?: AgentPresenceData,
    filters?: FilterValue[],
  ) {
    super();
    this.name = name;
    this.agentId = agentId;
    this._roomContext = roomContext;
    this._log = log;
    this._appName = appName;
    this._isConnected = isConnected;
    this._presence = presence;
    if (filters && filters.length > 0) {
      for (const topic of ALL_FILTER_TOPICS) this._filters[topic] = [...filters];
    }
    this._wireTopicListeners();

    // Set presence if provided (with the SDK's protocol version advertised
    // so counterparts can detect incompatible reply semantics, and a __scope
    // tag so co-attached wrappers on other apps filter our presence out).
    if (presence) {
      this._presence = { protocol: AGENTS_PROTOCOL_VERSION, ...presence };
      this._log(`setting presence in room ${name}:`, this._presence);
      this._roomContext.setPresence({ ...this._presence, __scope: appName });
    }

    // Fetch initial presence snapshot
    void this._fetchInitialPresence();
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

  /** Update this agent's presence data (protocol version auto-injected) */
  setPresence(data: AgentPresenceData): void {
    this._presence = { protocol: AGENTS_PROTOCOL_VERSION, ...data };
    this._log(`updating presence in room ${this.name}`);
    this._roomContext.setPresence({ ...this._presence, __scope: this._appName });
  }

  /** Fetch current presence snapshot for this room */
  async fetchPresence(): Promise<ConnectedAgent[]> {
    try {
      const actors = await this._roomContext.fetchPresence();
      return (actors || []).map((a) => this._toConnectedAgent(a as unknown as Record<string, unknown>));
    } catch {
      return [];
    }
  }

  /** Get the underlying RoomContext for advanced usage */
  get context(): RoomContext {
    return this._roomContext;
  }

  // ============================================================
  // PUBLISH (with automatic agentId injection)
  // ============================================================

  /** Publish to the tasks topic */
  publishTask(envelope: TaskEnvelope, opts?: AgentPublishOptions): void {
    // Auto-set createdBy if not set
    if (!envelope.createdBy) {
      envelope.createdBy = this.agentId;
    }
    // Routing by capability (`{ filter: envelope.capability }`) is opt-in:
    // it only reaches workers that filter on it, and mixing filtered and
    // wildcard workers in one load-balance pool double-delivers.
    this._publish(TOPIC_TASKS, envelope, filterEmitOptions(opts));
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
  publishState(data: Record<string, unknown>, opts?: AgentPublishOptions): void {
    // Auto-set updatedBy if not set
    if (!data.updatedBy) {
      data.updatedBy = this.agentId;
    }
    this._publish(TOPIC_STATE, data, { retain: true, ...filterEmitOptions(opts) });
  }

  /** Publish to the events topic */
  publishEvent(data: Record<string, unknown>, opts?: AgentPublishOptions): void {
    // Auto-set emittedBy if not set
    if (!data.emittedBy) {
      data.emittedBy = this.agentId;
    }
    this._publish(TOPIC_EVENTS, data, filterEmitOptions(opts));
  }

  /** Publish to the inbox topic */
  publishInbox(data: Record<string, unknown>, opts?: AgentPublishOptions): void {
    this._publish(TOPIC_INBOX, data, filterEmitOptions(opts));
  }

  /**
   * Publish a tool message.
   * Requests go to the tools topic (load-balanced one-of-N across server
   * replicas). Responses are directed to the requester on the results topic
   * via filter — never load-balanced, never broadcast.
   */
  publishTools(data: Record<string, unknown>, opts?: AgentPublishOptions): void {
    if (data?.type === "tool_response" && typeof data.replyTo === "string" && data.replyTo) {
      // Responses stay keyed to the requester; a caller filter must not
      // redirect them away from the agent waiting on the correlation.
      this._publish(TOPIC_RESULTS, data, { filter: data.replyTo });
      return;
    }
    this._publish(TOPIC_TOOLS, data, filterEmitOptions(opts));
  }

  /** Publish to the approval topic (retained) */
  publishApproval(data: Record<string, unknown>, opts?: AgentPublishOptions): void {
    this._publish(TOPIC_APPROVAL, data, { retain: true, ...filterEmitOptions(opts) });
  }

  // ============================================================
  // FILTERS
  // ============================================================

  /** The filter values currently applied to this room, by topic. */
  get filters(): Record<AgentFilterTopic, FilterValue[]> {
    return {
      tasks: [...this._filters.tasks],
      tools: [...this._filters.tools],
      state: [...this._filters.state],
      events: [...this._filters.events],
      inbox: [...this._filters.inbox],
      approval: [...this._filters.approval],
    };
  }

  /**
   * Replace this room's filters — only messages published with one of these
   * values are delivered. Applies to every filterable topic unless scoped with
   * `{ topic }`.
   *
   * The usual case is a worker declaring its capabilities on `tasks`, so the
   * broker routes only work it can do instead of every worker receiving every
   * task and discarding the rest. Pair it with
   * `publishTask(envelope, { filter: capability })` on the dispatcher.
   *
   * `results` is never filtered here: it carries directed replies keyed to
   * this agent's id, and repointing it would strand pending results.
   *
   * With load balancing on, keep a worker pool uniform — the broker treats a
   * wildcard and a filtered subscription as separate share groups, so a mixed
   * pool delivers each task twice.
   *
   * Passing an empty array clears filtering and restores the wildcard
   * subscription, which receives everything.
   *
   * @example
   * ```ts
   * room.setFilters(['ocr', 'translate'], { topic: 'tasks' });
   * room.setFilters([]);  // everything
   * ```
   */
  setFilters(values: FilterValue[], opts?: AgentFilterOptions): void {
    for (const topic of this._targetTopics(opts)) {
      this._filters[topic] = [...values];
      // The core types filters as `string[]`, but both its implementation and
      // the wire protocol accept AND groups (nested arrays).
      this._roomContext.setFilters(FILTER_TOPICS[topic], values as unknown as string[]);
    }
  }

  /** Add filter values to the existing set. Existing AND groups are kept. */
  addFilters(values: string[], opts?: AgentFilterOptions): void {
    for (const topic of this._targetTopics(opts)) {
      this.setFilters(mergeFilters(this._filters[topic], values), { topic });
    }
  }

  /**
   * Remove filter values from the existing set. Removing the last value
   * restores the wildcard subscription.
   */
  removeFilters(values: string[], opts?: AgentFilterOptions): void {
    for (const topic of this._targetTopics(opts)) {
      this.setFilters(withoutFilters(this._filters[topic], values), { topic });
    }
  }

  private _targetTopics(opts?: AgentFilterOptions): AgentFilterTopic[] {
    return opts?.topic ? [opts.topic] : ALL_FILTER_TOPICS;
  }

  // ============================================================
  // INTERNAL (called by NoLagAgents)
  // ============================================================

  /** @internal Re-apply local presence after a reconnect (core does not restore it) */
  _updateLocalPresence(): void {
    if (this._presence) {
      this._roomContext.setPresence({ ...this._presence, __scope: this._appName });
    }
  }

  /** @internal Route a presence:join event in from the parent */
  _handlePresenceJoin(actorId: string, data: Record<string, unknown>): void {
    const d = data || {};
    const agent: ConnectedAgent = {
      actorId,
      name: (d.name as string) || actorId,
      role: (d.role as string) || "agent",
      capabilities: (d.capabilities as string[]) || [],
      metadata: d.metadata as Record<string, unknown> | undefined,
      connectedAt: Date.now(),
      protocol: typeof d.protocol === "number" ? d.protocol : 1,
    };
    this._agents.set(actorId, agent);
    this._log(`agent joined room ${this.name}:`, agent.name, agent.capabilities);
    this.emit("presenceJoin", actorId, d as unknown as AgentPresenceData);
  }

  /** @internal Route a presence:leave event in from the parent */
  _handlePresenceLeave(actorId: string): void {
    const agent = this._agents.get(actorId);
    this._agents.delete(actorId);
    this._log(`agent left room ${this.name}:`, agent?.name || actorId);
    this.emit("presenceLeave", actorId);
  }

  /** @internal Route a presence:update event in from the parent */
  _handlePresenceUpdate(actorId: string, data: Record<string, unknown>): void {
    const d = data || {};
    const existing = this._agents.get(actorId);
    const agent: ConnectedAgent = {
      actorId,
      name: (d.name as string) || existing?.name || actorId,
      role: (d.role as string) || existing?.role || "agent",
      capabilities: (d.capabilities as string[]) || existing?.capabilities || [],
      metadata: (d.metadata as Record<string, unknown> | undefined) || existing?.metadata,
      connectedAt: existing?.connectedAt || Date.now(),
      protocol: typeof d.protocol === "number" ? d.protocol : (existing?.protocol ?? 1),
    };
    this._agents.set(actorId, agent);
    this.emit("presenceUpdate", actorId, d as unknown as AgentPresenceData);
  }

  /**
   * @internal Unsubscribe topics (when connected) and remove exactly this
   * room's handler refs. Handler-specific removal only: the client may be
   * shared, and a bare off(topic) would strip other consumers' handlers too.
   */
  _cleanup(): void {
    this._log(`room cleanup: ${this.name}`);

    // Server unsubscribes need a live socket; skip when disconnected
    // (best-effort — the core would no-op with an error callback anyway).
    if (this._isConnected()) {
      const topics = new Set(this._topicHandlers.map((t) => t.topic));
      for (const topic of topics) {
        this._roomContext.unsubscribe(topic);
      }
    }

    for (const { topic, handler } of this._topicHandlers) {
      this._roomContext.off(topic, handler);
    }
    this._topicHandlers = [];

    this._agents.clear();
    this.removeAllListeners();
  }

  // ============================================================
  // INTERNALS
  // ============================================================

  private _on(topic: string, handler: TopicHandler): void {
    this._topicHandlers.push({ topic, handler });
    this._roomContext.on(topic, handler);
  }

  private _publish(
    topic: string,
    data: unknown,
    options?: { retain?: boolean; filter?: string; filters?: string[] },
  ): void {
    this._log(`publish to ${topic} in room ${this.name}`);
    // An empty options object is dropped rather than forwarded: publishing
    // without filters should look exactly as it did before filters existed.
    if (options && Object.keys(options).length > 0) {
      this._roomContext.emit(topic, data, options);
    } else {
      this._roomContext.emit(topic, data);
    }
  }

  /** @internal Subscribe honouring the topic's filter set. */
  private _subscribeFiltered(topic: string, values: FilterValue[]): void {
    if (values.length > 0) {
      this._roomContext.subscribe(topic, { filters: values });
    } else {
      this._roomContext.subscribe(topic);
    }
  }

  private _toConnectedAgent(actor: Record<string, unknown>): ConnectedAgent {
    const presence = (actor.presence || actor.data || {}) as Record<string, unknown>;
    return {
      actorId: (actor.actorTokenId as string) || (actor.actorId as string) || "",
      name: (presence.name as string) || (actor.actorTokenId as string) || "",
      role: (presence.role as string) || "agent",
      capabilities: (presence.capabilities as string[]) || [],
      metadata: presence.metadata as Record<string, unknown> | undefined,
      connectedAt: (actor.joinedAt as number) || Date.now(),
      protocol: typeof presence.protocol === "number" ? presence.protocol : 1,
      status: actor.status as ConnectedAgent["status"],
    };
  }

  private async _fetchInitialPresence(): Promise<void> {
    try {
      const actors = await this._roomContext.fetchPresence();
      if (Array.isArray(actors)) {
        for (const actor of actors) {
          const connected = this._toConnectedAgent(actor as unknown as Record<string, unknown>);
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

  private _wireTopicListeners(): void {
    // Work distribution topics honour the connection-level loadBalance
    // setting, so a pool shares each message one-of-N (no double handling):
    //  - tasks: each task goes to exactly one worker in the group
    //  - tools: each tool REQUEST goes to exactly one tool-server replica
    this._subscribeFiltered(TOPIC_TASKS, this._filters.tasks);
    this._subscribeFiltered(TOPIC_TOOLS, this._filters.tools);

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
    const broadcastTopics: AgentFilterTopic[] = ["state", "events", "inbox", "approval"];
    for (const key of broadcastTopics) {
      const values = this._filters[key];
      this._roomContext.subscribe(FILTER_TOPICS[key], {
        loadBalance: false,
        ...(values.length > 0 ? { filters: values } : {}),
      });
    }

    // Simple 1:1 mappings
    const simpleMap: Array<{ topic: string; event: keyof AgentRoomEvents }> = [
      { topic: TOPIC_TASKS, event: "task" },
      { topic: TOPIC_STATE, event: "stateChange" },
      { topic: TOPIC_EVENTS, event: "event" },
      { topic: TOPIC_INBOX, event: "inbox" },
    ];
    for (const { topic, event } of simpleMap) {
      this._on(topic, (data) => {
        this._log(`received ${topic} in room ${this.name}`);
        this.emit(event, data as never);
      });
    }

    // Multiplexed: results topic carries task results AND tool responses,
    // both filter-directed to this agent.
    this._on(TOPIC_RESULTS, (data) => {
      this._log(`received ${TOPIC_RESULTS} in room ${this.name}`);
      if ((data as Record<string, unknown>)?.type === "tool_response") {
        this.emit("toolResponse", data as never);
      } else {
        this.emit("result", data as never);
      }
    });

    // Multiplexed: approval topic carries requests + responses
    this._on(TOPIC_APPROVAL, (data) => {
      this._log(`received ${TOPIC_APPROVAL} in room ${this.name}`);
      if ((data as Record<string, unknown>)?.type === "approval_response") {
        this.emit("approvalResponse", data as never);
      } else {
        this.emit("approvalRequest", data as never);
      }
    });

    // Tools topic carries requests; tool_response is still accepted here for
    // backward compatibility with responders on older SDK versions (their
    // responses are only reliable when the requester is not load-balanced).
    this._on(TOPIC_TOOLS, (data) => {
      this._log(`received ${TOPIC_TOOLS} in room ${this.name}`);
      if ((data as Record<string, unknown>)?.type === "tool_response") {
        this.emit("toolResponse", data as never);
      } else {
        this.emit("toolRequest", data as never);
      }
    });
  }
}
