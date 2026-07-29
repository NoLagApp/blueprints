import type {
  LobbyPresenceEvent,
  LobbyPresenceState,
  LobbyContext,
  ActorPresence,
  NoLagSocket,
} from '@nolag/js-sdk';
import { EventEmitter } from './EventEmitter';
import { DashboardPanel } from './DashboardPanel';
import { generateId, createLogger, registerWrapper, releaseWrapper } from './utils';
import {
  DEFAULT_APP_NAME,
  DEFAULT_MAX_METRIC_POINTS,
  DEFAULT_AGGREGATION_WINDOW,
  LOBBY_ID,
  LOBBY_REFRESH_DELAY_MS,
} from './constants';
import type {
  NoLagDashOptions,
  ResolvedDashOptions,
  DashClientEvents,
  DashboardViewer,
  DashPresenceData,
} from './types';

/**
 * NoLagDash — high-level live dashboard SDK built on @nolag/js-sdk.
 *
 * Provides multi-panel dashboards, real-time metric streams with
 * aggregation, widget updates, viewer presence, and replay — all
 * framework-agnostic via events.
 *
 * The wrapper NEVER manages the connection. The app owns one core NoLag
 * client (shared by any number of wrappers on distinct apps) and the
 * wrapper attaches to it at construction and releases it via `detach()`.
 *
 * @example
 * ```typescript
 * import { NoLag } from '@nolag/js-sdk';
 * import { NoLagDash } from '@nolag/dash';
 *
 * const client = NoLag(async () => (await (await fetch('/api/nolag-token')).json()).token);
 * const dash = new NoLagDash({ client, appName: 'my-dash', username: 'Alice' });
 *
 * dash.on('viewerOnline', (v) => console.log(v.username, 'is watching'));
 *
 * await client.connect();   // the app owns the connection
 * await dash.ready();       // wrapper setup done (identity, lobby, panels)
 *
 * const panel = dash.joinPanel('overview');
 * panel.on('metric', (m) => console.log(m.streamId, m.value));
 * panel.publishMetric('cpu', 75);
 *
 * dash.detach();            // wrapper releases its handlers and topics
 * client.disconnect();      // the app closes the socket
 * ```
 */
export class NoLagDash extends EventEmitter<DashClientEvents> {
  private _client: NoLagSocket;
  private _options: ResolvedDashOptions;
  private _localViewer: DashboardViewer | null = null;
  private _panels = new Map<string, DashboardPanel>();
  private _lobby: LobbyContext | null = null;
  private _onlineViewers = new Map<string, DashboardViewer>();
  private _actorToViewerId = new Map<string, string>();
  private _viewerId: string;
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
    this._log('Disconnected:', reason);
    this.emit('disconnected', reason);
  };
  private _onReconnectRef = () => {
    this._log('Reconnecting...');
    this.emit('reconnecting');
  };
  private _onErrorRef = (error: Error) => {
    this._log('Error:', error);
    this.emit('error', error);
  };
  private _onReplayStartRef = (data: unknown) => {
    const event = data as { count: number };
    for (const panel of this._panels.values()) {
      panel._handleReplayStart(event.count);
    }
  };
  private _onReplayEndRef = (data: unknown) => {
    const event = data as { replayed: number };
    for (const panel of this._panels.values()) {
      panel._handleReplayEnd(event.replayed);
    }
  };
  private _onPresenceJoinRef = (data: ActorPresence) => this._handlePresenceJoin(data);
  private _onPresenceLeaveRef = (data: ActorPresence) => this._handlePresenceLeave(data);
  private _onPresenceUpdateRef = (data: ActorPresence) => this._handlePresenceUpdate(data);
  private _onLobbyJoinRef = (data: unknown) => this._handleLobbyJoin(data as LobbyPresenceEvent);
  private _onLobbyLeaveRef = (data: unknown) => this._handleLobbyLeave(data as LobbyPresenceEvent);
  private _onLobbyUpdateRef = (data: unknown) => this._handleLobbyUpdate(data as LobbyPresenceEvent);

  constructor(options: NoLagDashOptions) {
    super();

    if (!options?.client) {
      throw new TypeError(
        'NoLagDash requires an injected NoLag client: new NoLagDash({ client, appName, ... })',
      );
    }

    this._client = options.client;
    this._viewerId = generateId();

    this._options = {
      username: options.username,
      metadata: options.metadata,
      appName: options.appName ?? DEFAULT_APP_NAME,
      maxMetricPoints: options.maxMetricPoints ?? DEFAULT_MAX_METRIC_POINTS,
      aggregationWindow: options.aggregationWindow ?? DEFAULT_AGGREGATION_WINDOW,
      debug: options.debug ?? false,
      panels: options.panels ?? [],
    };

    this._log = createLogger('NoLagDash', this._options.debug);

    this._readyPromise = new Promise<void>((resolve, reject) => {
      this._readyResolve = resolve;
      this._readyReject = reject;
    });
    // ready() rejection is only meaningful to callers that await it
    this._readyPromise.catch(() => {});

    registerWrapper(this._client, this._options.appName, 'NoLagDash');

    // Construction = attach: wire everything now, with stored refs.
    this._client.on('connect', this._onConnectRef);
    this._client.on('disconnect', this._onDisconnectRef);
    this._client.on('reconnect', this._onReconnectRef);
    this._client.on('error', this._onErrorRef);
    this._client.on('replay:start', this._onReplayStartRef);
    this._client.on('replay:end', this._onReplayEndRef);
    this._client.on('presence:join', this._onPresenceJoinRef);
    this._client.on('presence:leave', this._onPresenceLeaveRef);
    this._client.on('presence:update', this._onPresenceUpdateRef);
    this._client.on('lobbyPresence:join', this._onLobbyJoinRef);
    this._client.on('lobbyPresence:leave', this._onLobbyLeaveRef);
    this._client.on('lobbyPresence:update', this._onLobbyUpdateRef);

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

  /** Whether the underlying connection is established (connected ≠ ready) */
  get connected(): boolean {
    return !this._detached && this._client.connected;
  }

  /** The injected core client (owned by the app, not the wrapper) */
  get client(): NoLagSocket {
    return this._client;
  }

  /** The local viewer's info (available after ready) */
  get localViewer(): DashboardViewer | null {
    return this._localViewer;
  }

  /** All currently joined panels */
  get panels(): Map<string, DashboardPanel> {
    return this._panels;
  }

  // ============ Lifecycle ============

  /**
   * Resolves once the wrapper's first setup completed (identity, lobby and
   * configured panels ready — equivalently, once 'connected' has fired).
   * Rejects only if detach() is called before that. Client auth failures
   * surface via the app's own `await client.connect()`, not here.
   */
  ready(): Promise<void> {
    return this._readyPromise;
  }

  /**
   * Detach from the client: remove every handler this wrapper added,
   * unsubscribe its topics and lobby (when connected), clear state.
   * Terminal and idempotent; never touches the socket. To use dash again,
   * construct a new instance.
   */
  detach(): void {
    if (this._detached) return;
    this._log('Detaching...');
    this._detached = true;
    this._epoch++; // aborts any in-flight setup at its next checkpoint

    if (this._lobbyRefreshTimer) {
      clearTimeout(this._lobbyRefreshTimer);
      this._lobbyRefreshTimer = null;
    }

    // Remove all client handlers by stored ref
    this._client.off('connect', this._onConnectRef);
    this._client.off('disconnect', this._onDisconnectRef);
    this._client.off('reconnect', this._onReconnectRef);
    this._client.off('error', this._onErrorRef);
    this._client.off('replay:start', this._onReplayStartRef);
    this._client.off('replay:end', this._onReplayEndRef);
    this._client.off('presence:join', this._onPresenceJoinRef);
    this._client.off('presence:leave', this._onPresenceLeaveRef);
    this._client.off('presence:update', this._onPresenceUpdateRef);
    this._client.off('lobbyPresence:join', this._onLobbyJoinRef);
    this._client.off('lobbyPresence:leave', this._onLobbyLeaveRef);
    this._client.off('lobbyPresence:update', this._onLobbyUpdateRef);

    // Panels: handler-specific off + connected-gated server unsubscribe
    for (const name of [...this._panels.keys()]) {
      this._panels.get(name)!._cleanup();
      this._panels.delete(name);
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

    this._onlineViewers.clear();
    this._actorToViewerId.clear();
    this._localViewer = null;

    releaseWrapper(this._client, this._options.appName);

    if (!this._isReady) {
      this._readyReject(new Error('NoLagDash detached before ready'));
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
    this._log(this._isReady ? 'Restoring after reconnect...' : 'Setting up...');

    // Identity (client.actorId is guaranteed post-auth)
    if (!this._localViewer) {
      this._localViewer = {
        viewerId: this._viewerId,
        actorTokenId: this._client.actorId!,
        username: this._options.username,
        metadata: this._options.metadata,
        joinedAt: Date.now(),
        isLocal: true,
      };
      this._log('Local viewer:', this._localViewer.viewerId, '→', this._localViewer.actorTokenId);
    } else {
      this._localViewer.actorTokenId = this._client.actorId!;
    }

    // Lobby: subscribe every epoch (idempotent server-side) and diff-hydrate
    // from the returned snapshot — one path for setup and restore.
    if (!this._lobby) {
      this._lobby = this._client.setApp(this._options.appName).setLobby(LOBBY_ID);
    }
    try {
      const state = await this._lobby.subscribe();
      if (stale()) return;
      this._diffHydrateOnlineViewers(state);
      this._log('Lobby subscribed, online viewers:', this._onlineViewers.size);
    } catch (err) {
      if (stale()) return;
      this._log('Lobby subscription failed:', err);
    }

    if (!this._isReady) {
      // First successful setup: pre-subscribe configured panels
      for (const panelName of this._options.panels) {
        this._subscribePanelInternal(panelName);
      }
    } else {
      // Server auto-restored topic subscriptions; only panel-scoped presence
      // needs re-applying (the core does not restore it).
      for (const panel of this._panels.values()) {
        panel._updateLocalPresence();
      }
    }

    if (stale()) return;

    // Ready keys on the first setup that COMPLETES, not on epoch 1: an
    // epoch aborted by a racing reconnect must not strand ready().
    if (!this._isReady) {
      this._isReady = true;
      this._readyResolve();
      this.emit('connected');
    } else {
      this.emit('reconnected');
    }

    // Deferred lobby refetch: catches viewers who joined during the setup
    // window (e.g. simultaneous multi-tab connects).
    this._scheduleLobbyRefresh(epoch);
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
          this._diffHydrateOnlineViewers(state);
        })
        .catch(() => {
          /* best-effort */
        });
    }, LOBBY_REFRESH_DELAY_MS);
  }

  // ============ Panel Management ============

  /**
   * Join a dashboard panel. If the panel was pre-subscribed via the `panels`
   * option, activates it. Otherwise creates, subscribes, and activates it.
   */
  joinPanel(name: string, opts?: { metricFilters?: string[] }): DashboardPanel {
    this._assertUsable();

    let panel = this._panels.get(name);
    if (!panel) {
      panel = this._subscribePanelInternal(name, opts?.metricFilters);
    }
    panel._activate();
    return panel;
  }

  /**
   * Leave a dashboard panel. Fully unsubscribes and removes it.
   */
  leavePanel(name: string): void {
    const panel = this._panels.get(name);
    if (!panel) return;

    this._log('Leaving panel:', name);
    panel._cleanup();
    this._panels.delete(name);
  }

  /**
   * Get all joined panels.
   */
  getPanels(): DashboardPanel[] {
    return Array.from(this._panels.values());
  }

  // ============ Global Presence ============

  /**
   * Get all viewers currently online across all panels.
   */
  getOnlineViewers(): DashboardViewer[] {
    return Array.from(this._onlineViewers.values());
  }

  // ============ Private: Guards ============

  private _assertUsable(): void {
    if (this._detached) {
      throw new Error('NoLagDash has been detached — construct a new instance');
    }
    if (!this._isReady || !this._localViewer) {
      throw new Error('NoLagDash not ready — await ready() or the "connected" event');
    }
  }

  // ============ Private: Panel Setup ============

  private _subscribePanelInternal(name: string, metricFilters?: string[]): DashboardPanel {
    this._log('Subscribing panel:', name);

    const roomContext = this._client.setApp(this._options.appName).setRoom(name);
    const panel = new DashboardPanel(
      name,
      roomContext,
      this._viewerId,
      this._client.actorId!,
      this._options,
      createLogger(`DashPanel:${name}`, this._options.debug),
      () => this._client.connected,
    );

    this._panels.set(name, panel);
    panel._subscribe(metricFilters);

    return panel;
  }

  // ============ Private: Scope Filtering ============

  /**
   * On a shared client, presence events from other apps' wrappers arrive on
   * the same connection-level events. Wrappers stamp their presence with a
   * `__scope` (their appName); a mismatched tag means another app's data.
   * Untagged presence is accepted (older peers in this same app).
   */
  private _foreignScope(data: DashPresenceData | undefined): boolean {
    const scope = (data as Record<string, unknown> | undefined)?.__scope;
    return typeof scope === 'string' && scope !== this._options.appName;
  }

  // ============ Private: Room Presence → Panels ============

  private _handlePresenceJoin(data: ActorPresence): void {
    if (data.actorTokenId === this._localViewer?.actorTokenId) return;
    const pd = data.presence as unknown as DashPresenceData;
    if (!pd?.viewerId || this._foreignScope(pd)) return;

    const viewer = this._toViewer(data.actorTokenId, pd);
    this._actorToViewerId.set(data.actorTokenId, viewer.viewerId);
    if (!this._onlineViewers.has(viewer.viewerId)) {
      this._onlineViewers.set(viewer.viewerId, viewer);
      this.emit('viewerOnline', viewer);
    }
    for (const panel of this._panels.values()) {
      panel._handlePresenceJoin(data.actorTokenId, pd);
    }
  }

  private _handlePresenceLeave(data: ActorPresence): void {
    if (data.actorTokenId === this._localViewer?.actorTokenId) return;
    // Panel leave ≠ offline — viewer may still be on another panel.
    // Lobby leave handles actual offline status.
    for (const panel of this._panels.values()) {
      panel._handlePresenceLeave(data.actorTokenId);
    }
  }

  private _handlePresenceUpdate(data: ActorPresence): void {
    if (data.actorTokenId === this._localViewer?.actorTokenId) return;
    const pd = data.presence as unknown as DashPresenceData;
    if (!pd?.viewerId || this._foreignScope(pd)) return;
    for (const panel of this._panels.values()) {
      panel._handlePresenceUpdate(data.actorTokenId, pd);
    }
  }

  // ============ Private: Lobby ============

  private _handleLobbyJoin(event: LobbyPresenceEvent): void {
    const { actorId, data } = event;
    if (actorId === this._localViewer?.actorTokenId) return;

    const pd = data as unknown as DashPresenceData;
    if (!pd?.viewerId || this._foreignScope(pd)) return;

    const viewer = this._toViewer(actorId, pd);
    this._actorToViewerId.set(actorId, viewer.viewerId);
    if (!this._onlineViewers.has(viewer.viewerId)) {
      this._onlineViewers.set(viewer.viewerId, viewer);
      this.emit('viewerOnline', viewer);
    }
  }

  private _handleLobbyLeave(event: LobbyPresenceEvent): void {
    const { actorId, data } = event;
    if (actorId === this._localViewer?.actorTokenId) return;

    const pd = data as unknown as DashPresenceData;
    if (this._foreignScope(pd)) return;
    const viewerId = pd?.viewerId
      || this._actorToViewerId.get(actorId)
      || this._findViewerIdByActorId(actorId);

    if (viewerId) {
      const viewer = this._onlineViewers.get(viewerId);
      if (viewer) {
        this._onlineViewers.delete(viewerId);
        this._actorToViewerId.delete(actorId);
        this.emit('viewerOffline', viewer);
      }
    }
  }

  private _handleLobbyUpdate(event: LobbyPresenceEvent): void {
    const { actorId, data } = event;
    if (actorId === this._localViewer?.actorTokenId) return;

    const pd = data as unknown as DashPresenceData;
    if (!pd?.viewerId || this._foreignScope(pd)) return;

    const viewer = this._toViewer(actorId, pd);
    this._onlineViewers.set(viewer.viewerId, viewer);
  }

  /**
   * Reconcile the online-viewer map against a fresh lobby snapshot, emitting
   * only the deltas (viewerOffline for vanished, viewerOnline for new). One
   * path for initial hydration, reconnect restore, and the deferred refetch.
   */
  private _diffHydrateOnlineViewers(state: LobbyPresenceState): void {
    // Build the fresh viewer set from the snapshot
    const fresh = new Map<string, DashboardViewer>();
    const freshActors = new Map<string, string>();

    for (const roomId of Object.keys(state)) {
      const roomPresence = state[roomId];
      for (const actorId of Object.keys(roomPresence)) {
        if (actorId === this._localViewer?.actorTokenId) continue;

        const raw = roomPresence[actorId] as Record<string, unknown>;
        // Server returns full actor records with presence nested under .presence
        const pd = (raw?.presence ?? raw) as unknown as DashPresenceData;
        if (pd?.viewerId && !this._foreignScope(pd)) {
          if (!fresh.has(pd.viewerId)) {
            fresh.set(pd.viewerId, this._toViewer(actorId, pd));
          }
          freshActors.set(actorId, pd.viewerId);
        }
      }
    }

    // Vanished viewers
    for (const [viewerId, viewer] of [...this._onlineViewers]) {
      if (!fresh.has(viewerId)) {
        this._onlineViewers.delete(viewerId);
        for (const [actorId, mappedViewerId] of [...this._actorToViewerId]) {
          if (mappedViewerId === viewerId) this._actorToViewerId.delete(actorId);
        }
        this.emit('viewerOffline', viewer);
      }
    }

    // New viewers
    for (const [viewerId, viewer] of fresh) {
      if (!this._onlineViewers.has(viewerId)) {
        this._onlineViewers.set(viewerId, viewer);
        this.emit('viewerOnline', viewer);
      }
    }
    for (const [actorId, viewerId] of freshActors) {
      this._actorToViewerId.set(actorId, viewerId);
    }
  }

  // ============ Private: Helpers ============

  private _toViewer(actorTokenId: string, data: DashPresenceData): DashboardViewer {
    return {
      viewerId: data.viewerId,
      actorTokenId,
      username: data.username,
      metadata: data.metadata,
      joinedAt: Date.now(),
      isLocal: false,
    };
  }

  private _findViewerIdByActorId(actorTokenId: string): string | undefined {
    for (const viewer of this._onlineViewers.values()) {
      if (viewer.actorTokenId === actorTokenId) return viewer.viewerId;
    }
    return undefined;
  }
}
