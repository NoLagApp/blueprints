from __future__ import annotations

from dataclasses import dataclass, field, asdict
from typing import Any, Literal, Optional


@dataclass
class NoLagAgentsOptions:
    app_name: str = "agents"
    agent_id: str = ""
    debug: bool = False
    rooms: list[str] = field(default_factory=lambda: ["default-workflow"])
    lobby: Optional[str] = None
    presence: Optional[AgentPresenceData] = None
    client_options: Optional[dict[str, Any]] = None
    load_balance: bool = False
    load_balance_group: Optional[str] = None
    load_balance_topics: Optional[list[str]] = None


@dataclass
class AgentPresenceData:
    name: str
    role: str
    capabilities: list[str] = field(default_factory=list)
    metadata: Optional[dict[str, Any]] = None
    # Agents-protocol version (auto-injected by the SDK; absent = 1)
    protocol: Optional[int] = None
    # Persistent Presence: keep a durable, discoverable, wakeable record while
    # disconnected (e.g. scaled to zero). `wake` = {"url", "timeoutMs"?, "enabled"?}.
    persistent: Optional[bool] = None
    wake: Optional[dict[str, Any]] = None

    def to_dict(self) -> dict[str, Any]:
        d: dict[str, Any] = {"name": self.name, "role": self.role}
        if self.capabilities:
            d["capabilities"] = self.capabilities
        if self.metadata is not None:
            d["metadata"] = self.metadata
        if self.protocol is not None:
            d["protocol"] = self.protocol
        if self.persistent is not None:
            d["persistent"] = self.persistent
        if self.wake is not None:
            d["wake"] = self.wake
        return d


@dataclass
class TaskEnvelope:
    type: Literal["task"] = "task"
    # Agents-protocol version of the sender (absent = 1, pre-directed-replies)
    protocol: Optional[int] = None
    task_id: str = ""
    correlation_id: str = ""
    capability: str = ""
    priority: Literal["low", "medium", "high", "critical"] = "medium"
    payload: dict[str, Any] = field(default_factory=dict)
    reply_to: Optional[str] = None
    tags: Optional[list[str]] = None
    metadata: Optional[dict[str, Any]] = None
    created_at: int = 0
    created_by: Optional[str] = None
    timeout: Optional[int] = None

    def to_dict(self) -> dict[str, Any]:
        return _to_camel_dict(asdict(self))


@dataclass
class ResultEnvelope:
    type: Literal["result"] = "result"
    # Agents-protocol version of the sender (absent = 1, pre-directed-replies)
    protocol: Optional[int] = None
    task_id: str = ""
    correlation_id: str = ""
    status: Literal["success", "error", "partial"] = "success"
    payload: dict[str, Any] = field(default_factory=dict)
    error: Optional[dict[str, str]] = None
    completed_at: int = 0
    completed_by: Optional[str] = None
    # Reply address (agent_id of the dispatcher) — used as the publish filter
    # for directed delivery
    reply_to: Optional[str] = None

    def to_dict(self) -> dict[str, Any]:
        return _to_camel_dict(asdict(self))


@dataclass
class StateEnvelope:
    type: Literal["state"] = "state"
    # Agents-protocol version of the sender (absent = 1, pre-directed-replies)
    protocol: Optional[int] = None
    key: str = ""
    value: Any = None
    version: int = 0
    updated_at: int = 0
    updated_by: str = ""

    def to_dict(self) -> dict[str, Any]:
        return _to_camel_dict(asdict(self))


@dataclass
class EventEnvelope:
    type: Literal["event"] = "event"
    # Agents-protocol version of the sender (absent = 1, pre-directed-replies)
    protocol: Optional[int] = None
    event_id: str = ""
    severity: Literal["debug", "info", "warning", "error", "critical"] = "info"
    category: str = ""
    payload: dict[str, Any] = field(default_factory=dict)
    timestamp: int = 0
    emitted_by: str = ""

    def to_dict(self) -> dict[str, Any]:
        return _to_camel_dict(asdict(self))


@dataclass
class ApprovalRequestEnvelope:
    type: Literal["approval_request"] = "approval_request"
    # Agents-protocol version of the sender (absent = 1, pre-directed-replies)
    protocol: Optional[int] = None
    request_id: str = ""
    correlation_id: str = ""
    action: str = ""
    context: Any = None
    urgency: Literal["low", "medium", "high", "critical"] = "medium"
    expires_at: Optional[int] = None
    requested_by: str = ""
    requested_at: int = 0

    def to_dict(self) -> dict[str, Any]:
        return _to_camel_dict(asdict(self))


@dataclass
class ApprovalResponseEnvelope:
    type: Literal["approval_response"] = "approval_response"
    # Agents-protocol version of the sender (absent = 1, pre-directed-replies)
    protocol: Optional[int] = None
    request_id: str = ""
    correlation_id: str = ""
    decision: Literal["approved", "rejected", "deferred"] = "approved"
    reason: Optional[str] = None
    responded_by: str = ""
    responded_at: int = 0

    def to_dict(self) -> dict[str, Any]:
        return _to_camel_dict(asdict(self))


@dataclass
class ToolRequestEnvelope:
    type: Literal["tool_request"] = "tool_request"
    # Agents-protocol version of the sender (absent = 1, pre-directed-replies)
    protocol: Optional[int] = None
    request_id: str = ""
    correlation_id: str = ""
    reply_to: Optional[str] = None
    tool_name: str = ""
    arguments: dict[str, Any] = field(default_factory=dict)
    requested_by: str = ""
    requested_at: int = 0

    def to_dict(self) -> dict[str, Any]:
        return _to_camel_dict(asdict(self))


@dataclass
class ToolResponseEnvelope:
    type: Literal["tool_response"] = "tool_response"
    # Agents-protocol version of the sender (absent = 1, pre-directed-replies)
    protocol: Optional[int] = None
    request_id: str = ""
    correlation_id: str = ""
    status: Literal["success", "error"] = "success"
    result: Any = None
    error: Optional[dict[str, str]] = None
    responded_by: Optional[str] = None
    responded_at: int = 0
    # Reply address (agent_id of the requester) — used as the publish filter
    # for directed delivery
    reply_to: Optional[str] = None

    def to_dict(self) -> dict[str, Any]:
        return _to_camel_dict(asdict(self))


@dataclass
class ConnectedAgent:
    actor_id: str = ""
    name: str = ""
    role: str = "agent"
    # Agents-protocol version the agent advertised (absent presence field = 1)
    protocol: int = 1
    capabilities: list[str] = field(default_factory=list)
    metadata: Optional[dict[str, Any]] = None
    connected_at: int = 0
    # Persistent Presence: "online" | "offline" | "waking"; None for ephemeral
    # agents (treated as online when present).
    status: Optional[str] = None


@dataclass
class InboxMessage:
    message_id: str = ""
    from_agent: str = ""
    to: str = ""
    payload: dict[str, Any] = field(default_factory=dict)
    created_at: int = 0

    def to_dict(self) -> dict[str, Any]:
        d = _to_camel_dict(asdict(self))
        # JS uses "from" not "fromAgent"
        d["from"] = d.pop("fromAgent", self.from_agent)
        return d


def _to_camel_dict(d: dict[str, Any]) -> dict[str, Any]:
    """Convert snake_case dict keys to camelCase for JSON interop with JS SDK."""
    result: dict[str, Any] = {}
    for key, value in d.items():
        if value is None:
            continue
        camel = _snake_to_camel(key)
        if isinstance(value, dict):
            result[camel] = _to_camel_dict(value)
        else:
            result[camel] = value
    return result


def _snake_to_camel(name: str) -> str:
    parts = name.split("_")
    return parts[0] + "".join(p.capitalize() for p in parts[1:])


def from_camel_dict(d: dict[str, Any]) -> dict[str, Any]:
    """Convert camelCase dict keys to snake_case."""
    result: dict[str, Any] = {}
    for key, value in d.items():
        snake = _camel_to_snake(key)
        if isinstance(value, dict):
            result[snake] = from_camel_dict(value)
        else:
            result[snake] = value
    return result


def _camel_to_snake(name: str) -> str:
    import re
    s = re.sub(r"([A-Z])", r"_\1", name)
    return s.lower().lstrip("_")
