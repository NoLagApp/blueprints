# NoLag Blueprints

## What is NoLag?

[NoLag](https://nolag.app) is a real-time messaging platform. It handles the infrastructure for pub/sub messaging, presence, message replay, and more — so you can focus on building your app instead of managing WebSocket servers, scaling, and message persistence.

## What are Blueprints?

Blueprints are **pre-built, open-source SDK packages** that wrap the low-level [NoLag JS SDK](https://www.npmjs.com/package/@nolag/js-sdk) into high-level, use-case-specific libraries. Instead of wiring up topics, subscriptions, and message handling yourself, you install a blueprint SDK and get a purpose-built API out of the box.

For example, `@nolag/chat` gives you `joinRoom()`, `sendMessage()`, `startTyping()`, and presence tracking — all backed by NoLag's real-time infrastructure. No need to figure out which topics to create, how to structure payloads, or how to handle reconnects.

Each blueprint also includes:

- A **`blueprint.json`** definition that pre-configures the NoLag platform (topics, rooms, lobbies, rate limits) so your app works immediately after setup
- A **runnable example app** so you can see it working before writing any code

## Available SDKs

| SDK | Package | What it does |
|-----|---------|--------------|
| **chat** | `@nolag/chat` | Multi-room chat with presence, typing indicators, and message replay |
| **notify** | `@nolag/notify` | In-app notifications with read/unread tracking |
| **signal** | `@nolag/signal` | WebRTC signaling for video and audio calls |
| **stream** | `@nolag/stream` | Live streaming with comments, reactions, and polls |
| **feed** | `@nolag/feed` | Social feeds and activity streams |
| **dash** | `@nolag/dash` | Real-time dashboards and monitoring widgets |
| **track** | `@nolag/track` | Location tracking and geofencing |
| **sync** | `@nolag/sync` | Collaborative document sync |
| **queue** | `@nolag/queue` | Background job queues with progress tracking |
| **iot** | `@nolag/iot` | IoT device telemetry and command dispatch |
| **collab** | `@nolag/collab` | Real-time collaborative editing with live cursors |

## Quick Start

### Prerequisites

- Node.js >= 18
- A free [NoLag](https://nolag.app) account and API token

### 1. Clone and install

```bash
git clone https://github.com/NoLagApp/blueprints.git
cd blueprints
npm install
```

### 2. Build all SDKs

```bash
npm run build
```

### 3. Run an example app

Each blueprint has a demo app in `blueprints/<sdk>/example-app/` that you can run with Vite — no build step needed, it uses CDN for styling:

```bash
cd blueprints/chat/example-app
npm install
npx vite
```

Open the URL Vite prints and you'll see a working chat app. You'll need to provide your NoLag API token in the UI to connect.

## Using an SDK in Your Project

Install the blueprint SDK alongside the core NoLag SDK:

```bash
npm install @nolag/js-sdk @nolag/chat
```

```typescript
import { NoLagChat } from "@nolag/chat";

// Connect with your API token
const chat = new NoLagChat(token, {
  username: "Alice",
  rooms: ["general", "random"],
});

await chat.connect();

// Join a room and start chatting
const room = chat.joinRoom("general");

room.on("message", (msg) => {
  console.log(`${msg.username}: ${msg.text}`);
});

room.sendMessage("Hello, world!");

// Presence — see who's online
chat.on("userOnline", (user) => {
  console.log(`${user.username} joined`);
});

// Typing indicators
room.startTyping(); // auto-stops after timeout
```

Each SDK follows the same pattern: create an instance with your token, connect, and use the high-level API. Check the source in `js/<sdk>/src/` for the full API.

## Running Tests

Every SDK has unit tests written with [Vitest](https://vitest.dev/).

```bash
# Run tests for all SDKs
npm test

# Run tests for a specific SDK
npm test -w @nolag/chat

# Watch mode (useful during development)
cd js/chat
npx vitest
```

## Repository Structure

```
blueprints/
├── js/                           # SDK source packages (npm workspaces)
│   ├── chat/
│   │   ├── src/                  # TypeScript source
│   │   │   ├── NoLagChat.ts      # Main class
│   │   │   ├── ChatRoom.ts       # Room management
│   │   │   ├── PresenceManager.ts
│   │   │   ├── TypingManager.ts
│   │   │   ├── MessageStore.ts
│   │   │   └── types.ts
│   │   ├── tests/unit/           # Vitest unit tests
│   │   ├── dist/                 # Build output (CJS, ESM, UMD)
│   │   ├── rollup.config.js
│   │   └── package.json
│   ├── notify/
│   ├── signal/
│   ├── ...                       # (11 SDKs total)
│   └── rollup.shared.js          # Shared Rollup build config
│
├── blueprints/                   # Blueprint definitions
│   ├── chat/
│   │   ├── blueprint.json        # Platform config + inline demo files
│   │   └── example-app/          # Runnable Vite demo app
│   ├── notify/
│   ├── ...
│   └── legacy/                   # Older POC blueprints
│
├── tools/
│   └── sync-blueprints/          # CLI to sync example-app <-> blueprint.json
│
├── go/                           # Go SDKs (planned)
├── python/                       # Python SDKs (planned)
├── package.json                  # Workspace root
└── tsconfig.base.json
```

### Two directories per SDK — why?

- **`js/<sdk>/`** — The publishable npm package. This is what users install. Contains TypeScript source, tests, and build config.
- **`blueprints/<sdk>/`** — The platform definition. Contains `blueprint.json` (which pre-configures NoLag topics, rooms, and settings for this use case) and a standalone example app.

## Blueprint Definitions

Each `blueprint.json` tells the NoLag platform how to set up infrastructure for a given use case:

```json
{
  "blueprintId": "nolag-chat-sdk",
  "name": "NoLag Chat SDK Demo",
  "version": "1.0.0",
  "category": "communication",
  "tags": ["chat", "presence", "typing-indicators"],
  "difficulty": "intermediate",
  "framework": "vanilla",
  "dependencies": {
    "@nolag/chat": "^0.1.0",
    "@nolag/js-sdk": "^1.0.0"
  },
  "topics": ["messages", "_typing"],
  "topicConfigs": {
    "messages": {
      "logging": {
        "enabled": true,
        "retention": "7d",
        "replayEnabled": true,
        "maxReplayMessages": 100
      }
    }
  },
  "config": {
    "staticRooms": [
      { "slug": "general", "name": "General", "topics": ["messages", "_typing"] }
    ],
    "staticLobbies": [
      { "slug": "online", "name": "Online Presence" }
    ],
    "settings": {
      "rateLimit": "100/min",
      "maxPayloadSize": 4096
    }
  },
  "files": {
    "/index.html": "...",
    "/src/main.js": "..."
  }
}
```

When you create an app from a blueprint on the NoLag platform, it automatically provisions the topics, rooms, lobbies, and settings defined here — so everything just works.

## Sync Tool

The `files` field in `blueprint.json` contains the example app source code as inline strings. To keep these in sync with the actual `example-app/` directory:

```bash
# Copy example-app files into blueprint.json
npm run sync-blueprints push

# Extract blueprint.json files back to example-app
npm run sync-blueprints pull

# Check sync status across all blueprints
npm run sync-blueprints status
```

## Build Outputs

Each SDK produces three bundle formats via Rollup:

| Format | File | Use Case |
|--------|------|----------|
| ESM | `dist/index.mjs` | Modern bundlers (Vite, Webpack 5+, etc.) |
| CJS | `dist/index.cjs` | Node.js / CommonJS `require()` |
| UMD | `dist/browser.js` | `<script>` tags and CDN usage |

TypeScript declarations (`dist/index.d.ts`) are included in all packages.

## Contributing

1. Fork the repo and create a feature branch
2. Make your changes in `js/<sdk>/src/`
3. Add or update tests in `js/<sdk>/tests/unit/`
4. Run `npm test` to verify everything passes
5. Run `npm run build` to confirm the build succeeds
6. Open a pull request

## Tech Stack

- **TypeScript** — ES2020 target, strict mode
- **Rollup** — builds CJS, ESM, and UMD bundles
- **Vitest** — unit testing
- **Vite** — dev server for example apps
- **DaisyUI v5 + Tailwind CSS v4** — example app styling (via CDN)
- **@nolag/js-sdk** — core NoLag client (peer dependency)

## License

MIT
