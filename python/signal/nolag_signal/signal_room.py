from __future__ import annotations

import time
import uuid
from typing import Any, Callable

from .constants import TOPIC_SIGNALING
from .event_emitter import EventEmitter
from .peer_manager import PeerManager
from .types import NoLagSignalOptions, Peer, SignalMessage

try:
    from nolag import EmitOptions, SubscribeOptions
    from nolag.client import Room
except ImportError:
    Room = Any  # type: ignore[assignment,misc]
    EmitOptions = Any  # type: ignore[assignment,misc]
    SubscribeOptions = Any  # type: ignore[assignment,misc]

FilterValue = str | list[str]
"""A single subscription filter value.

A plain string is an OR term: ``["alice", "bob"]`` matches either. A nested
list is an AND group: ``[["alice", "admin"]]`` matches only what was published
tagged with both.
"""


def _merge_filters(existing: list[FilterValue], add: list[str]) -> list[FilterValue]:
    """Merge OR terms into a filter set, preserving AND groups (nested lists)."""
    simple: list[str] = []
    groups: list[list[str]] = []
    for item in existing:
        if isinstance(item, str):
            if item not in simple:
                simple.append(item)
        else:
            groups.append(item)
    for value in add:
        if value not in simple:
            simple.append(value)
    return [*simple, *groups]


def _without_filters(existing: list[FilterValue], remove: list[str]) -> list[FilterValue]:
    """Drop OR terms from a filter set. AND groups are left untouched."""
    drop = set(remove)
    return [item for item in existing if not (isinstance(item, str) and item in drop)]


class SignalRoom(EventEmitter):
    """
    Per-room signaling context.

    Events:
        signal(message: SignalMessage) — Incoming signal for the local peer
        peer_joined(peer: Peer) — Remote peer joined this room
        peer_left(peer: Peer) — Remote peer left this room
    """

    def __init__(
        self,
        name: str,
        room_context: Room,
        local_peer: Peer,
        options: NoLagSignalOptions,
        log: Callable[..., None],
    ) -> None:
        super().__init__()
        self.name = name
        self._room = room_context
        self._local_peer = local_peer
        self._options = options
        self._log = log
        self._peer_manager = PeerManager(local_peer.actor_token_id)
        self._message_handler: Callable[..., None] | None = None
        self._filters: list[FilterValue] = []

    # -- Public: signaling methods --

    async def send_offer(
        self, to_peer_id: str, offer: dict[str, Any], filter: str | None = None
    ) -> None:
        await self.signal(to_peer_id, "offer", offer, filter=filter)

    async def send_answer(
        self, to_peer_id: str, answer: dict[str, Any], filter: str | None = None
    ) -> None:
        await self.signal(to_peer_id, "answer", answer, filter=filter)

    async def send_ice_candidate(
        self, to_peer_id: str, candidate: dict[str, Any], filter: str | None = None
    ) -> None:
        await self.signal(to_peer_id, "ice-candidate", candidate, filter=filter)

    async def send_bye(self, to_peer_id: str, filter: str | None = None) -> None:
        await self.signal(to_peer_id, "bye", {}, filter=filter)

    async def signal(
        self,
        to_peer_id: str,
        signal_type: str,
        payload: dict[str, Any],
        filter: str | None = None,
    ) -> None:
        """Send a signal to a peer.

        By default this broadcasts to the room and peers discard messages not
        addressed to them. Pass ``filter=to_peer_id`` to have the server do the
        addressing instead, so only that peer is sent the signal.
        """
        message = {
            "id": str(uuid.uuid4()),
            "type": signal_type,
            "fromPeerId": self._local_peer.peer_id,
            "toPeerId": to_peer_id,
            "payload": payload,
            "timestamp": time.time() * 1000,
        }
        self._log(f"[{self.name}] Sending {signal_type} to {to_peer_id[:8]}")
        opts = EmitOptions(echo=False, filter=filter) if filter else EmitOptions(echo=False)
        await self._room.emit(TOPIC_SIGNALING, message, opts)

    # -- Public: filters --

    @property
    def local_peer_id(self) -> str:
        """This peer's own id — the value to filter on for directed signals."""
        return self._local_peer.peer_id

    @property
    def filters(self) -> list[FilterValue]:
        """The filter values currently applied to this room's signaling."""
        return list(self._filters)

    async def set_filters(self, values: list[FilterValue]) -> None:
        """Replace this room's signaling filters.

        Only signals published with one of ``values`` are delivered. Set your
        own peer id to receive just the signals addressed to you, and send with
        ``filter=to_peer_id`` so the server does the addressing rather than
        every peer discarding other peers' traffic.

        A filtered peer stops receiving unfiltered room broadcasts, so switch
        the whole room over together. An empty list restores the wildcard
        subscription, which receives everything.
        """
        self._filters = list(values)
        await self._room.set_filters(TOPIC_SIGNALING, list(values))

    async def add_filters(self, values: list[str]) -> None:
        """Add filter values to the existing set. Existing AND groups are kept."""
        await self.set_filters(_merge_filters(self._filters, values))

    async def remove_filters(self, values: list[str]) -> None:
        """Remove filter values. Removing the last one restores the wildcard."""
        await self.set_filters(_without_filters(self._filters, values))

    # -- Public: peer queries --

    def get_peers(self) -> list[Peer]:
        return self._peer_manager.get_all()

    def get_peer(self, peer_id: str) -> Peer | None:
        return self._peer_manager.get_peer(peer_id)

    # -- Internal: called by NoLagSignal --

    async def _subscribe(self, filters: list[FilterValue] | None = None) -> None:
        self._filters = list(filters) if filters else []
        self._message_handler = self._handle_incoming_signal
        self._room.on(TOPIC_SIGNALING, self._message_handler)
        if self._filters:
            await self._room.subscribe(
                TOPIC_SIGNALING, SubscribeOptions(filters=list(self._filters))
            )
        else:
            await self._room.subscribe(TOPIC_SIGNALING)

    async def _activate(self, client: Any) -> None:
        """Set presence and fetch initial room members."""
        await self._set_presence(client)
        presences = client.get_all_presence()
        for ap in presences:
            actor_id = ap.actor_token_id
            presence_data = ap.presence or {}
            peer = self._peer_manager.add_from_presence(actor_id, presence_data, ap.joined_at)
            if peer is not None:
                self._log(f"[{self.name}] Initial peer: {peer.peer_id[:8]}")
                self.emit("peer_joined", peer)

    async def _update_local_presence(self, client: Any) -> None:
        await self._set_presence(client)

    def _handle_presence_join(self, actor_token_id: str, presence_data: dict[str, Any]) -> None:
        peer = self._peer_manager.add_from_presence(actor_token_id, presence_data)
        if peer is not None:
            self._log(f"[{self.name}] Peer joined: {peer.peer_id[:8]}")
            self.emit("peer_joined", peer)

    def _handle_presence_leave(self, actor_token_id: str) -> None:
        peer = self._peer_manager.remove_by_actor_id(actor_token_id)
        if peer is not None:
            self._log(f"[{self.name}] Peer left: {peer.peer_id[:8]}")
            self.emit("peer_left", peer)

    def _handle_presence_update(self, actor_token_id: str, presence_data: dict[str, Any]) -> None:
        self._peer_manager.add_from_presence(actor_token_id, presence_data)

    async def _cleanup(self) -> None:
        if self._message_handler:
            self._room.off(TOPIC_SIGNALING, self._message_handler)
            self._message_handler = None
        await self._room.unsubscribe(TOPIC_SIGNALING)
        self._peer_manager.clear()
        self.remove_all_listeners()

    # -- Private --

    def _handle_incoming_signal(self, data: Any, meta: Any = None) -> None:
        if not isinstance(data, dict):
            return
        to_peer_id = data.get("toPeerId")
        if to_peer_id != self._local_peer.peer_id:
            return

        message = SignalMessage(
            id=data.get("id", ""),
            type=data.get("type", ""),
            from_peer_id=data.get("fromPeerId", ""),
            to_peer_id=to_peer_id,
            payload=data.get("payload", {}),
            timestamp=data.get("timestamp", 0),
        )
        self._log(f"[{self.name}] Received {message.type} from {message.from_peer_id[:8]}")
        self.emit("signal", message)

    async def _set_presence(self, client: Any) -> None:
        presence_data: dict[str, Any] = {"peerId": self._local_peer.peer_id}
        if self._options.metadata:
            presence_data["metadata"] = self._options.metadata
        await client.set_presence(presence_data)
