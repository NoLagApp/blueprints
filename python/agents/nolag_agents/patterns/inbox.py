from __future__ import annotations

from typing import Any, Callable

from ..agent_room import AgentRoom
from ..types import InboxMessage
from ..utils import generate_id, create_timestamp


class Inbox:
    """Per-agent direct messaging.

    Agents send direct messages to other agents via their inbox.
    Messages are filtered by recipient agent ID.
    """

    def __init__(self, room: AgentRoom, agent_id: str) -> None:
        self._room = room
        self._agent_id = agent_id

    async def send(self, to: str, payload: dict[str, Any]) -> None:
        message = InboxMessage(
            message_id=generate_id(),
            from_agent=self._agent_id,
            to=to,
            payload=payload,
            created_at=create_timestamp(),
        )
        await self._room.publish_inbox(message.to_dict())

    def on_message(self, handler: Callable[[InboxMessage], None]) -> None:
        def _handler(data: Any) -> None:
            d = data if isinstance(data, dict) else {}
            to = d.get("to", "")
            if to == self._agent_id:
                msg = InboxMessage(
                    message_id=d.get("messageId", d.get("message_id", "")),
                    from_agent=d.get("from", d.get("fromAgent", d.get("from_agent", ""))),
                    to=to,
                    payload=d.get("payload", {}),
                    created_at=d.get("createdAt", d.get("created_at", 0)),
                )
                handler(msg)

        self._room.on("inbox", _handler)
