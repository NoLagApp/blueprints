import type { NoLagOptions } from "@nolag/js-sdk";
import { NoLag } from "@nolag/js-sdk";
import { EventEmitter } from "./EventEmitter";
import { AgentRoom } from "./AgentRoom";
import { createLogger } from "./utils";
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
 * const agents = new NoLagAgents(token, { appName: 'my-workflow' });
 * await agents.connect();
 *
 * const room = agents.room('default-workflow');
 * room.on('task', (envelope) => console.log('Task:', envelope));
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
      debug: options.debug ?? false,
      rooms: options.rooms ?? [DEFAULT_ROOM],
      clientOptions: options.clientOptions,
    };
    this._log = createLogger("NoLagAgents", this._options.debug);
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
    agentRoom = new AgentRoom(name, roomContext, this._log);
    this._rooms.set(name, agentRoom);
    return agentRoom;
  }
}
