import type { NoLagSocket } from '@nolag/js-sdk';

export interface NoLagDashOptions {
  /**
   * The injected NoLag core client. The app owns its lifecycle: create it
   * with `NoLag(tokenOrProvider)`, call `connect()`/`disconnect()` yourself.
   * The wrapper only attaches protocol behavior on top and releases it
   * again via `detach()`. One wrapper per (client, appName).
   */
  client: NoLagSocket;
  /** Display name for this viewer */
  username?: string;
  /** Custom metadata attached to viewer presence */
  metadata?: Record<string, unknown>;
  /** NoLag app name (default: 'dash') */
  appName?: string;
  /** Max metric points kept in memory per stream (default: 1000) */
  maxMetricPoints?: number;
  /** Default aggregation window in ms (default: 60000) */
  aggregationWindow?: number;
  /** Enable debug logging for the wrapper (default: false) */
  debug?: boolean;
  /** List of panels to subscribe to on connect */
  panels?: string[];
}

export interface ResolvedDashOptions {
  username?: string;
  metadata?: Record<string, unknown>;
  appName: string;
  maxMetricPoints: number;
  aggregationWindow: number;
  debug: boolean;
  panels: string[];
}

export interface MetricPoint {
  id: string;
  streamId: string;
  value: number;
  unit?: string;
  tags?: Record<string, string>;
  timestamp: number;
  isReplay: boolean;
}

export type WidgetType = 'gauge' | 'chart' | 'counter' | 'table' | 'text' | 'custom';

export interface WidgetUpdate {
  id: string;
  widgetId: string;
  type: WidgetType;
  data: Record<string, unknown>;
  label?: string;
  timestamp: number;
  isReplay: boolean;
}

export type AggregationType = 'min' | 'max' | 'avg' | 'sum' | 'count' | 'last';

export interface Aggregation {
  streamId: string;
  min: number;
  max: number;
  avg: number;
  sum: number;
  count: number;
  last: number;
  windowMs: number;
}

export interface DashboardViewer {
  viewerId: string;
  actorTokenId: string;
  username?: string;
  metadata?: Record<string, unknown>;
  joinedAt: number;
  isLocal: boolean;
}

export interface DashPresenceData {
  [key: string]: unknown;
  viewerId: string;
  username?: string;
  metadata?: Record<string, unknown>;
}

export interface DashClientEvents {
  connected: [];
  disconnected: [reason: string];
  reconnecting: [];
  reconnected: [];
  error: [error: Error];
  viewerOnline: [viewer: DashboardViewer];
  viewerOffline: [viewer: DashboardViewer];
}

export interface DashPanelEvents {
  metric: [point: MetricPoint];
  widgetUpdate: [update: WidgetUpdate];
  viewerJoined: [viewer: DashboardViewer];
  viewerLeft: [viewer: DashboardViewer];
  replayStart: [data: { count: number }];
  replayEnd: [data: { replayed: number }];
}
