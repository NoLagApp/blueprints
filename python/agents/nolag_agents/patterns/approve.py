from __future__ import annotations

from typing import Any, Callable, Optional

from ..agent_room import AgentRoom
from ..types import ApprovalRequestEnvelope, ApprovalResponseEnvelope
from ..correlation import CorrelationManager
from ..envelope import create_approval_request, create_approval_response


class Approve:
    """Human-in-the-loop approval gates.

    Agents request approval before taking actions; humans or other agents
    approve/reject via the approval topic.
    """

    def __init__(self, room: AgentRoom, agent_id: str) -> None:
        self._room = room
        self._agent_id = agent_id
        self._correlations: CorrelationManager[ApprovalResponseEnvelope] = CorrelationManager()

        self._room.on("approval_response", self._on_response)

    def _on_response(self, data: Any) -> None:
        d = data if isinstance(data, dict) else {}
        correlation_id = d.get("correlationId", d.get("correlation_id", ""))
        if correlation_id:
            envelope = _dict_to_approval_response(d)
            self._correlations.resolve(correlation_id, envelope)

    async def request(
        self,
        action: str,
        context: Any,
        *,
        urgency: str = "medium",
        timeout: Optional[int] = None,
        expires_at: Optional[int] = None,
    ) -> ApprovalResponseEnvelope:
        envelope = create_approval_request(
            action,
            context,
            self._agent_id,
            urgency=urgency,
            expires_at=expires_at,
        )
        await self._room.publish_approval(envelope.to_dict())
        return await self._correlations.register(envelope.correlation_id, timeout)

    def on_request(
        self,
        handler: Callable[[ApprovalRequestEnvelope, Callable[..., Any]], None],
    ) -> None:
        def _handler(data: Any) -> None:
            d = data if isinstance(data, dict) else {}
            req = _dict_to_approval_request(d)

            async def _respond(decision: str, reason: Optional[str] = None) -> None:
                response = create_approval_response(
                    req.request_id,
                    req.correlation_id,
                    decision,
                    self._agent_id,
                    reason,
                )
                await self._room.publish_approval(response.to_dict())

            handler(req, _respond)

        self._room.on("approval_request", _handler)

    def dispose(self) -> None:
        self._correlations.clear()


def _dict_to_approval_request(d: dict[str, Any]) -> ApprovalRequestEnvelope:
    return ApprovalRequestEnvelope(
        type="approval_request",
        request_id=d.get("requestId", d.get("request_id", "")),
        correlation_id=d.get("correlationId", d.get("correlation_id", "")),
        action=d.get("action", ""),
        context=d.get("context"),
        urgency=d.get("urgency", "medium"),
        expires_at=d.get("expiresAt", d.get("expires_at")),
        requested_by=d.get("requestedBy", d.get("requested_by", "")),
        requested_at=d.get("requestedAt", d.get("requested_at", 0)),
    )


def _dict_to_approval_response(d: dict[str, Any]) -> ApprovalResponseEnvelope:
    return ApprovalResponseEnvelope(
        type="approval_response",
        request_id=d.get("requestId", d.get("request_id", "")),
        correlation_id=d.get("correlationId", d.get("correlation_id", "")),
        decision=d.get("decision", "approved"),
        reason=d.get("reason"),
        responded_by=d.get("respondedBy", d.get("responded_by", "")),
        responded_at=d.get("respondedAt", d.get("responded_at", 0)),
    )
