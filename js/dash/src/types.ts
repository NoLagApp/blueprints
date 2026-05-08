export interface NoLagDashOptions {
  username?: string;
  metadata?: Record<string, unknown>;
  appName?: string;
  url?: string;
  maxMetricPoints?: number;
  aggregationWindow?: number;
  debug?: boolean;
  reconnect?: boolean;
  panels?: string[];
}

export interface ResolvedDashOptions {
  username?: string;
  metadata?: Record<string, unknown>;
  appName: string;
  url?: string;
  maxMetricPoints: number;
  aggregationWindow: number;
  debug: boolean;
  reconnect: boolean;
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
