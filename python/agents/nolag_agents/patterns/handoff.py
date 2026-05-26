from __future__ import annotations

from typing import Any, Callable, Optional, Union

from ..agent_room import AgentRoom
from ..types import TaskEnvelope, ResultEnvelope, from_camel_dict
from ..correlation import CorrelationManager
from ..envelope import create_task_envelope, create_result_envelope


class Handoff:
    """Task dispatch and capability routing pattern.

    Orchestrators use dispatch() to send work. Workers use on_task()
    with a capabilities filter.
    """

    def __init__(self, room: AgentRoom) -> None:
        self._room = room
        self._correlations: CorrelationManager[ResultEnvelope] = CorrelationManager()

        self._room.on("result", self._on_result)

    def _on_result(self, data: Any) -> None:
        d = data if isinstance(data, dict) else {}
        correlation_id = d.get("correlationId", d.get("correlation_id", ""))
        if correlation_id:
            envelope = _dict_to_result(d)
            self._correlations.resolve(correlation_id, envelope)

    async def dispatch(
        self,
        capability: str,
        payload: dict[str, Any],
        *,
        tags: Optional[list[str]] = None,
        priority: str = "medium",
        timeout: Optional[int] = None,
        wait_for_result: bool = False,
        metadata: Optional[dict[str, Any]] = None,
        allow_no_workers: bool = False,
    ) -> Optional[ResultEnvelope]:
        if not allow_no_workers:
            capable = self._room.find_agents(capability)
            if len(capable) == 0:
                available = self._room.get_available_capabilities()
                connected = self._room.get_connected_agents()
                raise RuntimeError(
                    f'No agent with capability "{capability}" is connected. '
                    f"Available capabilities: [{', '.join(available)}]. "
                    f"Connected agents: {len(connected)}. "
                    f"Use allow_no_workers=True to dispatch anyway."
                )

        envelope = create_task_envelope(
            capability,
            payload,
            tags=tags,
            priority=priority,
            timeout=timeout,
            metadata=metadata,
            created_by=self._room.agent_id,
        )
        await self._room.publish_task(envelope)

        if wait_for_result:
            return await self._correlations.register(
                envelope.correlation_id, timeout
            )
        return None

    def on_task(
        self,
        capabilities: Union[list[str], str],
        handler: Callable[[TaskEnvelope, Callable[..., Any]], Any],
    ) -> None:
        def _handler(data: Any) -> None:
            d = data if isinstance(data, dict) else {}
            task = _dict_to_task(d)

            if capabilities != "*" and task.capability not in capabilities:
                return

            async def _respond(
                status: str,
                result_payload: dict[str, Any],
                error: Optional[dict[str, str]] = None,
            ) -> None:
                result = create_result_envelope(
                    task.task_id,
                    task.correlation_id,
                    status,
                    result_payload,
                    error,
                    self._room.agent_id,
                )
                await self._room.publish_result(result)

            handler(task, _respond)

        self._room.on("task", _handler)

    def get_capable_agents(self, capability: str):
        return self._room.find_agents(capability)

    def dispose(self) -> None:
        self._correlations.clear()


def _dict_to_task(d: dict[str, Any]) -> TaskEnvelope:
    return TaskEnvelope(
        type="task",
        task_id=d.get("taskId", d.get("task_id", "")),
        correlation_id=d.get("correlationId", d.get("correlation_id", "")),
        capability=d.get("capability", ""),
        priority=d.get("priority", "medium"),
        payload=d.get("payload", {}),
        reply_to=d.get("replyTo", d.get("reply_to")),
        tags=d.get("tags"),
        metadata=d.get("metadata"),
        created_at=d.get("createdAt", d.get("created_at", 0)),
        created_by=d.get("createdBy", d.get("created_by")),
        timeout=d.get("timeout"),
    )


def _dict_to_result(d: dict[str, Any]) -> ResultEnvelope:
    return ResultEnvelope(
        type="result",
        task_id=d.get("taskId", d.get("task_id", "")),
        correlation_id=d.get("correlationId", d.get("correlation_id", "")),
        status=d.get("status", "success"),
        payload=d.get("payload", {}),
        error=d.get("error"),
        completed_at=d.get("completedAt", d.get("completed_at", 0)),
        completed_by=d.get("completedBy", d.get("completed_by")),
    )
