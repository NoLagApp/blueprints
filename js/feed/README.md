# @nolag/feed

Activity feeds SDK for [NoLag](https://nolag.app) — real-time posts, likes, comments, and fan-out.

## How It Works with NoLag

NoLag is a real-time messaging platform that handles WebSocket connections, message routing, persistence, and scaling. This SDK wraps the low-level [@nolag/js-sdk](https://www.npmjs.com/package/@nolag/js-sdk) and gives you a purpose-built feed API — posts with media, likes, threaded comments, and real-time updates — without managing topics or subscriptions yourself.

### Getting Your Token

1. Sign up at [nolag.app](https://nolag.app)
2. Create a new **project** in the portal
3. Choose the **Feed** blueprint when creating an app — this pre-configures the topics (`posts`, `reactions`, `comments`) and settings your feed needs
4. Go to the app's **Tokens** page and generate an **actor token**
5. Use that token when connecting with this SDK

Each token identifies a unique user (actor) in NoLag. The blueprint handles all the infrastructure setup — you just build your feed UI.

## Install

```bash
npm install @nolag/js-sdk @nolag/feed
```

## Quick Start

The app owns one core NoLag client; wrappers attach to it. Any number of
wrapper SDKs (feed, chat, notify, ...) can share the same connection as
long as each uses its own app.

```typescript
import { NoLag } from "@nolag/js-sdk";
import { NoLagFeed } from "@nolag/feed";

// One client for the whole app. In a browser, use a token provider so the
// SDK can mint fresh short-lived client tokens from your backend.
const client = NoLag(async () => (await (await fetch("/api/nolag-token")).json()).token);
const feed = new NoLagFeed({ client, username: "Alice" });

await client.connect();   // the app owns the connection
await feed.ready();       // wrapper setup done (identity, presence, channels)

// Join a channel and create a post
const channel = feed.joinChannel("main");
channel.createPost({
  content: "Just shipped v2.0!",
  media: [{ type: "image", url: "https://example.com/screenshot.png" }],
});

// Listen for new posts
channel.on("postCreated", (post) => {
  console.log(`${post.username}: ${post.content}`);
});

// Likes and comments
channel.likePost(postId);
channel.addComment(postId, "Congrats!");

// Real-time reaction updates
channel.on("postLiked", ({ postId, likeCount }) => {
  updateLikeCount(postId, likeCount);
});

// See who's online
feed.on("userOnline", (user) => {
  console.log(`${user.username} came online`);
});

// Teardown: the wrapper releases its handlers and topics; the app closes
// the socket (never the other way around).
feed.detach();
client.disconnect();
```

## Lifecycle

- **Construction = attach.** The wrapper wires its handlers onto the injected
  client immediately. If the client is already connected, setup runs on the
  next microtask; otherwise it runs when the client's `connect` event fires.
- **`ready()`** resolves once the first setup completed (identity, online
  lobby, configured channels). Auth failures surface via your own
  `await client.connect()`, not via `ready()`.
- **Reconnects are automatic.** The wrapper restores presence and reconciles
  the online-user list, emitting only real deltas.
- **`detach()`** removes exactly this wrapper's handlers and topics and never
  touches the socket. It is terminal: construct a new instance to re-attach.
  Detach while the client is still connected so server-side unsubscribes go
  through. In frameworks, call it from your dispose hook (`onUnmounted`,
  HMR dispose).
- **One wrapper per (client, app).** Sharing a client across wrappers of
  DIFFERENT apps is the intended pattern; two wrappers on the same app would
  collide on topics and presence (the SDK warns if you do this).

## API Reference

### `NoLagFeed`

#### Constructor

```typescript
const feed = new NoLagFeed(options: NoLagFeedOptions);
```

**Options:**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `client` | `NoLagSocket` | *required* | The injected core NoLag client |
| `username` | `string` | *required* | Display name |
| `avatar` | `string` | — | Avatar URL |
| `metadata` | `Record<string, unknown>` | — | Custom user data |
| `appName` | `string` | `'feed'` | NoLag app for topic prefixes |
| `channels` | `string[]` | — | Auto-join these channels on connect |
| `maxPostCache` | `number` | `200` | Max posts kept in memory |
| `maxCommentCache` | `number` | `100` | Max comments per post |
| `debug` | `boolean` | `false` | Enable debug logging |

#### Methods

| Method | Returns | Description |
|--------|---------|-------------|
| `ready()` | `Promise<void>` | Resolves when wrapper setup completed |
| `detach()` | `void` | Release handlers and topics (terminal; never closes the socket) |
| `joinChannel(name)` | `FeedChannel` | Join a feed channel |
| `leaveChannel(name)` | `void` | Leave a channel |
| `getChannels()` | `FeedChannel[]` | Get all joined channels |
| `getOnlineUsers()` | `FeedUser[]` | Get all online users |
| `updateProfile(updates)` | `void` | Update username, avatar, or metadata |

#### Properties

| Property | Type | Description |
|----------|------|-------------|
| `connected` | `boolean` | Whether currently connected |
| `client` | `NoLagSocket` | The injected core client |
| `localUser` | `FeedUser \| null` | The current user |
| `channels` | `Map<string, FeedChannel>` | All joined channels |

#### Events

| Event | Payload | Description |
|-------|---------|-------------|
| `connected` | — | Connected to NoLag |
| `disconnected` | `reason` | Disconnected |
| `reconnecting` | — | Reconnect in progress |
| `reconnected` | — | Reconnected after disconnect |
| `error` | `Error` | Connection or protocol error |
| `userOnline` | `FeedUser` | User came online |
| `userOffline` | `FeedUser` | User went offline |

### `FeedChannel`

#### Methods

| Method | Returns | Description |
|--------|---------|-------------|
| `createPost(options)` | `FeedPost` | Create a post |
| `getPosts()` | `FeedPost[]` | Get cached posts |
| `likePost(postId)` | `void` | Like a post |
| `unlikePost(postId)` | `void` | Unlike a post |
| `addComment(postId, text)` | `FeedComment` | Add a comment |
| `getComments(postId)` | `FeedComment[]` | Get comments for a post |
| `markRead()` | `void` | Mark all posts as read |
| `getUsers()` | `FeedUser[]` | Get users in this channel |

#### Properties

| Property | Type | Description |
|----------|------|-------------|
| `name` | `string` | Channel name |
| `posts` | `FeedPost[]` | Cached posts |
| `unreadCount` | `number` | Unread post count |
| `active` | `boolean` | Whether currently joined |

#### Events

| Event | Payload | Description |
|-------|---------|-------------|
| `postCreated` | `FeedPost` | New post |
| `postSent` | `FeedPost` | Your post confirmed |
| `postLiked` | `FeedPost` | Post was liked |
| `postUnliked` | `FeedPost` | Post was unliked |
| `commentAdded` | `FeedComment` | New comment |
| `commentSent` | `FeedComment` | Your comment confirmed |
| `subscriberJoined` | `FeedUser` | User joined channel |
| `subscriberLeft` | `FeedUser` | User left channel |
| `replayStart` / `replayEnd` | — | Post replay |
| `unreadChanged` | `number` | Unread count changed |

## Types

```typescript
interface FeedPost {
  id: string;
  userId: string;
  username: string;
  avatar?: string;
  content: string;
  media?: MediaAttachment[];
  data?: Record<string, unknown>;
  likeCount: number;
  commentCount: number;
  likedByMe: boolean;
  timestamp: number;
  status: "sending" | "sent" | "delivered";
  isReplay: boolean;
}

interface FeedComment {
  id: string;
  postId: string;
  userId: string;
  username: string;
  avatar?: string;
  text: string;
  timestamp: number;
  isReplay: boolean;
}

interface MediaAttachment {
  type: "image" | "video" | "link";
  url: string;
  thumbnail?: string;
  title?: string;
}
```

## License

MIT
