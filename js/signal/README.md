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

```typescript
import { NoLagSignal } from "@nolag/signal";

const signal = new NoLagSignal("YOUR_ACTOR_TOKEN");

await signal.connect();

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
```

## API Reference

### `NoLagSignal`

#### Constructor

```typescript
const signal = new NoLagSignal(token: string, options?: NoLagSignalOptions);
```

**Options:**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `metadata` | `Record<string, unknown>` | — | Custom peer metadata |
| `debug` | `boolean` | `false` | Enable debug logging |
| `reconnect` | `boolean` | `true` | Auto-reconnect on disconnect |

#### Methods

| Method | Returns | Description |
|--------|---------|-------------|
| `connect()` | `Promise<void>` | Connect to NoLag |
| `disconnect()` | `void` | Disconnect |
| `joinRoom(name)` | `SignalRoom` | Join a signaling room |
| `leaveRoom(name)` | `void` | Leave a room |
| `getRooms()` | `SignalRoom[]` | Get all joined rooms |
| `getOnlinePeers()` | `Peer[]` | Get all online peers |

#### Events

| Event | Payload | Description |
|-------|---------|-------------|
| `connected` | — | Connected to NoLag |
| `disconnected` | — | Disconnected |
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
