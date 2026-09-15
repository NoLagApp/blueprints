from __future__ import annotations

from typing import Any, Callable, Optional

from ..agent_room import AgentRoom
from ..types import EventEnvelope
from ..envelope import create_event_envelope
from ..utils import FilterValue


class Observe:
    """Observability events pattern.

    Agents emit structured events; observers/dashboards subscribe to the stream.
    Events have severity, category, and emitted_by for filtering.

    ``on(handler, category=...)`` discards non-matching events after they
    arrive, which is fine for a quiet room and wasteful for a loud one.
    ``set_filters`` moves the same selection to the broker, so an observer is
    only sent the categories it asked for. Emit with a matching ``filter`` for
    that to work — see ``emit``.
    """

    def __init__(self, room: AgentRoom, emitted_by: str) -> None:
        self._room = room
        self._emitted_by = emitted_by

    async def emit(
        self,
        category: str,
        payload: dict[str, Any],
        severity: str = "info",
        filter: str | None = None,
        filters: list[str] | None = None,
    ) -> None:
        """Emit an observability event.

        Pass ``filter=category`` to route it server-side, so observers that
        called ``set_filters`` receive only the categories they subscribed to.
        Observers with no filters still receive it either way, so tagging is
        safe to adopt without coordinating with them.
        """
        envelope = create_event_envelope(category, self._emitted_by, payload, severity)
        await self._room.publish_event(envelope.to_dict(), filter=filter, filters=filters)

    async def set_filters(self, values: list[FilterValue]) -> None:
        """Replace the observer's server-side event filters.

        Scoped to the events topic, so it never disturbs the room's other
        subscriptions — notably ``inbox``, whose messages are published
        unfiltered and would stop arriving if this were applied room-wide.

        An empty list restores the wildcard subscription, which receives every
        event on the room.
        """
        await self._room.set_filters(values, topic="events")

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
