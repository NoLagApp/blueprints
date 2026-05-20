from __future__ import annotations

import time
from typing import Any

from .types import Peer, SignalPresenceData


class PeerManager:
    """Bidirectional map of actorTokenId <-> Peer, filtering self."""

    def __init__(self, local_actor_id: str) -> None:
        self._local_actor_id = local_actor_id
        self._peers: dict[str, Peer] = {}  # peerId -> Peer
        self._actor_to_peer_id: dict[str, str] = {}  # actorTokenId -> peerId

    def add_from_presence(
        self,
        actor_token_id: str,
        presence: dict[str, Any],
        joined_at: float | None = None,
    ) -> Peer | None:
        if actor_token_id == self._local_actor_id:
            return None

        peer_id = presence.get("peerId", actor_token_id)
        metadata = presence.get("metadata")

        peer = Peer(
            peer_id=peer_id,
            actor_token_id=actor_token_id,
            connection_state="new",
            metadata=metadata,
            joined_at=joined_at or time.time(),
            is_local=False,
        )

        self._peers[peer_id] = peer
        self._actor_to_peer_id[actor_token_id] = peer_id
        return peer

    def remove_by_actor_id(self, actor_token_id: str) -> Peer | None:
        if actor_token_id == self._local_actor_id:
            return None

        peer_id = self._actor_to_peer_id.pop(actor_token_id, None)
        if peer_id is None:
            return None
        return self._peers.pop(peer_id, None)

    def get_peer(self, peer_id: str) -> Peer | None:
        return self._peers.get(peer_id)

    def get_peer_by_actor_id(self, actor_token_id: str) -> Peer | None:
        peer_id = self._actor_to_peer_id.get(actor_token_id)
        if peer_id is None:
            return None
        return self._peers.get(peer_id)

    def get_all(self) -> list[Peer]:
        return list(self._peers.values())

    def clear(self) -> None:
        self._peers.clear()
        self._actor_to_peer_id.clear()
