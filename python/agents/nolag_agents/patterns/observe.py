from __future__ import annotations

from typing import Any, Callable, Optional

from ..agent_room import AgentRoom
from ..types import EventEnvelope
from ..envelope import create_event_envelope


class Observe:
    """Observability events pattern.

    Agents emit structured events; observers/dashboards subscribe to the stream.
    Events have severity, category, and emitted_by for filtering.
    """

    def __init__(self, room: AgentRoom, emitted_by: str) -> None:
        self._room = room
        self._emitted_by = emitted_by

    async def emit(
        self,
        category: str,
        payload: dict[str, Any],
        severity: str = "info",
    ) -> None:
        envelope = create_event_envelope(category, self._emitted_by, payload, severity)
        await self._room.publish_event(envelope.to_dict())

    def on(
        self,
        handler: Callable[[EventEnvelope], None],
        *,
        category: Optional[str] = None,
        severity: Optional[str] = None,
    ) -> None:
        def _handler(data: Any) -> None:
            d = data if isinstance(data, dict) else {}
            envelope = _dict_to_event(d)
            if category and envelope.category != category:
                return
            if severity and envelope.severity != severity:
                return
            handler(envelope)

        self._room.on("event", _handler)


def _dict_to_event(d: dict[str, Any]) -> EventEnvelope:
    return EventEnvelope(
        type="event",
        event_id=d.get("eventId", d.get("event_id", "")),
        severity=d.get("severity", "info"),
        category=d.get("category", ""),
        payload=d.get("payload", {}),
        timestamp=d.get("timestamp", 0),
        emitted_by=d.get("emittedBy", d.get("emitted_by", "")),
    )
