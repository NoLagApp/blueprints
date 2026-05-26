from __future__ import annotations

from typing import Any, Callable, Optional

from ..agent_room import AgentRoom
from ..types import StateEnvelope
from ..envelope import create_state_envelope


class Blackboard:
    """Shared state across agents with versioning.

    Agents read and write key-value pairs visible to all room participants.
    Uses retained messages so state is available on join.
    """

    def __init__(self, room: AgentRoom, agent_id: str) -> None:
        self._room = room
        self._agent_id = agent_id
        self._state: dict[str, StateEnvelope] = {}

        self._room.on("state_change", self._on_state_change)

    def _on_state_change(self, data: Any) -> None:
        d = data if isinstance(data, dict) else {}
        envelope = _dict_to_state(d)
        self._state[envelope.key] = envelope

    async def set(self, key: str, value: Any) -> None:
        existing = self._state.get(key)
        version = (existing.version + 1) if existing else 1
        envelope = create_state_envelope(key, value, version, self._agent_id)
        self._state[key] = envelope
        await self._room.publish_state(envelope.to_dict())

    def get(self, key: str) -> Any:
        entry = self._state.get(key)
        return entry.value if entry else None

    def get_envelope(self, key: str) -> Optional[StateEnvelope]:
        return self._state.get(key)

    def get_all(self) -> dict[str, StateEnvelope]:
        return dict(self._state)

    def on_change(self, key: str, handler: Callable[[StateEnvelope], None]) -> None:
        def _handler(data: Any) -> None:
            d = data if isinstance(data, dict) else {}
            envelope = _dict_to_state(d)
            if envelope.key == key:
                handler(envelope)

        self._room.on("state_change", _handler)


def _dict_to_state(d: dict[str, Any]) -> StateEnvelope:
    return StateEnvelope(
        type="state",
        key=d.get("key", ""),
        value=d.get("value"),
        version=d.get("version", 0),
        updated_at=d.get("updatedAt", d.get("updated_at", 0)),
        updated_by=d.get("updatedBy", d.get("updated_by", "")),
    )
