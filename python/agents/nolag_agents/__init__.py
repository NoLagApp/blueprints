"""nolag-agents: Multi-agent coordination SDK for NoLag."""

from .errors import IncompatibleProtocolError
from .constants import AGENTS_PROTOCOL_VERSION
from .client import NoLagAgents
from .agent_room import AgentRoom
from .event_emitter import EventEmitter
from .correlation import CorrelationManager
from .patterns.handoff import Handoff
from .patterns.blackboard import Blackboard
from .patterns.inbox import Inbox
from .patterns.tools import Tools
from .patterns.approve import Approve
from .patterns.observe import Observe
from .envelope import (
    create_task_envelope,
    create_result_envelope,
    create_state_envelope,
    create_event_envelope,
    create_approval_request,
    create_approval_response,
    create_tool_request,
    create_tool_response,
)
from .types import (
    NoLagAgentsOptions,
    AgentPresenceData,
    TaskEnvelope,
    ResultEnvelope,
    StateEnvelope,
    EventEnvelope,
    ApprovalRequestEnvelope,
    ApprovalResponseEnvelope,
    ToolRequestEnvelope,
    ToolResponseEnvelope,
    ConnectedAgent,
    InboxMessage,
)

__all__ = [
    "IncompatibleProtocolError",
    "AGENTS_PROTOCOL_VERSION",
    "NoLagAgents",
    "AgentRoom",
    "EventEmitter",
    "CorrelationManager",
    "Handoff",
    "Blackboard",
    "Inbox",
    "Tools",
    "Approve",
    "Observe",
    "create_task_envelope",
    "create_result_envelope",
    "create_state_envelope",
    "create_event_envelope",
    "create_approval_request",
    "create_approval_response",
    "create_tool_request",
    "create_tool_response",
    "NoLagAgentsOptions",
    "AgentPresenceData",
    "TaskEnvelope",
    "ResultEnvelope",
    "StateEnvelope",
    "EventEnvelope",
    "ApprovalRequestEnvelope",
    "ApprovalResponseEnvelope",
    "ToolRequestEnvelope",
    "ToolResponseEnvelope",
    "ConnectedAgent",
    "InboxMessage",
]
