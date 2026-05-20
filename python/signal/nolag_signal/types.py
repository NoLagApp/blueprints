from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal

SignalType = Literal["offer", "answer", "ice-candidate", "renegotiate", "bye"]


@dataclass
class SignalMessage:
    id: str
    type: SignalType
    from_peer_id: str
    to_peer_id: str
    payload: dict[str, Any]
    timestamp: float


@dataclass
class Peer:
    peer_id: str
    actor_token_id: str
    connection_state: Literal["new", "connecting", "connected", "disconnected"] = "new"
    metadata: dict[str, Any] | None = None
    joined_at: float = 0.0
    is_local: bool = False


@dataclass
class SignalPresenceData:
    peer_id: str
    metadata: dict[str, Any] | None = None


@dataclass
class NoLagSignalOptions:
    metadata: dict[str, Any] | None = None
    app_name: str = "signal"
    url: str | None = None
    debug: bool = False
    reconnect: bool = True
