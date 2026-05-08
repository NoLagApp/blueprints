import type { RoomContext, MessageMeta } from '@nolag/js-sdk';
import { EventEmitter } from './EventEmitter';
import { MetricStore } from './MetricStore';
import { WidgetManager } from './WidgetManager';
import { PresenceManager } from './PresenceManager';
import { generateId } from './utils';
import { TOPIC_METRICS, TOPIC_WIDGETS } from './constants';
import type { DashPanelEvents, MetricPoint, WidgetUpdate, WidgetType, Aggregation, DashboardViewer, DashPresenceData, ResolvedDashOptions } from './types';

export class DashboardPanel extends EventEmitter<DashPanelEvents> {
  readonly name: string;
  private _roomContext: RoomContext;
  private _options: ResolvedDashOptions;
  private _presenceManager: PresenceManager;
  private _metricStore: MetricStore;
  private _widgetManager: WidgetManager;
  private _log: (...args: unknown[]) => void;
  private _localViewerId: string;

  constructor(name: string, roomContext: RoomContext, localViewerId: string, localActorId: string, options: ResolvedDashOptions, log: (...args: unknown[]) => void) {
    super();
    this.name = name;
    this._roomContext = roomContext;
    this._localViewerId = localViewerId;
    this._options = options;
    this._log = log;
    this._presenceManager = new PresenceManager(localActorId);
    this._metricStore = new MetricStore(options.maxMetricPoints);
    this._widgetManager = new WidgetManager();
  }

  publishMetric(streamId: string, value: number, opts?: { unit?: string; tags?: Record<string, string> }): MetricPoint {
    const point: MetricPoint = { id: generateId(), streamId, value, unit: opts?.unit, tags: opts?.tags, timestamp: Date.now(), isReplay: false };
    this._metricStore.add(point);
    this._roomContext.emit(TOPIC_METRICS, { id: point.id, streamId, value, unit: point.unit, tags: point.tags, timestamp: point.timestamp }, { echo: false });
    return point;
  }

  publishWidget(widgetId: string, type: WidgetType, data: Record<string, unknown>, label?: string): WidgetUpdate {
    const update: WidgetUpdate = { id: generateId(), widgetId, type, data, label, timestamp: Date.now(), isReplay: false };
    this._widgetManager.update(update);
    this._roomContext.emit(TOPIC_WIDGETS, { id: update.id, widgetId, type, data, label, timestamp: update.timestamp }, { echo: false });
    return update;
  }

  getMetrics(streamId?: string): MetricPoint[] { return this._metricStore.getAll(streamId); }
  getAggregation(streamId: string, windowMs?: number): Aggregation { return this._metricStore.getAggregation(streamId, windowMs); }
  getWidget(widgetId: string): WidgetUpdate | undefined { return this._widgetManager.get(widgetId); }
  getWidgets(): WidgetUpdate[] { return this._widgetManager.getAll(); }
  getViewers(): DashboardViewer[] { return this._presenceManager.getAll(); }

  _subscribe(): void {
    this._roomContext.subscribe(TOPIC_METRICS);
    this._roomContext.subscribe(TOPIC_WIDGETS);
    this._roomContext.on(TOPIC_METRICS, (data: unknown, meta: MessageMeta) => {
      const raw = data as Record<string, unknown>;
      const point: MetricPoint = { id: raw.id as string, streamId: raw.streamId as string, value: raw.value as number, unit: raw.unit as string | undefined, tags: raw.tags as Record<string, string> | undefined, timestamp: raw.timestamp as number, isReplay: meta.isReplay ?? false };
      if (this._metricStore.add(point)) this.emit('metric', point);
    });
    this._roomContext.on(TOPIC_WIDGETS, (data: unknown, meta: MessageMeta) => {
      const raw = data as Record<string, unknown>;
      const update: WidgetUpdate = { id: raw.id as string, widgetId: raw.widgetId as string, type: raw.type as WidgetType, data: raw.data as Record<string, unknown>, label: raw.label as string | undefined, timestamp: raw.timestamp as number, isReplay: meta.isReplay ?? false };
      this._widgetManager.update(update);
      this.emit('widgetUpdate', update);
    });
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
    this._roomContext.unsubscribe(TOPIC_METRICS);
    this._roomContext.unsubscribe(TOPIC_WIDGETS);
    this._roomContext.off(TOPIC_METRICS);
    this._roomContext.off(TOPIC_WIDGETS);
    this._metricStore.clear();
    this._widgetManager.clear();
    this._presenceManager.clear();
    this.removeAllListeners();
  }

  private _setPresence(): void {
    this._roomContext.setPresence({ viewerId: this._localViewerId, username: this._options.username, metadata: this._options.metadata } as DashPresenceData);
  }
}
