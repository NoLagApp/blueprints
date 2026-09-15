import type { RoomContext, MessageMeta } from '@nolag/js-sdk';
import { EventEmitter } from './EventEmitter';
import { MetricStore } from './MetricStore';
import { WidgetManager } from './WidgetManager';
import { PresenceManager } from './PresenceManager';
import { generateId, filterEmitOptions, mergeFilters, withoutFilters } from './utils';
import { TOPIC_METRICS, TOPIC_WIDGETS } from './constants';
import type { DashPanelEvents, MetricPoint, WidgetUpdate, WidgetType, Aggregation, DashboardViewer, DashPresenceData, ResolvedDashOptions, FilterValue, DashFilterOptions, DashFilterTopic } from './types';

/** Maps the public topic names onto the wire topics. */
const FILTER_TOPICS: Record<DashFilterTopic, string> = {
  metrics: TOPIC_METRICS,
  widgets: TOPIC_WIDGETS,
};

export class DashboardPanel extends EventEmitter<DashPanelEvents> {
  readonly name: string;
  private _roomContext: RoomContext;
  private _options: ResolvedDashOptions;
  private _presenceManager: PresenceManager;
  private _metricStore: MetricStore;
  private _widgetManager: WidgetManager;
  private _log: (...args: unknown[]) => void;
  private _localViewerId: string;
  private _isConnected: () => boolean;

  // Stored topic handler refs — cleanup removes exactly these, never all
  // handlers for a topic (the client may be shared with other consumers).
  private _onMetricsRef: ((data: unknown, meta: MessageMeta) => void) | null = null;
  private _onWidgetsRef: ((data: unknown, meta: MessageMeta) => void) | null = null;

  /**
   * Filter values applied per topic. Mirrors what was actually sent to the
   * server, including the `__none__` placeholder, so add/remove merge against
   * the real subscription rather than a cleaner-looking copy of it.
   */
  private _filters: Record<DashFilterTopic, FilterValue[]> = { metrics: [], widgets: [] };

  /** @internal */
  constructor(name: string, roomContext: RoomContext, localViewerId: string, localActorId: string, options: ResolvedDashOptions, log: (...args: unknown[]) => void, isConnected: () => boolean) {
    super();
    this.name = name;
    this._roomContext = roomContext;
    this._localViewerId = localViewerId;
    this._options = options;
    this._log = log;
    this._isConnected = isConnected;
    this._presenceManager = new PresenceManager(localActorId);
    this._metricStore = new MetricStore(options.maxMetricPoints);
    this._widgetManager = new WidgetManager();
  }

  publishMetric(streamId: string, value: number, opts?: { unit?: string; tags?: Record<string, string>; filter?: string; filters?: string[] }): MetricPoint {
    const point: MetricPoint = { id: generateId(), streamId, value, unit: opts?.unit, tags: opts?.tags, timestamp: Date.now(), isReplay: false };
    this._metricStore.add(point);
    this._roomContext.emit(TOPIC_METRICS, { id: point.id, streamId, value, unit: point.unit, tags: point.tags, timestamp: point.timestamp }, { echo: false, ...filterEmitOptions(opts) });
    return point;
  }

  // ============ Filters ============

  /** The filter values currently applied to this panel, by topic. */
  get filters(): Record<DashFilterTopic, FilterValue[]> {
    return { metrics: [...this._filters.metrics], widgets: [...this._filters.widgets] };
  }

  /**
   * Replace this panel's filters — only data published with one of these
   * values is delivered. Applies to metrics and widgets unless you scope the
   * call to one with `{ topic }`.
   *
   * Passing an empty array clears filtering and restores the wildcard
   * subscription, which receives everything.
   *
   * @example
   * ```ts
   * panel.setFilters(['cpu', 'mem']);                  // both topics
   * panel.setFilters(['cpu'], { topic: 'metrics' });   // metrics only
   * panel.setFilters([['cpu', 'prod']]);               // cpu AND prod
   * panel.setFilters([]);                               // everything
   * ```
   */
  setFilters(values: FilterValue[], opts?: DashFilterOptions): void {
    for (const topic of this._targetTopics(opts)) {
      this._filters[topic] = [...values];
      // The core types filters as `string[]`, but both its implementation and
      // the wire protocol accept AND groups (nested arrays).
      this._roomContext.setFilters(FILTER_TOPICS[topic], values as unknown as string[]);
    }
  }

  /** Add filter values to the existing set. Existing AND groups are kept. */
  addFilters(values: string[], opts?: DashFilterOptions): void {
    for (const topic of this._targetTopics(opts)) {
      this.setFilters(mergeFilters(this._filters[topic], values), { topic });
    }
  }

  /**
   * Remove filter values from the existing set. Removing the last value
   * restores the wildcard subscription.
   */
  removeFilters(values: string[], opts?: DashFilterOptions): void {
    for (const topic of this._targetTopics(opts)) {
      this.setFilters(withoutFilters(this._filters[topic], values), { topic });
    }
  }

  private _targetTopics(opts?: DashFilterOptions): DashFilterTopic[] {
    return opts?.topic ? [opts.topic] : (['metrics', 'widgets'] as DashFilterTopic[]);
  }

  /** Replace all metric filters — alias for `setFilters(values, { topic: 'metrics' })`. */
  setMetricFilters(filters: string[]): void {
    this.setFilters(filters, { topic: 'metrics' });
  }

  /** Add filter values to the existing metric filter set. */
  addMetricFilters(filters: string[]): void {
    this.addFilters(filters, { topic: 'metrics' });
  }

  /** Remove specific filter values from the metric filter set. */
  removeMetricFilters(filters: string[]): void {
    this.removeFilters(filters, { topic: 'metrics' });
  }

  publishWidget(widgetId: string, type: WidgetType, data: Record<string, unknown>, label?: string, opts?: { filter?: string; filters?: string[] }): WidgetUpdate {
    const update: WidgetUpdate = { id: generateId(), widgetId, type, data, label, timestamp: Date.now(), isReplay: false };
    this._widgetManager.update(update);
    this._roomContext.emit(TOPIC_WIDGETS, { id: update.id, widgetId, type, data, label, timestamp: update.timestamp }, { echo: false, ...filterEmitOptions(opts) });
    return update;
  }

  getMetrics(streamId?: string): MetricPoint[] { return this._metricStore.getAll(streamId); }
  getAggregation(streamId: string, windowMs?: number): Aggregation { return this._metricStore.getAggregation(streamId, windowMs); }
  getWidget(widgetId: string): WidgetUpdate | undefined { return this._widgetManager.get(widgetId); }
  getWidgets(): WidgetUpdate[] { return this._widgetManager.getAll(); }
  getViewers(): DashboardViewer[] { return this._presenceManager.getAll(); }

  _subscribe(metricFilters?: string[], filters?: FilterValue[]): void {
    if (filters && filters.length > 0) {
      // Uniform filter API: applies to both content topics, and an empty array
      // means "everything" (the wildcard), matching the other blueprint SDKs.
      this._filters = { metrics: [...filters], widgets: [...filters] };
      this._roomContext.subscribe(TOPIC_METRICS, { filters });
      this._roomContext.subscribe(TOPIC_WIDGETS, { filters });
      this._attachHandlers();
      return;
    }

    if (metricFilters !== undefined) {
      // Legacy `metricFilters` path. If empty array, use a no-match placeholder
      // to avoid wildcard subscription (which receives everything).
      const resolved = metricFilters.length > 0 ? metricFilters : ['__none__'];
      this._filters.metrics = [...resolved];
      this._roomContext.subscribe(TOPIC_METRICS, { filters: resolved });
    } else {
      this._roomContext.subscribe(TOPIC_METRICS);
    }
    this._roomContext.subscribe(TOPIC_WIDGETS);
    this._attachHandlers();
  }

  /** @internal Attach the metric and widget listeners. */
  private _attachHandlers(): void {

    // Listen for metrics (refs stored for handler-specific removal)
    this._onMetricsRef = (data: unknown, meta: MessageMeta) => {
      const raw = data as Record<string, unknown>;
      const point: MetricPoint = { id: raw.id as string, streamId: raw.streamId as string, value: raw.value as number, unit: raw.unit as string | undefined, tags: raw.tags as Record<string, string> | undefined, timestamp: raw.timestamp as number, isReplay: meta.isReplay ?? false };
      if (this._metricStore.add(point)) this.emit('metric', point);
    };
    this._roomContext.on(TOPIC_METRICS, this._onMetricsRef);

    // Listen for widget updates
    this._onWidgetsRef = (data: unknown, meta: MessageMeta) => {
      const raw = data as Record<string, unknown>;
      const update: WidgetUpdate = { id: raw.id as string, widgetId: raw.widgetId as string, type: raw.type as WidgetType, data: raw.data as Record<string, unknown>, label: raw.label as string | undefined, timestamp: raw.timestamp as number, isReplay: meta.isReplay ?? false };
      this._widgetManager.update(update);
      this.emit('widgetUpdate', update);
    };
    this._roomContext.on(TOPIC_WIDGETS, this._onWidgetsRef);
  }

  _activate(): void {
    this._setPresence();
    this._roomContext.fetchPresence().then((actors) => {
      for (const actor of actors) {
        if (actor.presence) { const v = this._presenceManager.addFromPresence(actor.actorTokenId, actor.presence as DashPresenceData, actor.joinedAt); if (v) this.emit('viewerJoined', v); }
      }
    }).catch(() => {});
  }

  _deactivate(): void { this._presenceManager.clear(); }
  _handlePresenceJoin(actorTokenId: string, pd: DashPresenceData): void { const v = this._presenceManager.addFromPresence(actorTokenId, pd); if (v) this.emit('viewerJoined', v); }
  _handlePresenceLeave(actorTokenId: string): void { const v = this._presenceManager.removeByActorId(actorTokenId); if (v) this.emit('viewerLeft', v); }
  _handlePresenceUpdate(actorTokenId: string, pd: DashPresenceData): void { this._presenceManager.addFromPresence(actorTokenId, pd); }
  _handleReplayStart(count: number): void { this.emit('replayStart', { count }); }
  _handleReplayEnd(replayed: number): void { this.emit('replayEnd', { replayed }); }
  _updateLocalPresence(): void { this._setPresence(); }

  _cleanup(): void {
    this._log('Panel cleanup:', this.name);

    // Server unsubscribes need a live socket; skip when disconnected
    // (best-effort — the core would no-op with an error callback anyway).
    if (this._isConnected()) {
      this._roomContext.unsubscribe(TOPIC_METRICS);
      this._roomContext.unsubscribe(TOPIC_WIDGETS);
    }

    // Handler-specific removal only: the client may be shared, and a bare
    // off(topic) would strip other consumers' handlers too.
    if (this._onMetricsRef) this._roomContext.off(TOPIC_METRICS, this._onMetricsRef);
    if (this._onWidgetsRef) this._roomContext.off(TOPIC_WIDGETS, this._onWidgetsRef);
    this._onMetricsRef = null;
    this._onWidgetsRef = null;

    this._metricStore.clear();
    this._widgetManager.clear();
    this._presenceManager.clear();
    this.removeAllListeners();
  }

  private _setPresence(): void {
    this._roomContext.setPresence({
      viewerId: this._localViewerId,
      username: this._options.username,
      metadata: this._options.metadata,
      // Scope tag: on a shared client, other apps' wrappers filter our
      // presence out by this (and we filter theirs).
      __scope: this._options.appName,
    } as DashPresenceData);
  }
}
