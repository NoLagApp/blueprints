import type { NoLagOptions, LobbyPresenceEvent, LobbyPresenceState, LobbyContext, ActorPresence } from '@nolag/js-sdk';
import { NoLag } from '@nolag/js-sdk';
import { EventEmitter } from './EventEmitter';
import { DashboardPanel } from './DashboardPanel';
import { generateId, createLogger } from './utils';
import { DEFAULT_APP_NAME, DEFAULT_MAX_METRIC_POINTS, DEFAULT_AGGREGATION_WINDOW, LOBBY_ID } from './constants';
import type { NoLagDashOptions, ResolvedDashOptions, DashClientEvents, DashboardViewer, DashPresenceData } from './types';

type NoLagClient = ReturnType<typeof NoLag>;

export class NoLagDash extends EventEmitter<DashClientEvents> {
  private _token: string;
  private _options: ResolvedDashOptions;
  private _client: NoLagClient | null = null;
  private _panels = new Map<string, DashboardPanel>();
  private _lobby: LobbyContext | null = null;
  private _onlineViewers = new Map<string, DashboardViewer>();
  private _actorToViewerId = new Map<string, string>();
  private _viewerId: string;
  private _log: (...args: unknown[]) => void;

  constructor(token: string, options: NoLagDashOptions = {}) {
    super();
    this._token = token;
    this._viewerId = generateId();
    this._options = {
      username: options.username, metadata: options.metadata, appName: options.appName ?? DEFAULT_APP_NAME,
      url: options.url, maxMetricPoints: options.maxMetricPoints ?? DEFAULT_MAX_METRIC_POINTS,
      aggregationWindow: options.aggregationWindow ?? DEFAULT_AGGREGATION_WINDOW,
      debug: options.debug ?? false, reconnect: options.reconnect ?? true, panels: options.panels ?? [],
    };
    this._log = createLogger('NoLagDash', this._options.debug);
  }

  get connected(): boolean { return this._client?.connected ?? false; }
  get panels(): Map<string, DashboardPanel> { return this._panels; }

  async connect(): Promise<void> {
    const clientOptions: NoLagOptions = { debug: this._options.debug, reconnect: this._options.reconnect };
    if (this._options.url) clientOptions.url = this._options.url;
    this._client = NoLag(this._token, clientOptions);

    this._client.on('connect', () => { if (this._panels.size > 0) { this._restorePanels(); this.emit('reconnected'); } });
    this._client.on('disconnect', (reason: string) => this.emit('disconnected', reason));
    this._client.on('error', (error: Error) => this.emit('error', error));
    this._client.on('replay:start', (data: unknown) => { for (const p of this._panels.values()) p._handleReplayStart((data as any).count); });
    this._client.on('replay:end', (data: unknown) => { for (const p of this._panels.values()) p._handleReplayEnd((data as any).replayed); });

    await this._client.connect();

    this._client.on('presence:join', (data: ActorPresence) => this._handlePresenceJoin(data));
    this._client.on('presence:leave', (data: ActorPresence) => this._handlePresenceLeave(data));
    this._client.on('presence:update', (data: ActorPresence) => this._handlePresenceUpdate(data));

    await this._setupLobby();
    for (const name of this._options.panels) this._subscribePanel(name);
    this.emit('connected');
    setTimeout(() => { if (this._lobby && this._client?.connected) this._lobby.fetchPresence().then(s => this._hydrateViewers(s)).catch(() => {}); }, 2000);
  }

  disconnect(): void {
    for (const name of [...this._panels.keys()]) this.leavePanel(name);
    this._lobby?.unsubscribe(); this._lobby = null;
    this._client?.disconnect(); this._client = null;
    this._onlineViewers.clear(); this._actorToViewerId.clear();
  }

  joinPanel(name: string, opts?: { metricFilters?: string[] }): DashboardPanel {
    if (!this._client) throw new Error('Not connected — call connect() first');
    let panel = this._panels.get(name);
    if (!panel) panel = this._subscribePanel(name, opts?.metricFilters);
    panel._activate();
    return panel;
  }

  leavePanel(name: string): void {
    const panel = this._panels.get(name);
    if (!panel) return;
    panel._cleanup();
    this._panels.delete(name);
  }

  private _subscribePanel(name: string, metricFilters?: string[]): DashboardPanel {
    if (!this._client) throw new Error('Not connected');
    const roomContext = this._client.setApp(this._options.appName).setRoom(name);
    const panel = new DashboardPanel(name, roomContext, this._viewerId, this._client.actorId!, this._options, createLogger(`DashPanel:${name}`, this._options.debug));
    this._panels.set(name, panel);
    panel._subscribe(metricFilters);
    return panel;
  }

  private _handlePresenceJoin(data: ActorPresence): void {
    if (data.actorTokenId === this._client?.actorId) return;
    const pd = data.presence as unknown as DashPresenceData;
    if (!pd?.viewerId) return;
    const viewer = this._toViewer(data.actorTokenId, pd);
    this._actorToViewerId.set(data.actorTokenId, viewer.viewerId);
    if (!this._onlineViewers.has(viewer.viewerId)) { this._onlineViewers.set(viewer.viewerId, viewer); this.emit('viewerOnline', viewer); }
    for (const p of this._panels.values()) p._handlePresenceJoin(data.actorTokenId, pd);
  }

  private _handlePresenceLeave(data: ActorPresence): void {
    if (data.actorTokenId === this._client?.actorId) return;
    for (const p of this._panels.values()) p._handlePresenceLeave(data.actorTokenId);
  }

  private _handlePresenceUpdate(data: ActorPresence): void {
    if (data.actorTokenId === this._client?.actorId) return;
    const pd = data.presence as unknown as DashPresenceData;
    if (!pd?.viewerId) return;
    for (const p of this._panels.values()) p._handlePresenceUpdate(data.actorTokenId, pd);
  }

  private async _setupLobby(): Promise<void> {
    if (!this._client) return;
    this._lobby = this._client.setApp(this._options.appName).setLobby(LOBBY_ID);
    const lh = (type: 'join' | 'leave') => (data: unknown) => {
      const e = data as LobbyPresenceEvent;
      if (type === 'join') {
        const pd = e.data as unknown as DashPresenceData;
        if (e.actorId !== this._client?.actorId && pd?.viewerId) {
          const v = this._toViewer(e.actorId, pd);
          this._actorToViewerId.set(e.actorId, v.viewerId);
          if (!this._onlineViewers.has(v.viewerId)) { this._onlineViewers.set(v.viewerId, v); this.emit('viewerOnline', v); }
        }
      } else {
        if (e.actorId !== this._client?.actorId) {
          const vid = this._actorToViewerId.get(e.actorId);
          if (vid) { const v = this._onlineViewers.get(vid); if (v) { this._onlineViewers.delete(vid); this._actorToViewerId.delete(e.actorId); this.emit('viewerOffline', v); } }
        }
      }
    };
    this._client.on('lobbyPresence:join', lh('join'));
    this._client.on('lobbyPresence:leave', lh('leave'));
    this._client.on('lobbyPresence:update', lh('join'));
    try { const s = await this._lobby.subscribe(); this._hydrateViewers(s); } catch {}
  }

  private _hydrateViewers(state: LobbyPresenceState): void {
    for (const rid of Object.keys(state)) {
      for (const aid of Object.keys(state[rid])) {
        if (aid === this._client?.actorId) continue;
        const raw = state[rid][aid] as Record<string, unknown>;
        const pd = (raw?.presence ?? raw) as unknown as DashPresenceData;
        if (pd?.viewerId) {
          const v = this._toViewer(aid, pd);
          this._actorToViewerId.set(aid, v.viewerId);
          if (!this._onlineViewers.has(v.viewerId)) { this._onlineViewers.set(v.viewerId, v); this.emit('viewerOnline', v); }
        }
      }
    }
  }

  private _toViewer(actorTokenId: string, data: DashPresenceData): DashboardViewer {
    return { viewerId: data.viewerId, actorTokenId, username: data.username, metadata: data.metadata, joinedAt: Date.now(), isLocal: false };
  }

  private _restorePanels(): void {
    for (const p of this._panels.values()) p._updateLocalPresence();
    this._lobby?.fetchPresence().then(s => { this._onlineViewers.clear(); this._actorToViewerId.clear(); this._hydrateViewers(s); }).catch(() => {});
  }
}
