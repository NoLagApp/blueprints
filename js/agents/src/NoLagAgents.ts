import type {
  LobbyContext,
  LobbyPresenceEvent,
  LobbyPresenceState,
  ActorPresence,
  NoLagSocket,
} from "@nolag/js-sdk";
import { EventEmitter } from "./EventEmitter";
import { AgentRoom } from "./AgentRoom";
import { createLogger, generateId, registerWrapper, releaseWrapper } from "./utils";
import { DEFAULT_APP_NAME, DEFAULT_ROOM, LOBBY_REFRESH_DELAY_MS } from "./constants";
import type {
  NoLagAgentsOptions,
  ResolvedAgentsOptions,
  AgentClientEvents,
  AgentPresenceData,
} from "./types";

/**
 * NoLagAgents — high-level agent coordination SDK built on @nolag/js-sdk.
 *
 * Provides typed rooms for multi-agent patterns: Handoff, Blackboard,
 * Inbox, Tools, Approval, and Observe.
 *
 * The wrapper NEVER manages the connection. The app owns one core NoLag
 * client (shared by any number of wrappers on distinct apps) and the
 * wrapper attaches to it at construction and releases it via `detach()`.
 *
 * @example
 * ```typescript
 * import { NoLag } from '@nolag/js-sdk';
 * import { NoLagAgents } from '@nolag/agents';
 *
 * const client = NoLag(async () => (await (await fetch('/api/nolag-token')).json()).token);
 * const agents = new NoLagAgents({
 *   client,
 *   appName: 'my-workflow',
 *   agentId: 'worker-1',
 *   presence: { name: 'worker-1', role: 'agent', capabilities: ['summarize'] },
 * });
 *
 * await client.connect();   // the app owns the connection
 * await agents.ready();     // wrapper setup done (identity, rooms, lobby)
 *
 * const room = agents.room('default-workflow');
 * room.on('task', (task) => console.log('New task:', task));
 *
 * agents.detach();          // wrapper releases its handlers and topics
 * client.disconnect();      // the app closes the socket
 * ```
 */
export class NoLagAgents extends EventEmitter<AgentClientEvents> {
  private _client: NoLagSocket;
  private _options: ResolvedAgentsOptions;
  private _rooms = new Map<string, AgentRoom>();
  private _lobby: LobbyContext | null = null;
  private _log: (...args: unknown[]) => void;

  // Lifecycle: one setup run per connection epoch; detach is terminal.
  private _epoch = 0;
  private _detached = false;
  private _isReady = false;
  private _readyResolve!: () => void;
  private _readyReject!: (err: Error) => void;
  private _readyPromise: Promise<void>;
  private _lobbyRefreshTimer: ReturnType<typeof setTimeout> | null = null;

  // Stored client handler refs. INVARIANT: every client.on() below has a
  // matching client.off() in detach() — never bare off(event), never inline
  // closures on the client.
  private _onConnectRef = () => this._onConnect();
  private _onDisconnectRef = (reason: string) => {
    this._log("disconnected:", reason);
    this.emit("disconnected", reason);
  };
  private _onReconnectRef = () => {
    this._log("reconnecting...");
    this.emit("reconnecting");
  };
  private _onErrorRef = (error: Error) => {
    this._log("error:", error?.message ?? error);
    this.emit("error", error);
  };
  private _onPresenceJoinRef = (data: ActorPresence) => this._handleRoomPresenceJoin(data);
  private _onPresenceLeaveRef = (data: ActorPresence) => this._handleRoomPresenceLeave(data);
  private _onPresenceUpdateRef = (data: ActorPresence) => this._handleRoomPresenceUpdate(data);
  private _onLobbyJoinRef = (data: unknown) => this._handleLobbyJoin(data as LobbyPresenceEvent);
  private _onLobbyLeaveRef = (data: unknown) => this._handleLobbyLeave(data as LobbyPresenceEvent);
  private _onLobbyUpdateRef = (data: unknown) => this._handleLobbyUpdate(data as LobbyPresenceEvent);

  constructor(options: NoLagAgentsOptions) {
    super();

    if (!options?.client) {
      throw new TypeError(
        "NoLagAgents requires an injected NoLag client: new NoLagAgents({ client, ... })",
      );
    }

    this._client = options.client;

    this._options = {
      appName: options.appName ?? DEFAULT_APP_NAME,
      agentId: options.agentId ?? generateId(),
      name: options.name,
      role: options.role,
      debug: options.debug ?? false,
      rooms: options.rooms ?? [DEFAULT_ROOM],
      lobby: options.lobby,
      presence: options.presence ?? this._presenceFromIdentity(options),
    };

    this._log = createLogger("NoLagAgents", this._options.debug);

    this._readyPromise = new Promise<void>((resolve, reject) => {
      this._readyResolve = resolve;
      this._readyReject = reject;
    });
    // ready() rejection is only meaningful to callers that await it
    this._readyPromise.catch(() => {});

    registerWrapper(this._client, this._options.appName, "NoLagAgents");

    // Construction = attach: wire everything now, with stored refs.
    this._client.on("connect", this._onConnectRef);
    this._client.on("disconnect", this._onDisconnectRef);
    this._client.on("reconnect", this._onReconnectRef);
    this._client.on("error", this._onErrorRef);
    this._client.on("presence:join", this._onPresenceJoinRef);
    this._client.on("presence:leave", this._onPresenceLeaveRef);
    this._client.on("presence:update", this._onPresenceUpdateRef);
    this._client.on("lobbyPresence:join", this._onLobbyJoinRef);
    this._client.on("lobbyPresence:leave", this._onLobbyLeaveRef);
    this._client.on("lobbyPresence:update", this._onLobbyUpdateRef);

    // Attach-to-connected: if the client is already authenticated, run setup.
    // The microtask lets the caller wire wrapper event handlers synchronously
    // first; a racing real 'connect' event wins via the epoch guard.
    queueMicrotask(() => {
      if (this._epoch === 0 && !this._detached && this._client.connected) {
        this._onConnect();
      }
    });
  }

  // ============ Public Properties ============

  /** The agent's unique ID */
  get agentId(): string {
    return this._options.agentId;
  }

  /** Whether the underlying connection is established (connected ≠ ready) */
  get connected(): boolean {
    return !this._detached && this._client.connected;
  }

  /** The injected core client (owned by the app, not the wrapper) */
  get client(): NoLagSocket {
    return this._client;
  }

  /** Map of joined rooms */
  get rooms(): ReadonlyMap<string, AgentRoom> {
    return this._rooms;
  }

  // ============ Lifecycle ============

  /**
   * Resolves once the wrapper's first setup completed (identity, configured
   * rooms and — when configured — the lobby ready; equivalently, once
   * 'connected' has fired). Rejects only if detach() is called before that.
   * Client auth failures surface via the app's own `await client.connect()`.
   */
  ready(): Promise<void> {
    return this._readyPromise;
  }

  /**
   * Detach from the client: remove every handler this wrapper added,
   * unsubscribe its topics and lobby (when connected), clear state.
   * Terminal and idempotent; never touches the socket. To use agents again,
   * construct a new instance.
   */
  detach(): void {
    if (this._detached) return;
    this._log("detaching...");
    this._detached = true;
    this._epoch++; // aborts any in-flight setup at its next checkpoint

    if (this._lobbyRefreshTimer) {
      clearTimeout(this._lobbyRefreshTimer);
      this._lobbyRefreshTimer = null;
    }

    // Remove all client handlers by stored ref
    this._client.off("connect", this._onConnectRef);
    this._client.off("disconnect", this._onDisconnectRef);
    this._client.off("reconnect", this._onReconnectRef);
    this._client.off("error", this._onErrorRef);
    this._client.off("presence:join", this._onPresenceJoinRef);
    this._client.off("presence:leave", this._onPresenceLeaveRef);
    this._client.off("presence:update", this._onPresenceUpdateRef);
    this._client.off("lobbyPresence:join", this._onLobbyJoinRef);
    this._client.off("lobbyPresence:leave", this._onLobbyLeaveRef);
    this._client.off("lobbyPresence:update", this._onLobbyUpdateRef);

    // Rooms: handler-specific off + connected-gated server unsubscribe
    for (const name of [...this._rooms.keys()]) {
      this._rooms.get(name)!._cleanup();
      this._rooms.delete(name);
    }

    // Lobby: server unsubscribe is best-effort and needs a live socket
    if (this._lobby && this._client.connected) {
      try {
        this._lobby.unsubscribe();
      } catch {
        /* best-effort */
      }
    }
    this._lobby = null;

    releaseWrapper(this._client, this._options.appName);

    if (!this._isReady) {
      this._readyReject(new Error("NoLagAgents detached before ready"));
    }
  }

  // ============ Private: Epoch Setup ============

  private _onConnect(): void {
    this._epoch++;
    void this._runSetup(this._epoch);
  }

  /**
   * One setup pass per connection epoch. Serves both initial setup (epoch 1)
   * and reconnect restore (epoch > 1). Aborts silently whenever a newer
   * epoch started or the wrapper detached — checked after every await.
   */
  private async _runSetup(epoch: number): Promise<void> {
    const stale = () => epoch !== this._epoch || this._detached;
    this._log(this._isReady ? "restoring after reconnect..." : "setting up...");
    this._log("agentId:", this._options.agentId, "→ actorId:", this._client.actorId);

    if (!this._isReady) {
      // First successful setup: auto-join configured rooms.
      for (const roomName of this._options.rooms) {
        this._joinRoomInternal(roomName);
      }
    } else {
      // Reconnect: the core auto-restores topic subscriptions, but not
      // room-scoped presence — re-apply each room's local presence.
      for (const room of this._rooms.values()) {
        room._updateLocalPresence();
      }
    }

    // Lobby is OPTIONAL: only when configured. Subscribe every epoch
    // (idempotent server-side) and diff-hydrate from the returned snapshot —
    // one path for setup and reconnect restore.
    if (this._options.lobby) {
      if (!this._lobby) {
        this._lobby = this._client.setApp(this._options.appName).setLobby(this._options.lobby);
      }
      try {
        const state = await this._lobby.subscribe();
        if (stale()) return;
        this._diffHydrateLobby(state);
        this._log("lobby subscribed:", this._options.lobby);
      } catch (err) {
        if (stale()) return;
        this._log("lobby subscription failed:", err);
      }
    }

    if (stale()) return;

    // Ready keys on the first setup that COMPLETES, not on epoch 1: an
    // epoch aborted by a racing reconnect must not strand ready().
    if (!this._isReady) {
      this._isReady = true;
      this._readyResolve();
      this.emit("connected");
    } else {
      this.emit("reconnected");
    }

    // Deferred lobby refetch: catches agents who joined during the setup
    // window (only when the lobby is configured).
    if (this._options.lobby) {
      this._scheduleLobbyRefresh(epoch);
    }
  }

  private _scheduleLobbyRefresh(epoch: number): void {
    if (this._lobbyRefreshTimer) clearTimeout(this._lobbyRefreshTimer);
    this._lobbyRefreshTimer = setTimeout(() => {
      this._lobbyRefreshTimer = null;
      if (epoch !== this._epoch || this._detached || !this._client.connected || !this._lobby) {
        return;
      }
      this._lobby
        .fetchPresence()
        .then((state) => {
          if (epoch !== this._epoch || this._detached) return;
          this._diffHydrateLobby(state);
        })
        .catch(() => {
          /* best-effort */
        });
    }, LOBBY_REFRESH_DELAY_MS);
  }

  // ============ Room Management ============

  /**
   * Get or create an AgentRoom wrapper.
   * If the room hasn't been joined yet, it will be joined automatically.
   */
  room(name: string): AgentRoom {
    this._assertUsable();
    const existing = this._rooms.get(name);
    if (existing) return existing;
    return this._joinRoomInternal(name);
  }

  // ============ Lobby (cross-room presence observation) ============

  /**
   * Subscribe to a lobby for cross-room presence observation. Lobby presence
   * events are forwarded into all AgentRooms. Prefer the `lobby` constructor
   * option — this method is for on-demand subscription after ready.
   *
   * Returns the initial presence snapshot.
   */
  async subscribeLobby(lobbySlug: string): Promise<LobbyPresenceState> {
    this._assertUsable();
    this._log(`subscribing to lobby: ${lobbySlug}`);
    this._options.lobby = lobbySlug;
    if (!this._lobby) {
      this._lobby = this._client.setApp(this._options.appName).setLobby(lobbySlug);
    }
    try {
      const state = await this._lobby.subscribe();
      if (!this._detached) this._diffHydrateLobby(state);
      return state || {};
    } catch (err) {
      this._log("lobby subscription failed:", err);
      return {};
    }
  }

  // ============ Private: Guards ============

  private _assertUsable(): void {
    if (this._detached) {
      throw new Error("NoLagAgents has been detached — construct a new instance");
    }
    if (!this._isReady) {
      throw new Error('NoLagAgents not ready — await ready() or the "connected" event');
    }
  }

  // ============ Private: Room Setup ============

  private _joinRoomInternal(name: string): AgentRoom {
    this._log(`joining room: ${name}`);
    const roomContext = this._client.setApp(this._options.appName).setRoom(name);
    const room = new AgentRoom(
      name,
      roomContext,
      createLogger(`AgentRoom:${name}`, this._options.debug),
      this._options.agentId,
      this._options.appName,
      () => this._client.connected,
      this._options.presence,
    );
    this._rooms.set(name, room);
    return room;
  }

  // ============ Private: Scope Filtering ============

  /**
   * On a shared client, presence events from other apps' wrappers arrive on
   * the same connection-level events. Wrappers stamp their presence with a
   * `__scope` (their appName); a mismatched tag means another app's data.
   * Untagged presence is accepted (older peers in this same app).
   */
  private _foreignScope(data: Record<string, unknown> | undefined): boolean {
    const scope = data?.__scope;
    return typeof scope === "string" && scope !== this._options.appName;
  }

  // ============ Private: Room Presence → Rooms ============

  private _handleRoomPresenceJoin(data: ActorPresence): void {
    if (data.actorTokenId === this._client.actorId) return;
    const presence = (data.presence || {}) as unknown as Record<string, unknown>;
    if (this._foreignScope(presence)) return;
    const roomId = (data as unknown as { roomId?: string }).roomId;
    for (const room of this._targetRooms(roomId)) {
      room._handlePresenceJoin(data.actorTokenId, presence);
    }
  }

  private _handleRoomPresenceLeave(data: ActorPresence): void {
    if (data.actorTokenId === this._client.actorId) return;
    const roomId = (data as unknown as { roomId?: string }).roomId;
    for (const room of this._targetRooms(roomId)) {
      room._handlePresenceLeave(data.actorTokenId);
    }
  }

  private _handleRoomPresenceUpdate(data: ActorPresence): void {
    if (data.actorTokenId === this._client.actorId) return;
    const presence = (data.presence || {}) as unknown as Record<string, unknown>;
    if (this._foreignScope(presence)) return;
    const roomId = (data as unknown as { roomId?: string }).roomId;
    for (const room of this._targetRooms(roomId)) {
      room._handlePresenceUpdate(data.actorTokenId, presence);
    }
  }

  /** Rooms a presence event targets: the named room, or all when unscoped. */
  private _targetRooms(roomId: string | undefined): AgentRoom[] {
    if (roomId && this._rooms.has(roomId)) return [this._rooms.get(roomId)!];
    if (roomId) return [];
    return [...this._rooms.values()];
  }

  // ============ Private: Lobby → Rooms ============

  private _handleLobbyJoin(event: LobbyPresenceEvent): void {
    const { actorId, data } = event;
    if (actorId === this._client.actorId) return;
    const presence = (data || {}) as unknown as Record<string, unknown>;
    if (this._foreignScope(presence)) return;
    this._log(`lobby presence:join — ${(presence.name as string) || actorId}`);
    for (const room of this._rooms.values()) {
      room._handlePresenceJoin(actorId, presence);
    }
  }

  private _handleLobbyLeave(event: LobbyPresenceEvent): void {
    const { actorId, data } = event;
    if (actorId === this._client.actorId) return;
    const presence = (data || {}) as unknown as Record<string, unknown>;
    if (this._foreignScope(presence)) return;
    this._log(`lobby presence:leave — ${actorId}`);
    for (const room of this._rooms.values()) {
      room._handlePresenceLeave(actorId);
    }
  }

  private _handleLobbyUpdate(event: LobbyPresenceEvent): void {
    const { actorId, data } = event;
    if (actorId === this._client.actorId) return;
    const presence = (data || {}) as unknown as Record<string, unknown>;
    if (this._foreignScope(presence)) return;
    for (const room of this._rooms.values()) {
      room._handlePresenceUpdate(actorId, presence);
    }
  }

  /**
   * Reconcile the rooms' agent registries against a fresh lobby snapshot,
   * routing each present actor in as a join. One path for initial hydration,
   * reconnect restore, and the deferred refetch.
   */
  private _diffHydrateLobby(state: LobbyPresenceState): void {
    for (const roomId of Object.keys(state)) {
      const roomPresence = state[roomId];
      for (const actorId of Object.keys(roomPresence)) {
        if (actorId === this._client.actorId) continue;
        const raw = roomPresence[actorId] as unknown as Record<string, unknown>;
        // Server returns full actor records with presence nested under .presence
        const presence = (raw?.presence ?? raw) as Record<string, unknown>;
        if (this._foreignScope(presence)) continue;
        for (const room of this._rooms.values()) {
          room._handlePresenceJoin(actorId, presence);
        }
      }
    }
  }

  // ============ Private: Helpers ============

  /** Derive presence identity from name/role options when no presence given. */
  private _presenceFromIdentity(options: NoLagAgentsOptions): AgentPresenceData | undefined {
    if (!options.name && !options.role) return undefined;
    return {
      name: options.name ?? (options.agentId ?? "agent"),
      role: options.role ?? "agent",
    };
  }
}
