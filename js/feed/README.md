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

```typescript
import { NoLagFeed } from "@nolag/feed";

const feed = new NoLagFeed("YOUR_ACTOR_TOKEN", {
  username: "Alice",
});

await feed.connect();

const channel = feed.joinChannel("main");

// Create a post
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

// Real-time updates
channel.on("postLiked", (post) => {
  updateLikeCount(post.id, post.likeCount);
});
```

## API Reference

### `NoLagFeed`

#### Constructor

```typescript
const feed = new NoLagFeed(token: string, options: NoLagFeedOptions);
```

**Options:**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `username` | `string` | *required* | Display name |
| `avatar` | `string` | — | Avatar URL |
| `metadata` | `Record<string, unknown>` | — | Custom user data |
| `channels` | `string[]` | — | Auto-join these channels on connect |
| `maxPostCache` | `number` | `200` | Max posts kept in memory |
| `maxCommentCache` | `number` | `100` | Max comments per post |
| `debug` | `boolean` | `false` | Enable debug logging |
| `reconnect` | `boolean` | `true` | Auto-reconnect on disconnect |

#### Methods

| Method | Returns | Description |
|--------|---------|-------------|
| `connect()` | `Promise<void>` | Connect to NoLag |
| `disconnect()` | `void` | Disconnect |
| `joinChannel(name)` | `FeedChannel` | Join a feed channel |
| `leaveChannel(name)` | `void` | Leave a channel |
| `getOnlineUsers()` | `FeedUser[]` | Get all online users |

#### Events

| Event | Payload | Description |
|-------|---------|-------------|
| `connected` | — | Connected |
| `disconnected` | — | Disconnected |
| `reconnected` | — | Reconnected |
| `error` | `Error` | Error |
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
  status: "sending" | "sent" | "error";
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
