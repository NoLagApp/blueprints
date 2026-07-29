# @nolag/signal

WebRTC signaling SDK for [NoLag](https://nolag.app) — peer discovery, offer/answer exchange, and ICE candidate relay.

## How It Works with NoLag

NoLag is a real-time messaging platform that handles WebSocket connections, message routing, persistence, and scaling. This SDK wraps the low-level [@nolag/js-sdk](https://www.npmjs.com/package/@nolag/js-sdk) and gives you a purpose-built signaling API for WebRTC — peer discovery, SDP exchange, and ICE candidate relay — without managing topics or subscriptions yourself.

**Note:** This SDK handles *signaling only* (the coordination layer). The actual media streams (audio/video) are peer-to-peer via WebRTC. NoLag acts as the signaling server that helps peers find each other and negotiate connections.

### Getting Your Token

1. Sign up at [nolag.app](https://nolag.app)
2. Create a new **project** in the portal
3. Choose the **Signal** blueprint when creating an app — this pre-configures the `signaling` topic your WebRTC app needs
4. Go to the app's **Tokens** page and generate an **actor token**
5. Use that token when connecting with this SDK

Each token identifies a unique peer in NoLag. The blueprint handles all the infrastructure setup — you just build your video/audio UI.

## Install

```bash
npm install @nolag/js-sdk @nolag/signal
```

## Quick Start

The app owns one core NoLag client; wrappers attach to it. Any number of
wrapper SDKs (signal, chat, dash, ...) can share the same connection as
long as each uses its own app.

```typescript
import { NoLag } from "@nolag/js-sdk";
import { NoLagSignal } from "@nolag/signal";

// One client for the whole app. In a browser, use a token provider so the
// SDK can mint fresh short-lived client tokens from your backend.
const client = NoLag(async () => (await (await fetch("/api/nolag-token")).json()).token);
const signal = new NoLagSignal({ client });

await client.connect();   // the app owns the connection
await signal.ready();     // wrapper setup done (identity, presence)

const room = signal.joinRoom("call-room");

// When a new peer joins, start a WebRTC connection
room.on("peerJoined", async (peer) => {
  const pc = new RTCPeerConnection();

  // Send your offer
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  room.sendOffer(peer.peerId, offer);

  // Send ICE candidates as they're discovered
  pc.onicecandidate = (e) => {
    if (e.candidate) {
      room.sendIceCandidate(peer.peerId, e.candidate);
    }
  };
});

// Handle incoming signals
room.on("signal", async (msg) => {
  switch (msg.type) {
    case "offer":
      // Set remote description, create answer, send it back
      break;
    case "answer":
      // Set remote description
      break;
    case "ice-candidate":
      // Add ICE candidate
      break;
    case "bye":
      // Peer hung up
      break;
  }
});

// Teardown: the wrapper releases its handlers and topics; the app closes
// the socket (never the other way around).
signal.detach();
client.disconnect();
```

## Lifecycle

- **Construction = attach.** The wrapper wires its handlers onto the injected
  client immediately. If the client is already connected, setup runs on the
  next microtask; otherwise it runs when the client's `connect` event fires.
- **`ready()`** resolves once the first setup completed (identity and the
  online lobby). Auth failures surface via your own `await client.connect()`,
  not via `ready()`.
- **Reconnects are automatic.** The wrapper restores room presence and
  reconciles the online-peer list, emitting only real deltas.
- **`detach()`** removes exactly this wrapper's handlers and topics and never
  touches the socket. It is terminal: construct a new instance to re-attach.
  Detach while the client is still connected so server-side unsubscribes go
  through. In frameworks, call it from your dispose hook (`onUnmounted`,
  HMR dispose).
- **One wrapper per (client, app).** Sharing a client across wrappers of
  DIFFERENT apps is the intended pattern; two wrappers on the same app would
  collide on topics and presence (the SDK warns if you do this).

## API Reference

### `NoLagSignal`

#### Constructor

```typescript
const signal = new NoLagSignal(options: NoLagSignalOptions);
```

**Options:**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `client` | `NoLagSocket` | *required* | The injected core NoLag client |
| `metadata` | `Record<string, unknown>` | — | Custom peer metadata |
| `appName` | `string` | `'signal'` | NoLag app for topic prefixes |
| `debug` | `boolean` | `false` | Enable wrapper debug logging |

#### Methods

| Method | Returns | Description |
|--------|---------|-------------|
| `ready()` | `Promise<void>` | Resolves when wrapper setup completed |
| `detach()` | `void` | Release handlers and topics (terminal; never closes the socket) |
| `joinRoom(name)` | `SignalRoom` | Join a signaling room |
| `leaveRoom(name)` | `void` | Leave a room |
| `getRooms()` | `SignalRoom[]` | Get all joined rooms |
| `getOnlinePeers()` | `Peer[]` | Get all online peers |

#### Properties

| Property | Type | Description |
|----------|------|-------------|
| `connected` | `boolean` | Whether currently connected |
| `localPeer` | `Peer \| null` | The local peer |
| `rooms` | `Map<string, SignalRoom>` | All joined rooms |

#### Events

| Event | Payload | Description |
|-------|---------|-------------|
| `connected` | — | First setup completed |
| `disconnected` | `reason` | Disconnected |
| `reconnecting` | — | Reconnect attempt started |
| `reconnected` | — | Reconnected after disconnect |
| `error` | `Error` | Connection or protocol error |
| `peerOnline` | `Peer` | A peer came online |
| `peerOffline` | `Peer` | A peer went offline |

### `SignalRoom`

#### Methods

| Method | Returns | Description |
|--------|---------|-------------|
| `sendOffer(toPeerId, offer)` | `void` | Send an SDP offer |
| `sendAnswer(toPeerId, answer)` | `void` | Send an SDP answer |
| `sendIceCandidate(toPeerId, candidate)` | `void` | Send an ICE candidate |
| `sendBye(toPeerId)` | `void` | Signal call end |
| `signal(toPeerId, type, payload)` | `void` | Send a raw signal message |
| `getPeers()` | `Peer[]` | Get peers in this room |
| `getPeer(peerId)` | `Peer \| undefined` | Get a specific peer |

#### Events

| Event | Payload | Description |
|-------|---------|-------------|
| `signal` | `SignalMessage` | Incoming signal (offer/answer/ICE/bye) |
| `peerJoined` | `Peer` | Peer joined the room |
| `peerLeft` | `Peer` | Peer left the room |

## Types

```typescript
interface Peer {
  peerId: string;
  actorTokenId: string;
  connectionState: string;
  metadata?: Record<string, unknown>;
  joinedAt: number;
  isLocal: boolean;
}

interface SignalMessage {
  id: string;
  type: SignalType;
  fromPeerId: string;
  toPeerId: string;
  payload: unknown;
  timestamp: number;
}

type SignalType = "offer" | "answer" | "ice-candidate" | "renegotiate" | "bye";
```

## License

MIT
