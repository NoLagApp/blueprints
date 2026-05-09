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

```typescript
import { NoLagNotify } from "@nolag/notify";

const notify = new NoLagNotify("YOUR_ACTOR_TOKEN", {
  channels: ["alerts", "updates"],
});

await notify.connect();

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
```

## API Reference

### `NoLagNotify`

#### Constructor

```typescript
const notify = new NoLagNotify(token: string, options?: NoLagNotifyOptions);
```

**Options:**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `channels` | `string[]` | — | Auto-subscribe to these channels on connect |
| `metadata` | `Record<string, unknown>` | — | Custom metadata |
| `maxNotificationCache` | `number` | `500` | Max notifications kept in memory per channel |
| `debug` | `boolean` | `false` | Enable debug logging |
| `reconnect` | `boolean` | `true` | Auto-reconnect on disconnect |

#### Methods

| Method | Returns | Description |
|--------|---------|-------------|
| `connect()` | `Promise<void>` | Connect to NoLag |
| `disconnect()` | `void` | Disconnect |
| `subscribe(channelName)` | `NotifyChannel` | Subscribe to a notification channel |
| `unsubscribe(channelName)` | `void` | Unsubscribe from a channel |
| `getBadgeCounts()` | `BadgeCounts` | Get unread counts (total + per channel) |
| `markAllRead()` | `void` | Mark all notifications as read |

#### Events

| Event | Payload | Description |
|-------|---------|-------------|
| `connected` | — | Connected to NoLag |
| `disconnected` | — | Disconnected |
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
