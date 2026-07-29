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

The app owns one core NoLag client; wrappers attach to it. Any number of
wrapper SDKs (dash, chat, notify, ...) can share the same connection as
long as each uses its own app.

```typescript
import { NoLag } from "@nolag/js-sdk";
import { NoLagDash } from "@nolag/dash";

// One client for the whole app. In a browser, use a token provider so the
// SDK can mint fresh short-lived client tokens from your backend.
const client = NoLag(async () => (await (await fetch("/api/nolag-token")).json()).token);
const dash = new NoLagDash({ client, username: "Alice" });

await client.connect();   // the app owns the connection
await dash.ready();       // wrapper setup done (identity, presence, panels)

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

// See who's watching
dash.on("viewerOnline", (viewer) => {
  console.log(`${viewer.username} is watching`);
});

// Teardown: the wrapper releases its handlers and topics; the app closes
// the socket (never the other way around).
dash.detach();
client.disconnect();
```

## Lifecycle

- **Construction = attach.** The wrapper wires its handlers onto the injected
  client immediately. If the client is already connected, setup runs on the
  next microtask; otherwise it runs when the client's `connect` event fires.
- **`ready()`** resolves once the first setup completed (identity, online
  lobby, configured panels). Auth failures surface via your own
  `await client.connect()`, not via `ready()`.
- **Reconnects are automatic.** The wrapper restores presence and reconciles
  the online-viewer list, emitting only real deltas.
- **`detach()`** removes exactly this wrapper's handlers and topics and never
  touches the socket. It is terminal: construct a new instance to re-attach.
  Detach while the client is still connected so server-side unsubscribes go
  through. In frameworks, call it from your dispose hook (`onUnmounted`,
  HMR dispose).
- **One wrapper per (client, app).** Sharing a client across wrappers of
  DIFFERENT apps is the intended pattern; two wrappers on the same app would
  collide on topics and presence (the SDK warns if you do this).

## API Reference

### `NoLagDash`

#### Constructor

```typescript
const dash = new NoLagDash(options: NoLagDashOptions);
```

**Options:**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `client` | `NoLagSocket` | *required* | The injected core NoLag client |
| `username` | `string` | — | Display name for this viewer |
| `metadata` | `Record<string, unknown>` | — | Custom viewer data |
| `appName` | `string` | `'dash'` | NoLag app for topic prefixes |
| `panels` | `string[]` | — | Auto-join these panels on connect |
| `maxMetricPoints` | `number` | `1000` | Max metric points kept in memory per stream |
| `aggregationWindow` | `number` | `60000` | Default aggregation window (ms) |
| `debug` | `boolean` | `false` | Enable wrapper debug logging |

#### Methods

| Method | Returns | Description |
|--------|---------|-------------|
| `ready()` | `Promise<void>` | Resolves when wrapper setup completed |
| `detach()` | `void` | Release handlers and topics (terminal; never closes the socket) |
| `joinPanel(name, opts?)` | `DashboardPanel` | Join a dashboard panel |
| `leavePanel(name)` | `void` | Leave a panel |
| `getPanels()` | `DashboardPanel[]` | Get all joined panels |
| `getOnlineViewers()` | `DashboardViewer[]` | Get all online viewers |

#### Properties

| Property | Type | Description |
|----------|------|-------------|
| `connected` | `boolean` | Whether currently connected |
| `localViewer` | `DashboardViewer \| null` | The current viewer |
| `panels` | `Map<string, DashboardPanel>` | All joined panels |

#### Events

| Event | Payload | Description |
|-------|---------|-------------|
| `connected` | — | Connected to NoLag |
| `disconnected` | `string` | Disconnected (reason) |
| `reconnecting` | — | Reconnect attempt started |
| `reconnected` | — | Reconnected after disconnect |
| `error` | `Error` | Connection or protocol error |
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
