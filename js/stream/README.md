# @nolag/stream

Live streaming engagement SDK for [NoLag](https://nolag.app) — comments, reactions, polls, and viewer tracking.

## How It Works with NoLag

NoLag is a real-time messaging platform that handles WebSocket connections, message routing, persistence, and scaling. This SDK wraps the low-level [@nolag/js-sdk](https://www.npmjs.com/package/@nolag/js-sdk) and gives you a purpose-built API for live stream engagement — real-time comments, reaction bursts, live polls, and viewer counts — without managing topics or subscriptions yourself.

### Getting Your Token

1. Sign up at [nolag.app](https://nolag.app)
2. Create a new **project** in the portal
3. Choose the **Stream** blueprint when creating an app — this pre-configures the topics (`comments`, `_reactions`, `polls`) and settings your streaming app needs
4. Go to the app's **Tokens** page and generate an **actor token**
5. Use that token when connecting with this SDK

Each token identifies a unique viewer (actor) in NoLag. The blueprint handles all the infrastructure setup — you just build your streaming UI.

## Install

```bash
npm install @nolag/js-sdk @nolag/stream
```

## Quick Start

The app owns one core NoLag client; wrappers attach to it. Any number of
wrapper SDKs (stream, chat, dash, ...) can share the same connection as
long as each uses its own app.

```typescript
import { NoLag } from "@nolag/js-sdk";
import { NoLagStream } from "@nolag/stream";

// One client for the whole app. In a browser, use a token provider so the
// SDK can mint fresh short-lived client tokens from your backend.
const client = NoLag(async () => (await (await fetch("/api/nolag-token")).json()).token);
const stream = new NoLagStream({ client, username: "Alice", role: "viewer" });

await client.connect();   // the app owns the connection
await stream.ready();     // wrapper setup done (identity, presence, streams)

const room = stream.joinStream("friday-show");

// Live comments
room.on("comment", (c) => {
  console.log(`${c.username}: ${c.text}`);
});
room.sendComment("Great stream!");

// Reactions
room.on("reaction", (burst) => {
  animateReaction(burst.emoji, burst.count);
});
room.sendReaction("🔥");

// Polls (host/moderator only)
room.createPoll({
  question: "What should we build next?",
  options: ["Chat app", "Dashboard", "Game"],
});

// Viewers can vote
room.on("pollCreated", (poll) => {
  room.votePoll(poll.id, 0); // vote for first option
});

// Viewer count
stream.on("viewerCountChanged", (count) => {
  updateViewerBadge(count);
});

// Teardown: the wrapper releases its handlers and topics; the app closes
// the socket (never the other way around).
stream.detach();
client.disconnect();
```

## Lifecycle

- **Construction = attach.** The wrapper wires its handlers onto the injected
  client immediately. If the client is already connected, setup runs on the
  next microtask; otherwise it runs when the client's `connect` event fires.
- **`ready()`** resolves once the first setup completed (identity, online
  lobby, configured streams). Auth failures surface via your own
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

### `NoLagStream`

#### Constructor

```typescript
const stream = new NoLagStream(options: NoLagStreamOptions);
```

**Options:**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `client` | `NoLagSocket` | *required* | The injected core NoLag client |
| `username` | `string` | *required* | Display name |
| `avatar` | `string` | — | Avatar URL |
| `role` | `ViewerRole` | `'viewer'` | `'viewer'`, `'moderator'`, or `'host'` |
| `metadata` | `Record<string, unknown>` | — | Custom data |
| `appName` | `string` | `'stream'` | NoLag app for topic prefixes |
| `streams` | `string[]` | — | Auto-join these streams on connect |
| `maxCommentCache` | `number` | `500` | Max comments kept in memory |
| `reactionWindow` | `number` | `3000` | Reaction aggregation window (ms) |
| `debug` | `boolean` | `false` | Enable debug logging |

#### Methods

| Method | Returns | Description |
|--------|---------|-------------|
| `ready()` | `Promise<void>` | Resolves when wrapper setup completed |
| `detach()` | `void` | Release handlers and topics (terminal; never closes the socket) |
| `joinStream(name)` | `StreamRoom` | Join a stream |
| `leaveStream(name)` | `void` | Leave a stream |
| `getRooms()` | `StreamRoom[]` | Get all joined streams |
| `getOnlineViewers()` | `StreamViewer[]` | Get all online viewers |

#### Properties

| Property | Type | Description |
|----------|------|-------------|
| `connected` | `boolean` | Whether currently connected |
| `localViewer` | `StreamViewer \| null` | The current viewer |
| `rooms` | `Map<string, StreamRoom>` | All joined streams |
| `viewerCount` | `number` | Total viewers across all streams (includes you) |

#### Events

| Event | Payload | Description |
|-------|---------|-------------|
| `connected` | — | Connected to NoLag |
| `disconnected` | `string` | Disconnected |
| `reconnecting` | — | Reconnecting after disconnect |
| `reconnected` | — | Reconnected after disconnect |
| `error` | `Error` | Connection or protocol error |
| `viewerOnline` | `StreamViewer` | Viewer came online |
| `viewerOffline` | `StreamViewer` | Viewer went offline |
| `viewerCountChanged` | `number` | Total viewer count changed |

### `StreamRoom`

#### Methods

| Method | Returns | Description |
|--------|---------|-------------|
| `sendComment(text, options?)` | `StreamComment` | Send a comment |
| `getComments()` | `StreamComment[]` | Get cached comments |
| `sendReaction(emoji)` | `void` | Send a reaction |
| `createPoll(options)` | `Poll` | Create a poll (host/moderator) |
| `votePoll(pollId, optionIndex)` | `void` | Vote on a poll |
| `closePoll(pollId)` | `void` | Close a poll (host/moderator) |
| `getViewers()` | `StreamViewer[]` | Get viewers in this stream |

#### Properties

| Property | Type | Description |
|----------|------|-------------|
| `name` | `string` | Stream name |
| `comments` | `StreamComment[]` | Cached comments |
| `activePoll` | `Poll \| undefined` | Currently active poll |
| `viewerCount` | `number` | Viewers in this stream |

#### Events

| Event | Payload | Description |
|-------|---------|-------------|
| `comment` | `StreamComment` | New comment |
| `commentSent` | `StreamComment` | Your comment confirmed |
| `reaction` | `ReactionBurst` | Reaction burst |
| `pollCreated` | `Poll` | Poll created |
| `pollUpdated` | `Poll` | Poll votes updated |
| `pollClosed` | `Poll` | Poll closed |
| `viewerJoined` | `StreamViewer` | Viewer joined |
| `viewerLeft` | `StreamViewer` | Viewer left |
| `viewerCountChanged` | `number` | Viewer count changed |
| `replayStart` / `replayEnd` | — | Comment replay |

## Types

```typescript
interface StreamViewer {
  viewerId: string;
  actorTokenId: string;
  username: string;
  avatar?: string;
  role: ViewerRole;
  metadata?: Record<string, unknown>;
  joinedAt: number;
  isLocal: boolean;
}

interface StreamComment {
  id: string;
  viewerId: string;
  username: string;
  avatar?: string;
  text: string;
  data?: Record<string, unknown>;
  timestamp: number;
  status: "sending" | "sent" | "error";
  isReplay: boolean;
}

interface Poll {
  id: string;
  question: string;
  options: PollOption[];
  createdBy: string;
  closed: boolean;
  totalVotes: number;
  timestamp: number;
}

interface ReactionBurst {
  emoji: string;
  count: number;
  windowStart: number;
  windowEnd: number;
}

type ViewerRole = "viewer" | "moderator" | "host";
```

## License

MIT
