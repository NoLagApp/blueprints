# @nolag/track

GPS tracking SDK for [NoLag](https://nolag.app) — real-time locations, geofencing, and asset tracking.

## How It Works with NoLag

NoLag is a real-time messaging platform that handles WebSocket connections, message routing, persistence, and scaling. This SDK wraps the low-level [@nolag/js-sdk](https://www.npmjs.com/package/@nolag/js-sdk) and gives you a purpose-built tracking API — publish locations, track assets in zones, and trigger geofence events — without managing topics or subscriptions yourself.

### Getting Your Token

1. Sign up at [nolag.app](https://nolag.app)
2. Create a new **project** in the portal
3. Choose the **Track** blueprint when creating an app — this pre-configures the topics (`locations`, `_geofence`) and settings your tracking app needs
4. Go to the app's **Tokens** page and generate an **actor token**
5. Use that token when connecting with this SDK

Each token identifies a unique asset or viewer (actor) in NoLag. The blueprint handles all the infrastructure setup — you just build your map UI.

## Install

```bash
npm install @nolag/js-sdk @nolag/track
```

## Quick Start

```typescript
import { NoLagTrack } from "@nolag/track";

const track = new NoLagTrack("YOUR_ACTOR_TOKEN", {
  assetName: "Truck #42",
});

await track.connect();

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

// Geofencing
zone.updateGeofences([
  {
    type: "circle",
    id: "warehouse",
    center: { lat: 40.712, lng: -74.005 },
    radius: 200, // meters
  },
]);

zone.on("geofenceTriggered", (event) => {
  console.log(`Asset ${event.assetId} ${event.type} ${event.geofenceId}`);
  // "Asset truck-42 enter warehouse"
});
```

## API Reference

### `NoLagTrack`

#### Constructor

```typescript
const track = new NoLagTrack(token: string, options?: NoLagTrackOptions);
```

**Options:**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `assetId` | `string` | auto-generated | Unique asset identifier |
| `assetName` | `string` | — | Display name for this asset |
| `metadata` | `Record<string, unknown>` | — | Custom asset data |
| `zones` | `Geofence[]` | — | Initial geofence definitions |
| `maxLocationHistory` | `number` | `500` | Max location points kept in memory |
| `debug` | `boolean` | `false` | Enable debug logging |
| `reconnect` | `boolean` | `true` | Auto-reconnect on disconnect |

#### Methods

| Method | Returns | Description |
|--------|---------|-------------|
| `connect()` | `Promise<void>` | Connect to NoLag |
| `disconnect()` | `void` | Disconnect |
| `joinZone(name)` | `TrackingZone` | Join a tracking zone |
| `leaveZone(name)` | `void` | Leave a zone |
| `getZones()` | `TrackingZone[]` | Get all joined zones |
| `getOnlineAssets()` | `TrackedAsset[]` | Get all online assets |

#### Events

| Event | Payload | Description |
|-------|---------|-------------|
| `connected` | — | Connected |
| `disconnected` | — | Disconnected |
| `reconnected` | — | Reconnected |
| `error` | `Error` | Error |
| `assetOnline` | `TrackedAsset` | Asset came online |
| `assetOffline` | `TrackedAsset` | Asset went offline |

### `TrackingZone`

#### Methods

| Method | Returns | Description |
|--------|---------|-------------|
| `sendLocation(point, metadata?)` | `LocationUpdate` | Publish a location update |
| `getLocations(assetId?)` | `LocationUpdate[]` | Get cached locations |
| `getAssets()` | `TrackedAsset[]` | Get assets in this zone |
| `getAsset(assetId)` | `TrackedAsset \| undefined` | Get a specific asset |
| `checkGeofence(point, geofence)` | `boolean` | Check if point is inside geofence |
| `updateGeofences(geofences)` | `void` | Set geofence definitions |

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
