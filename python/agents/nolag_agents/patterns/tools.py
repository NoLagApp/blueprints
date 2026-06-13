from __future__ import annotations

import asyncio
import inspect
from typing import Any, Callable, Optional

from ..agent_room import AgentRoom
from ..types import ToolRequestEnvelope, ToolResponseEnvelope
from ..correlation import CorrelationManager
from ..envelope import create_tool_request, create_tool_response
from ..errors import IncompatibleProtocolError


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
        self._warned_mixed = False

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
        envelope = _dict_to_tool_request(d)
        if not handler:
            # Tool requests are load-balanced to EVERY group in the room, so
            # agents legitimately receive requests meant for other tool
            # servers. Stay silent unless this agent plausibly owns the tool:
            # pure requesters never answer; servers answer only within their
            # own namespace (prefix before the first '.') — a 'backend.*'
            # server NACKing 'chemistry.analyze' would race and beat the real
            # chemistry server's response.
            if not self._owns_namespace(tool_name):
                return
            asyncio.ensure_future(self._send_no_handler_nack(envelope))
            return

        asyncio.ensure_future(self._handle_request(envelope, handler))

    async def _send_no_handler_nack(self, envelope: ToolRequestEnvelope) -> None:
        reply_to = envelope.reply_to or envelope.requested_by
        nack = create_tool_response(
            envelope.request_id,
            envelope.correlation_id,
            "error",
            None,
            error={
                "code": "NO_HANDLER",
                "message": f"Agent '{self._agent_id}' has no handler for tool '{envelope.tool_name}'",
            },
            responded_by=self._agent_id,
            reply_to=reply_to,
        )
        await self._room.publish_tools(nack.to_dict())

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

    def _owns_namespace(self, tool_name: str) -> bool:
        """True when this agent hosts handlers in the tool's namespace
        (prefix before the first '.'); unprefixed tools match any
        unprefixed handler."""
        if not self._handlers:
            return False
        ns = tool_name.split(".", 1)[0] if "." in tool_name else None
        for name in self._handlers:
            handler_ns = name.split(".", 1)[0] if "." in name else None
            if handler_ns == ns:
                return True
        return False

    async def invoke(
        self,
        tool_name: str,
        args: dict[str, Any],
        *,
        timeout: Optional[int] = None,
        allow_legacy_responders: bool = False,
    ) -> ToolResponseEnvelope:
        # Fail fast when the outcome is deterministic: tool servers are
        # visible in presence; if some exist and ALL advertise protocol < 2,
        # their replies cannot reach this requester. Mixed pools proceed
        # with a warning (presence is eventually consistent).
        servers = [a for a in self._room.get_connected_agents() if a.role == "tool-server"]
        if not allow_legacy_responders and servers:
            modern = [a for a in servers if a.protocol >= 2]
            if not modern:
                raise IncompatibleProtocolError(
                    f"Tool '{tool_name}' invocation",
                    [(a.name, a.protocol) for a in servers],
                )
            if len(modern) < len(servers) and not self._warned_mixed:
                self._warned_mixed = True
                import logging
                logging.getLogger("nolag_agents").warning(
                    "Room '%s' has tool servers on agents-protocol < 2: %s — "
                    "their replies may not be delivered; upgrade them.",
                    self._room.name,
                    ", ".join(a.name for a in servers if a.protocol < 2),
                )

        # reply_to is the room's agent_id — the filter sub-topic this room's
        # results subscription listens on. (self._agent_id may differ when a
        # caller attributes requests to a logical agent; delivery must use
        # the address that is actually subscribed.)
        envelope = create_tool_request(
            tool_name, args, self._agent_id, reply_to=self._room.agent_id,
        )
        await self._room.publish_tools(envelope.to_dict())
        n = len(servers)
        return await self._correlations.register(
            envelope.correlation_id,
            timeout,
            f"Tool '{tool_name}' invocation in room '{self._room.name}' "
            f"({n} tool-server{'' if n == 1 else 's'} visible). Likely causes: "
            f"no agent has this tool registered (pre-0.4.0 responders don't "
            f"NACK), the responder is offline, or the room is not deliverable "
            f"(watch the client 'error' events)",
        )

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
