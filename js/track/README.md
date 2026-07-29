# @nolag/track

GPS tracking SDK for [NoLag](https://nolag.app) — real-time locations, geofencing, and asset tracking.

## How It Works with NoLag

NoLag is a real-time messaging platform that handles WebSocket connections, message routing, persistence, and scaling. This SDK wraps the low-level [@nolag/js-sdk](https://www.npmjs.com/package/@nolag/js-sdk) and gives you a purpose-built tracking API — publish locations, track assets in zones, and trigger geofence events — without managing topics or subscriptions yourself.

### Getting Your Token

1. Sign up at [nolag.app](https://nolag.app)
2. Create a new **project** in the portal
3. Choose the **Track** blueprint when creating an app — this pre-configures the topics (`locations`, `_geofence`) and settings your tracking app needs
4. Go to the app's **Tokens** page and generate an **actor token**
5. Use that token (or a token provider) to create the core `NoLag` client, then inject it into `NoLagTrack`

Each token identifies a unique asset or viewer (actor) in NoLag. The blueprint handles all the infrastructure setup — you just build your map UI.

## Install

```bash
npm install @nolag/js-sdk @nolag/track
```

## Quick Start

The app owns one core NoLag client; wrappers attach to it. Any number of
wrapper SDKs (track, chat, dash, ...) can share the same connection as
long as each uses its own app.

```typescript
import { NoLag } from "@nolag/js-sdk";
import { NoLagTrack } from "@nolag/track";

// One client for the whole app. In a browser, use a token provider so the
// SDK can mint fresh short-lived client tokens from your backend.
const client = NoLag(async () => (await (await fetch("/api/nolag-token")).json()).token);
const track = new NoLagTrack({ client, assetName: "Truck #42" });

await client.connect();   // the app owns the connection
await track.ready();      // wrapper setup done (identity, presence, zones)

const zone = track.joinZone("downtown");

// Publish location updates
zone.sendLocation(
  { lat: 40.7128, lng: -74.006, speed: 35, heading: 90 },
  { driver: "Bob" }
);

// Track other assets in real-time
zone.on("locationUpdate", (update) => {
  moveMarker(update.assetId, update.point.lat, update.point.lng);
});

// See which assets are online across all zones
track.on("assetOnline", (asset) => {
  console.log(`${asset.assetId} came online`);
});

// Geofencing — subscribes to the location filters covering the fence area
zone.addGeofence({
  id: "warehouse",
  shape: "circle",
  center: { lat: 40.712, lng: -74.005 },
  radiusMeters: 200,
});

zone.on("geofenceTriggered", (event) => {
  console.log(`Asset ${event.assetId} ${event.type} ${event.geofenceId}`);
  // "Asset truck-42 enter warehouse"
});

// Teardown: the wrapper releases its handlers and topics; the app closes
// the socket (never the other way around).
track.detach();
client.disconnect();
```

## Lifecycle

- **Construction = attach.** The wrapper wires its handlers onto the injected
  client immediately. If the client is already connected, setup runs on the
  next microtask; otherwise it runs when the client's `connect` event fires.
- **`ready()`** resolves once the first setup completed (identity, online
  lobby, configured zones). Auth failures surface via your own
  `await client.connect()`, not via `ready()`.
- **Reconnects are automatic.** The wrapper re-applies each zone's presence
  (persistent presence — the core does not restore it) and reconciles the
  online-asset list, emitting only real deltas.
- **`detach()`** removes exactly this wrapper's handlers and topics and never
  touches the socket. It is terminal: construct a new instance to re-attach.
  Detach while the client is still connected so server-side unsubscribes go
  through. In frameworks, call it from your dispose hook (`onUnmounted`,
  HMR dispose).
- **One wrapper per (client, app).** Sharing a client across wrappers of
  DIFFERENT apps is the intended pattern; two wrappers on the same app would
  collide on topics and presence (the SDK warns if you do this).

## API Reference

### `NoLagTrack`

#### Constructor

```typescript
const track = new NoLagTrack(options: NoLagTrackOptions);
```

**Options:**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `client` | `NoLagSocket` | *required* | The injected core NoLag client |
| `assetId` | `string` | auto-generated | Unique asset identifier |
| `assetName` | `string` | — | Display name for this asset |
| `metadata` | `Record<string, unknown>` | — | Custom asset data |
| `appName` | `string` | `'track'` | NoLag app for topic prefixes |
| `zoneNames` | `string[]` | — | Tracking zones (rooms) to auto-join on connect |
| `zones` | `Geofence[]` | — | Client-side geofences to register on every joined zone |
| `maxLocationHistory` | `number` | `500` | Max location points kept in memory |
| `debug` | `boolean` | `false` | Enable debug logging |

#### Methods

| Method | Returns | Description |
|--------|---------|-------------|
| `ready()` | `Promise<void>` | Resolves when wrapper setup completed |
| `detach()` | `void` | Release handlers and topics (terminal; never closes the socket) |
| `joinZone(name)` | `TrackingZone` | Join a tracking zone |
| `leaveZone(name)` | `void` | Leave a zone |
| `getZones()` | `TrackingZone[]` | Get all joined zones |
| `getOnlineAssets()` | `TrackedAsset[]` | Get all online assets |

#### Properties

| Property | Type | Description |
|----------|------|-------------|
| `connected` | `boolean` | Whether currently connected |
| `localAsset` | `TrackedAsset \| null` | The local asset |
| `zones` | `Map<string, TrackingZone>` | All joined zones |

#### Events

| Event | Payload | Description |
|-------|---------|-------------|
| `connected` | — | Connected to NoLag |
| `disconnected` | `reason` | Disconnected |
| `reconnecting` | — | Reconnect attempt started |
| `reconnected` | — | Reconnected after disconnect |
| `error` | `Error` | Connection or protocol error |
| `assetOnline` | `TrackedAsset` | Asset came online |
| `assetOffline` | `TrackedAsset` | Asset went offline |

### `TrackingZone`

#### Methods

| Method | Returns | Description |
|--------|---------|-------------|
| `sendLocation(point, metadata?)` | `LocationUpdate` | Publish a location update |
| `getLocationHistory(assetId?)` | `LocationUpdate[]` | Get cached locations |
| `getAssets()` | `TrackedAsset[]` | Get assets in this zone |
| `getAsset(assetId)` | `TrackedAsset \| undefined` | Get a specific asset |
| `addGeofence(geofence)` | `void` | Register a client-side geofence (subscribes its cell filters) |
| `removeGeofence(id)` | `void` | Remove a geofence by ID |
| `getGeofences()` | `Geofence[]` | Get all registered geofences |

#### Events

| Event | Payload | Description |
|-------|---------|-------------|
| `locationUpdate` | `LocationUpdate` | Asset location changed |
| `assetJoined` | `TrackedAsset` | Asset joined the zone |
| `assetLeft` | `TrackedAsset` | Asset left the zone |
| `geofenceTriggered` | `GeofenceEvent` | Asset entered/exited a geofence |
| `replayStart` / `replayEnd` | — | Location replay |

## Types

```typescript
interface GeoPoint {
  lat: number;
  lng: number;
  altitude?: number;
  accuracy?: number;
  heading?: number;
  speed?: number;
}

interface LocationUpdate {
  id: string;
  assetId: string;
  point: GeoPoint;
  metadata?: Record<string, unknown>;
  timestamp: number;
  isReplay: boolean;
}

interface TrackedAsset {
  assetId: string;
  actorTokenId: string;
  assetName?: string;
  lastLocation?: GeoPoint;
  metadata?: Record<string, unknown>;
  joinedAt: number;
  isLocal: boolean;
}

interface GeofenceEvent {
  geofenceId: string;
  assetId: string;
  type: "enter" | "exit";
  point: GeoPoint;
  timestamp: number;
}

// Geofence can be circle or polygon
type Geofence = CircleGeofence | PolygonGeofence;
```

## License

MIT
