from __future__ import annotations

from typing import Any, Optional

from .utils import generate_id, create_timestamp
from .types import (
    TaskEnvelope,
    ResultEnvelope,
    StateEnvelope,
    EventEnvelope,
    ApprovalRequestEnvelope,
    ApprovalResponseEnvelope,
    ToolRequestEnvelope,
    ToolResponseEnvelope,
)


def create_task_envelope(
    capability: str,
    payload: dict[str, Any],
    *,
    tags: Optional[list[str]] = None,
    priority: str = "medium",
    timeout: Optional[int] = None,
    reply_to: Optional[str] = None,
    metadata: Optional[dict[str, Any]] = None,
    created_by: Optional[str] = None,
) -> TaskEnvelope:
    return TaskEnvelope(
        type="task",
        task_id=generate_id(),
        correlation_id=generate_id(),
        reply_to=reply_to,
        capability=capability,
        priority=priority,  # type: ignore[arg-type]
        payload=payload,
        tags=tags,
        metadata=metadata,
        created_at=create_timestamp(),
        created_by=created_by,
        timeout=timeout,
    )


def create_result_envelope(
    task_id: str,
    correlation_id: str,
    status: str,
    payload: dict[str, Any],
    error: Optional[dict[str, str]] = None,
    completed_by: Optional[str] = None,
) -> ResultEnvelope:
    return ResultEnvelope(
        type="result",
        task_id=task_id,
        correlation_id=correlation_id,
        status=status,  # type: ignore[arg-type]
        payload=payload,
        error=error,
        completed_at=create_timestamp(),
        completed_by=completed_by,
    )


def create_state_envelope(
    key: str,
    value: Any,
    version: int,
    updated_by: str,
) -> StateEnvelope:
    return StateEnvelope(
        type="state",
        key=key,
        value=value,
        version=version,
        updated_by=updated_by,
        updated_at=create_timestamp(),
    )


def create_event_envelope(
    category: str,
    emitted_by: str,
    payload: dict[str, Any],
    severity: str = "info",
) -> EventEnvelope:
    return EventEnvelope(
        type="event",
        event_id=generate_id(),
        severity=severity,  # type: ignore[arg-type]
        category=category,
        emitted_by=emitted_by,
        payload=payload,
        timestamp=create_timestamp(),
    )


def create_approval_request(
    action: str,
    context: Any,
    requested_by: str,
    *,
    urgency: str = "medium",
    expires_at: Optional[int] = None,
) -> ApprovalRequestEnvelope:
    return ApprovalRequestEnvelope(
        type="approval_request",
        request_id=generate_id(),
        correlation_id=generate_id(),
        action=action,
        context=context,
        urgency=urgency,  # type: ignore[arg-type]
        requested_by=requested_by,
        requested_at=create_timestamp(),
        expires_at=expires_at,
    )


def create_approval_response(
    request_id: str,
    correlation_id: str,
    decision: str,
    responded_by: str,
    reason: Optional[str] = None,
) -> ApprovalResponseEnvelope:
    return ApprovalResponseEnvelope(
        type="approval_response",
        request_id=request_id,
        correlation_id=correlation_id,
        decision=decision,  # type: ignore[arg-type]
        responded_by=responded_by,
        reason=reason,
        responded_at=create_timestamp(),
    )


def create_tool_request(
    tool_name: str,
    args: dict[str, Any],
    requested_by: str,
    *,
    reply_to: Optional[str] = None,
) -> ToolRequestEnvelope:
    return ToolRequestEnvelope(
        type="tool_request",
        request_id=generate_id(),
        correlation_id=generate_id(),
        reply_to=reply_to,
        tool_name=tool_name,
        arguments=args,
        requested_by=requested_by,
        requested_at=create_timestamp(),
    )


def create_tool_response(
    request_id: str,
    correlation_id: str,
    status: str,
    result: Any,
    error: Optional[dict[str, str]] = None,
    responded_by: Optional[str] = None,
) -> ToolResponseEnvelope:
    return ToolResponseEnvelope(
        type="tool_response",
        request_id=request_id,
        correlation_id=correlation_id,
        status=status,  # type: ignore[arg-type]
        result=result,
        error=error,
        responded_by=responded_by,
        responded_at=create_timestamp(),
    )
