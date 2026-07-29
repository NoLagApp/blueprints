# @nolag/notify

Real-time notifications SDK for [NoLag](https://nolag.app) — channels, read/unread tracking, and badge counts.

## How It Works with NoLag

NoLag is a real-time messaging platform that handles WebSocket connections, message routing, persistence, and scaling. This SDK wraps the low-level [@nolag/js-sdk](https://www.npmjs.com/package/@nolag/js-sdk) and gives you a purpose-built notification API — channels, read tracking, badge counts, and replay — without managing topics or subscriptions yourself.

### Getting Your Token

1. Sign up at [nolag.app](https://nolag.app)
2. Create a new **project** in the portal
3. Choose the **Notify** blueprint when creating an app — this pre-configures the topics (`notifications`, `_read`) and settings your notification system needs
4. Go to the app's **Tokens** page and generate an **actor token**
5. Use that token when connecting with this SDK

Each token identifies a unique user (actor) in NoLag. The blueprint handles all the infrastructure setup — you just build your notification UI.

## Install

```bash
npm install @nolag/js-sdk @nolag/notify
```

## Quick Start

The app owns one core NoLag client; wrappers attach to it. Any number of
wrapper SDKs (notify, chat, dash, ...) can share the same connection as
long as each uses its own app.

```typescript
import { NoLag } from "@nolag/js-sdk";
import { NoLagNotify } from "@nolag/notify";

// One client for the whole app. In a browser, use a token provider so the
// SDK can mint fresh short-lived client tokens from your backend.
const client = NoLag(async () => (await (await fetch("/api/nolag-token")).json()).token);
const notify = new NoLagNotify({ client, channels: ["alerts", "updates"] });

await client.connect();   // the app owns the connection
await notify.ready();      // wrapper setup done (identity, presence, channels)

// Listen for notifications
notify.on("notification", (n) => {
  console.log(`[${n.channel}] ${n.title}: ${n.body}`);
});

// Subscribe to a channel
const channel = notify.subscribe("alerts");

channel.on("notification", (n) => {
  showToast(n.title, n.body);
});

// Send a notification
channel.send("Deploy complete", {
  body: "v2.1.0 deployed to production",
  icon: "rocket",
  data: { version: "2.1.0" },
});

// Badge counts
const badges = notify.getBadgeCounts();
console.log(`Total unread: ${badges.total}`);

// Mark as read
channel.markRead(notificationId);
channel.markAllRead();

// Teardown: the wrapper releases its handlers and topics; the app closes
// the socket (never the other way around).
notify.detach();
client.disconnect();
```

## Lifecycle

- **Construction = attach.** The wrapper wires its handlers onto the injected
  client immediately. If the client is already connected, setup runs on the
  next microtask; otherwise it runs when the client's `connect` event fires.
- **`ready()`** resolves once the first setup completed (identity, online
  lobby, configured channels). Auth failures surface via your own
  `await client.connect()`, not via `ready()`.
- **Reconnects are automatic.** The wrapper reconciles the online presence
  list and channels restore transparently.
- **`detach()`** removes exactly this wrapper's handlers and topics and never
  touches the socket. It is terminal: construct a new instance to re-attach.
  Detach while the client is still connected so server-side unsubscribes go
  through. In frameworks, call it from your dispose hook (`onUnmounted`,
  HMR dispose).
- **One wrapper per (client, app).** Sharing a client across wrappers of
  DIFFERENT apps is the intended pattern; two wrappers on the same app would
  collide on topics and presence (the SDK warns if you do this).

## API Reference

### `NoLagNotify`

#### Constructor

```typescript
const notify = new NoLagNotify(options: NoLagNotifyOptions);
```

**Options:**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `client` | `NoLagSocket` | *required* | The injected core NoLag client |
| `channels` | `string[]` | — | Auto-subscribe to these channels on connect |
| `metadata` | `Record<string, unknown>` | — | Custom metadata |
| `appName` | `string` | `'notify'` | NoLag app for topic prefixes |
| `maxNotificationCache` | `number` | `500` | Max notifications kept in memory per channel |
| `debug` | `boolean` | `false` | Enable debug logging |

#### Methods

| Method | Returns | Description |
|--------|---------|-------------|
| `ready()` | `Promise<void>` | Resolves when wrapper setup completed |
| `detach()` | `void` | Release handlers and topics (terminal; never closes the socket) |
| `subscribe(channelName)` | `NotifyChannel` | Subscribe to a notification channel |
| `unsubscribe(channelName)` | `void` | Unsubscribe from a channel |
| `getBadgeCounts()` | `BadgeCounts` | Get unread counts (total + per channel) |
| `markAllRead()` | `void` | Mark all notifications as read |

#### Events

| Event | Payload | Description |
|-------|---------|-------------|
| `connected` | — | Connected to NoLag |
| `disconnected` | — | Disconnected |
| `reconnecting` | — | Reconnect attempt started |
| `reconnected` | — | Reconnected after disconnect |
| `error` | `Error` | Connection or protocol error |
| `notification` | `Notification` | Notification received on any channel |
| `badgeUpdated` | `BadgeCounts` | Badge counts changed |

### `NotifyChannel`

#### Methods

| Method | Returns | Description |
|--------|---------|-------------|
| `send(title, options?)` | `void` | Send a notification |
| `markRead(id)` | `void` | Mark a notification as read |
| `markAllRead()` | `void` | Mark all in this channel as read |
| `getNotifications()` | `Notification[]` | Get all cached notifications |
| `getUnread()` | `Notification[]` | Get unread notifications |

#### Properties

| Property | Type | Description |
|----------|------|-------------|
| `name` | `string` | Channel name |
| `notifications` | `Notification[]` | Cached notifications |
| `unreadCount` | `number` | Unread count |
| `active` | `boolean` | Whether currently subscribed |

#### Events

| Event | Payload | Description |
|-------|---------|-------------|
| `notification` | `Notification` | Notification received |
| `read` | `string` | Notification marked as read (id) |
| `readAll` | — | All marked as read |
| `replayStart` | — | Replay started |
| `replayEnd` | — | Replay finished |

## Types

```typescript
interface Notification {
  id: string;
  channel: string;
  title: string;
  body?: string;
  icon?: string;
  data?: Record<string, unknown>;
  timestamp: number;
  read: boolean;
  isReplay: boolean;
}

interface BadgeCounts {
  total: number;
  byChannel: Record<string, number>;
}

interface SendNotificationOptions {
  body?: string;
  icon?: string;
  data?: Record<string, unknown>;
}
```

## License

MIT
