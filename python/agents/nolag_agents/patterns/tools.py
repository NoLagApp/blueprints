from __future__ import annotations

import asyncio
import inspect
from typing import Any, Callable, Optional

from ..agent_room import AgentRoom
from ..types import ToolRequestEnvelope, ToolResponseEnvelope
from ..correlation import CorrelationManager
from ..envelope import create_tool_request, create_tool_response


class Tools:
    """Remote tool RPC over pub/sub.

    Agents register tool handlers; callers invoke tools and receive
    correlated responses. Handlers can be sync or async.
    """

    def __init__(self, room: AgentRoom, agent_id: str) -> None:
        self._room = room
        self._agent_id = agent_id
        self._correlations: CorrelationManager[ToolResponseEnvelope] = CorrelationManager()
        self._handlers: dict[str, Callable[..., Any]] = {}

        self._room.on("tool_response", self._on_response)
        self._room.on("tool_request", self._on_request)

    def _on_response(self, data: Any) -> None:
        d = data if isinstance(data, dict) else {}
        correlation_id = d.get("correlationId", d.get("correlation_id", ""))
        if correlation_id:
            envelope = _dict_to_tool_response(d)
            self._correlations.resolve(correlation_id, envelope)

    def _on_request(self, data: Any) -> None:
        d = data if isinstance(data, dict) else {}
        tool_name = d.get("toolName", d.get("tool_name", ""))
        handler = self._handlers.get(tool_name)
        if not handler:
            return

        envelope = _dict_to_tool_request(d)
        asyncio.ensure_future(self._handle_request(envelope, handler))

    async def _handle_request(self, envelope: ToolRequestEnvelope, handler: Callable[..., Any]) -> None:
        # Direct the response back to the requester's filter sub-topic
        reply_to = envelope.reply_to or envelope.requested_by
        try:
            result = handler(envelope.arguments)
            if inspect.isawaitable(result):
                result = await result
            response = create_tool_response(
                envelope.request_id,
                envelope.correlation_id,
                "success",
                result,
                responded_by=self._agent_id,
                reply_to=reply_to,
            )
            await self._room.publish_tools(response.to_dict())
        except Exception as err:
            response = create_tool_response(
                envelope.request_id,
                envelope.correlation_id,
                "error",
                None,
                error={"code": "TOOL_ERROR", "message": str(err)},
                responded_by=self._agent_id,
                reply_to=reply_to,
            )
            await self._room.publish_tools(response.to_dict())

    def register(self, tool_name: str, handler: Callable[..., Any]) -> None:
        self._handlers[tool_name] = handler

    async def invoke(
        self,
        tool_name: str,
        args: dict[str, Any],
        *,
        timeout: Optional[int] = None,
    ) -> ToolResponseEnvelope:
        # reply_to is the room's agent_id — the filter sub-topic this room's
        # results subscription listens on. (self._agent_id may differ when a
        # caller attributes requests to a logical agent; delivery must use
        # the address that is actually subscribed.)
        envelope = create_tool_request(
            tool_name, args, self._agent_id, reply_to=self._room.agent_id,
        )
        await self._room.publish_tools(envelope.to_dict())
        return await self._correlations.register(envelope.correlation_id, timeout)

    def dispose(self) -> None:
        self._correlations.clear()
        self._handlers.clear()


def _dict_to_tool_request(d: dict[str, Any]) -> ToolRequestEnvelope:
    return ToolRequestEnvelope(
        type="tool_request",
        request_id=d.get("requestId", d.get("request_id", "")),
        correlation_id=d.get("correlationId", d.get("correlation_id", "")),
        reply_to=d.get("replyTo", d.get("reply_to")),
        tool_name=d.get("toolName", d.get("tool_name", "")),
        arguments=d.get("arguments", {}),
        requested_by=d.get("requestedBy", d.get("requested_by", "")),
        requested_at=d.get("requestedAt", d.get("requested_at", 0)),
    )


def _dict_to_tool_response(d: dict[str, Any]) -> ToolResponseEnvelope:
    return ToolResponseEnvelope(
        type="tool_response",
        request_id=d.get("requestId", d.get("request_id", "")),
        correlation_id=d.get("correlationId", d.get("correlation_id", "")),
        status=d.get("status", "success"),
        result=d.get("result"),
        error=d.get("error"),
        responded_by=d.get("respondedBy", d.get("responded_by")),
        responded_at=d.get("respondedAt", d.get("responded_at", 0)),
        reply_to=d.get("replyTo", d.get("reply_to")),
    )
