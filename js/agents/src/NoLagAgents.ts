import type { NoLagOptions } from "@nolag/js-sdk";
import { NoLag } from "@nolag/js-sdk";
import { EventEmitter } from "./EventEmitter";
import { AgentRoom } from "./AgentRoom";
import { createLogger, generateId } from "./utils";
import { DEFAULT_APP_NAME, DEFAULT_ROOM } from "./constants";
import type {
  NoLagAgentsOptions,
  ResolvedAgentsOptions,
  AgentClientEvents,
} from "./types";

type NoLagClient = ReturnType<typeof NoLag>;

/**
 * NoLagAgents — high-level agent coordination SDK built on @nolag/js-sdk.
 *
 * Provides typed rooms for multi-agent patterns: Handoff, Blackboard,
 * Inbox, Tools, Approval, and Observe.
 *
 * @example
 * ```typescript
 * import { NoLagAgents } from '@nolag/agents';
 *
 * const agents = new NoLagAgents(token, {
 *   appName: 'my-workflow',
 *   agentId: 'worker-1',
 *   presence: { name: 'worker-1', role: 'agent', capabilities: ['summarize'] },
 * });
 * await agents.connect();
 *
 * const room = agents.room('default-workflow');
 * room.handoff.onTask(['summarize'], async (task, respond) => {
 *   const result = await summarize(task.payload);
 *   respond('success', { result });
 * });
 * ```
 */
export class NoLagAgents extends EventEmitter<AgentClientEvents> {
  private _token: string;
  private _options: ResolvedAgentsOptions;
  private _client: NoLagClient | null = null;
  private _appContext: any = null;
  private _rooms = new Map<string, AgentRoom>();
  private _log: (...args: unknown[]) => void;
  private _connected = false;

  constructor(token: string, options: NoLagAgentsOptions = {}) {
    super();
    this._token = token;
    this._options = {
      appName: options.appName ?? DEFAULT_APP_NAME,
      agentId: options.agentId ?? generateId(),
      debug: options.debug ?? false,
      rooms: options.rooms ?? [DEFAULT_ROOM],
      lobby: options.lobby,
      presence: options.presence,
      clientOptions: options.clientOptions,
    };
    this._log = createLogger("NoLagAgents", this._options.debug);
  }

  /** The agent's unique ID */
  get agentId(): string {
    return this._options.agentId;
  }

  /** Whether the client is connected */
  get connected(): boolean {
    return this._connected;
  }

  /** Map of joined rooms */
  get rooms(): ReadonlyMap<string, AgentRoom> {
    return this._rooms;
  }

  /** Connect to NoLag and join configured rooms */
  async connect(): Promise<void> {
    this._log("connecting...");

    this._client = NoLag(this._token, {
      ...(this._options as any).clientOptions,
    });

    this._appContext = this._client!.setApp(this._options.appName);

    this._client!.on("connected" as any, () => {
      this._connected = true;
      this._log("connected");
      this.emit("connected");
    });

    this._client!.on("disconnected" as any, (reason: string) => {
      this._connected = false;
      this._log("disconnected:", reason);
      this.emit("disconnected", reason);
    });

    this._client!.on("reconnected" as any, () => {
      this._connected = true;
      this._log("reconnected");
      this.emit("reconnected");
    });

    this._client!.on("error" as any, (err: Error) => {
      this._log("error:", err.message);
      this.emit("error", err);
    });

    await this._client!.connect();

    // Auto-join configured rooms
    for (const roomName of this._options.rooms) {
      this.room(roomName);
    }

    // Auto-subscribe to lobby if configured (for cross-room presence observation)
    if (this._options.lobby) {
      await this.subscribeLobby(this._options.lobby);
    }
  }

  /**
   * Subscribe to a lobby for cross-room presence observation.
   * Lobby presence events are forwarded to all AgentRooms.
   *
   * Returns the initial presence snapshot.
   */
  async subscribeLobby(lobbySlug: string): Promise<Record<string, Record<string, unknown>>> {
    if (!this._appContext) {
      throw new Error("Not connected. Call connect() before subscribing to lobbies.");
    }

    this._log(`subscribing to lobby: ${lobbySlug}`);
    const lobby = this._appContext.setLobby(lobbySlug);

    // Listen for lobby presence events on the client
    // (lobby.on() uses lobby UUID internally which may not match)
    this._client!.on('lobbyPresence:join' as any, (evt: any) => {
      const id = evt?.actorId;
      const data = evt?.data || {};
      if (id) {
        this._log(`lobby presence:join — ${data.name || id}`);
        for (const room of this._rooms.values()) {
          const agents = (room as any)._agents as Map<string, any>;
          if (!agents.has(id)) {
            agents.set(id, {
              actorId: id,
              name: data.name || id,
              role: data.role || 'agent',
              capabilities: data.capabilities || [],
              metadata: data.metadata,
              connectedAt: Date.now(),
            });
          }
          room._emitPresence('presenceJoin', id, data);
        }
      }
    });

    this._client!.on('lobbyPresence:leave' as any, (evt: any) => {
      const id = evt?.actorId;
      if (id) {
        this._log(`lobby presence:leave — ${id}`);
        for (const room of this._rooms.values()) {
          const agents = (room as any)._agents as Map<string, any>;
          agents.delete(id);
          room._emitPresence('presenceLeave', id);
        }
      }
    });

    this._client!.on('lobbyPresence:update' as any, (evt: any) => {
      const id = evt?.actorId;
      const data = evt?.data || {};
      if (id) {
        for (const room of this._rooms.values()) {
          const agents = (room as any)._agents as Map<string, any>;
          const existing = agents.get(id);
          if (existing) {
            if (data.name) existing.name = data.name;
            if (data.role) existing.role = data.role;
            if (data.capabilities) existing.capabilities = data.capabilities;
            if (data.metadata) existing.metadata = data.metadata;
          }
          room._emitPresence('presenceUpdate', id, data);
        }
      }
    });

    try {
      const initialState = await lobby.subscribe();
      this._log(`lobby subscribed, initial state:`, Object.keys(initialState || {}));
      return initialState || {};
    } catch (err) {
      this._log(`lobby subscription failed:`, err);
      return {};
    }
  }

  /** Disconnect from NoLag */
  disconnect(): void {
    this._log("disconnecting...");
    this._client?.disconnect();
    this._rooms.clear();
    this._client = null;
    this._appContext = null;
    this._connected = false;
  }

  /**
   * Get or create an AgentRoom wrapper.
   * If the room hasn't been joined yet, it will be joined automatically.
   */
  room(name: string): AgentRoom {
    let agentRoom = this._rooms.get(name);
    if (agentRoom) return agentRoom;

    if (!this._appContext) {
      throw new Error(
        "Not connected. Call connect() before accessing rooms.",
      );
    }

    this._log(`joining room: ${name}`);
    const roomContext = this._appContext.setRoom(name);
    agentRoom = new AgentRoom(
      name,
      roomContext,
      this._client,
      this._log,
      this._options.agentId,
      this._options.presence,
    );
    this._rooms.set(name, agentRoom);
    return agentRoom;
  }
}
