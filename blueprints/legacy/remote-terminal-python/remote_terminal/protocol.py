"""Protocol types for remote terminal"""

import secrets
from dataclasses import dataclass, field
from typing import Optional, List

# Command types
CMD_TYPE_SHELL = "shell"
CMD_TYPE_INFO = "info"
CMD_TYPE_PING = "ping"
CMD_TYPE_KILL = "kill"
CMD_TYPE_COMPLETE = "complete"
CMD_TYPE_UPLOAD = "upload"
CMD_TYPE_DOWNLOAD = "download"
CMD_TYPE_LISTDIR = "listdir"
CMD_TYPE_SESSION_START = "session_start"
CMD_TYPE_SESSION_INPUT = "session_input"
CMD_TYPE_SESSION_RESIZE = "session_resize"
CMD_TYPE_SESSION_END = "session_end"

# Topics
APP_NAME = "remote-terminal"
TOPIC_COMMANDS = "commands"
TOPIC_RESPONSES = "responses"
TOPIC_STATUS = "status"
TOPIC_DISCOVERY = "discovery"
TOPIC_SESSION_OUTPUT = "session_output"


@dataclass
class Command:
    """Command from client to agent"""
    id: str
    type: str
    payload: str
    timestamp: int
    data: Optional[bytes] = None


@dataclass
class Response:
    """Response from agent to client"""
    commandId: str
    status: str  # 'success', 'error', 'running'
    output: str
    exitCode: int = 0
    error: Optional[str] = None
    data: Optional[bytes] = None
    completions: Optional[List[str]] = None


@dataclass
class DeviceStatus:
    """Device status broadcast by agent"""
    deviceId: str
    hostname: str
    os: str
    arch: str
    online: bool
    timestamp: int
    workDir: Optional[str] = None


@dataclass
class SessionStartPayload:
    """Payload for session_start command"""
    cols: int
    rows: int


@dataclass
class SessionInputPayload:
    """Payload for session_input command"""
    sessionId: str
    data: str  # Base64 encoded


@dataclass
class SessionResizePayload:
    """Payload for session_resize command"""
    sessionId: str
    cols: int
    rows: int


@dataclass
class SessionEndPayload:
    """Payload for session_end command"""
    sessionId: str


@dataclass
class SessionOutput:
    """Output from a PTY session"""
    sessionId: str
    data: str = ""  # Base64 encoded
    closed: bool = False


def generate_id() -> str:
    """Generate unique ID"""
    return secrets.token_hex(8)
