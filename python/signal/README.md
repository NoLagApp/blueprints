# NoLag Signal SDK (Python)

## Injected client

This SDK takes an **injected** NoLag client. Your application creates, connects,
and disconnects the client; the wrapper only attaches to it. One connection can
therefore be shared by several wrappers, and releasing one never disturbs the
others.

| Step | Call | Notes |
|---|---|---|
| Attach | `NoLagSignal(client, options)` | Registers handlers immediately, before the client connects |
| Wait | `await x.ready()` | Resolves once wrapper setup completes; re-runs on reconnect |
| Release | `await x.detach()` | Terminal, idempotent, **never disconnects the client** |

`detach()` removes exactly this wrapper's handlers, so a sibling wrapper on the
same client keeps working. Connection settings (url, reconnect, heartbeat) live
on the client you construct, not in this SDK's options.


WebRTC signaling SDK for Python, built on the [NoLag](https://nolag.app) real-time platform.

Provides peer discovery, SDP offer/answer exchange, and ICE candidate relay for building multi-peer WebRTC applications.

## Install

```bash
pip install nolag-signal
```

## Quick Start

```python
import asyncio
from nolag import NoLag
from nolag_signal import NoLagSignal, NoLagSignalOptions

async def main():
    # The application owns the connection.
    client = NoLag("YOUR_ACTOR_TOKEN")
    await client.connect()

    # The wrapper attaches to it.
    signal = NoLagSignal(client, NoLagSignalOptions(
        app_name="signal",
        metadata={"name": "Alice"},
    ))

    await signal.ready()
    room = await signal.join_room("call-room")

    # Listen for incoming signals
    room.on("signal", lambda msg: print(f"Signal from {msg.from_peer_id}: {msg.type}"))
    room.on("peer_joined", lambda peer: print(f"Peer joined: {peer.peer_id}"))
    room.on("peer_left", lambda peer: print(f"Peer left: {peer.peer_id}"))

    # Send a WebRTC offer
    await room.send_offer(remote_peer_id, {"type": "offer", "sdp": "..."})

asyncio.run(main())
```

## Events

### NoLagSignal
| Event | Args | Description |
|-------|------|-------------|
| `connected` | — | Connection established |
| `disconnected` | `reason: str` | Connection lost |
| `reconnected` | — | Reconnected |
| `error` | `error: Exception` | Connection error |
| `peer_online` | `peer: Peer` | Global peer discovery |
| `peer_offline` | `peer: Peer` | Peer went offline |

### SignalRoom
| Event | Args | Description |
|-------|------|-------------|
| `signal` | `message: SignalMessage` | Incoming signal |
| `peer_joined` | `peer: Peer` | Peer joined room |
| `peer_left` | `peer: Peer` | Peer left room |
