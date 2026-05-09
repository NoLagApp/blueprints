# @nolag/dash

Live dashboard SDK for [NoLag](https://nolag.app) — real-time metrics, widgets, and data streams.

## How It Works with NoLag

NoLag is a real-time messaging platform that handles WebSocket connections, message routing, persistence, and scaling. This SDK wraps the low-level [@nolag/js-sdk](https://www.npmjs.com/package/@nolag/js-sdk) and gives you a purpose-built dashboard API — publish metrics, update widgets, and get live aggregations — without managing topics or subscriptions yourself.

### Getting Your Token

1. Sign up at [nolag.app](https://nolag.app)
2. Create a new **project** in the portal
3. Choose the **Dash** blueprint when creating an app — this pre-configures the topics (`metrics`, `widgets`) and settings your dashboard needs
4. Go to the app's **Tokens** page and generate an **actor token**
5. Use that token when connecting with this SDK

Each token identifies a unique viewer or data source (actor) in NoLag. The blueprint handles all the infrastructure setup — you just build your dashboard UI.

## Install

```bash
npm install @nolag/js-sdk @nolag/dash
```

## Quick Start

```typescript
import { NoLagDash } from "@nolag/dash";

const dash = new NoLagDash("YOUR_ACTOR_TOKEN");

await dash.connect();

const panel = dash.joinPanel("server-metrics");

// Publish metrics from a data source
panel.publishMetric("cpu", 72.5, { unit: "%", tags: { host: "web-01" } });
panel.publishMetric("memory", 4.2, { unit: "GB" });

// Listen for metrics on a dashboard viewer
panel.on("metric", (point) => {
  updateChart(point.streamId, point.value, point.timestamp);
});

// Widget updates (gauges, counters, tables, etc.)
panel.publishWidget("active-users", "counter", { value: 1423 }, "Active Users");
panel.publishWidget("status", "gauge", { value: 98.5, max: 100 }, "Uptime %");

panel.on("widgetUpdate", (widget) => {
  renderWidget(widget.widgetId, widget.type, widget.data);
});

// Aggregations
const agg = panel.getAggregation("cpu", 60_000); // last 60s
console.log(`CPU avg: ${agg.avg}%, max: ${agg.max}%`);
```

## API Reference

### `NoLagDash`

#### Constructor

```typescript
const dash = new NoLagDash(token: string, options?: NoLagDashOptions);
```

**Options:**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `username` | `string` | — | Display name |
| `metadata` | `Record<string, unknown>` | — | Custom data |
| `panels` | `string[]` | — | Auto-join these panels on connect |
| `maxMetricPoints` | `number` | — | Max metric points kept in memory |
| `aggregationWindow` | `number` | — | Default aggregation window (ms) |
| `debug` | `boolean` | `false` | Enable debug logging |
| `reconnect` | `boolean` | `true` | Auto-reconnect on disconnect |

#### Methods

| Method | Returns | Description |
|--------|---------|-------------|
| `connect()` | `Promise<void>` | Connect to NoLag |
| `disconnect()` | `void` | Disconnect |
| `joinPanel(name)` | `DashboardPanel` | Join a dashboard panel |
| `leavePanel(name)` | `void` | Leave a panel |

#### Events

| Event | Payload | Description |
|-------|---------|-------------|
| `connected` | — | Connected |
| `disconnected` | — | Disconnected |
| `reconnected` | — | Reconnected |
| `error` | `Error` | Error |
| `viewerOnline` | `DashboardViewer` | Viewer came online |
| `viewerOffline` | `DashboardViewer` | Viewer went offline |

### `DashboardPanel`

#### Methods

| Method | Returns | Description |
|--------|---------|-------------|
| `publishMetric(streamId, value, opts?)` | `MetricPoint` | Publish a metric data point |
| `publishWidget(widgetId, type, data, label?)` | `WidgetUpdate` | Update a widget |
| `getMetrics(streamId?)` | `MetricPoint[]` | Get cached metrics |
| `getAggregation(streamId, windowMs?)` | `Aggregation` | Get min/max/avg/sum/count |
| `getWidget(widgetId)` | `WidgetUpdate \| undefined` | Get a widget's last state |
| `getWidgets()` | `WidgetUpdate[]` | Get all widgets |
| `getViewers()` | `DashboardViewer[]` | Get viewers on this panel |

#### Events

| Event | Payload | Description |
|-------|---------|-------------|
| `metric` | `MetricPoint` | New metric point received |
| `widgetUpdate` | `WidgetUpdate` | Widget updated |
| `viewerJoined` | `DashboardViewer` | Viewer joined panel |
| `viewerLeft` | `DashboardViewer` | Viewer left panel |
| `replayStart` / `replayEnd` | — | Data replay |

## Types

```typescript
interface MetricPoint {
  id: string;
  streamId: string;
  value: number;
  unit?: string;
  tags?: Record<string, string>;
  timestamp: number;
  isReplay: boolean;
}

interface WidgetUpdate {
  id: string;
  widgetId: string;
  type: WidgetType;
  data: Record<string, unknown>;
  label?: string;
  timestamp: number;
  isReplay: boolean;
}

type WidgetType = "gauge" | "chart" | "counter" | "table" | "text" | "custom";

interface Aggregation {
  streamId: string;
  min: number;
  max: number;
  avg: number;
  sum: number;
  count: number;
  last: number;
  windowMs: number;
}
```

## License

MIT
