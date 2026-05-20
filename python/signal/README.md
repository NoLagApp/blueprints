# NoLag Signal SDK (Python)

WebRTC signaling SDK for Python, built on the [NoLag](https://nolag.app) real-time platform.

Provides peer discovery, SDP offer/answer exchange, and ICE candidate relay for building multi-peer WebRTC applications.

## Install

```bash
pip install nolag-signal
```

## Quick Start

```python
import asyncio
from nolag_signal import NoLagSignal, NoLagSignalOptions

async def main():
    signal = NoLagSignal("YOUR_ACTOR_TOKEN", NoLagSignalOptions(
        app_name="signal",
        metadata={"name": "Alice"},
    ))

    await signal.connect()
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
