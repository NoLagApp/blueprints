from __future__ import annotations

import asyncio
from collections import defaultdict
from typing import Any, Callable
from unittest.mock import MagicMock

import pytest

from nolag_agents.agent_room import AgentRoom
from nolag_agents.types import AgentPresenceData


class MockRoomContext:
    """Mock of a nolag Room for testing."""

    def __init__(self) -> None:
        self._listeners: dict[str, list[Callable[..., Any]]] = defaultdict(list)
        self._subscribed: list[str] = []
        self._published: list[tuple[str, Any, dict[str, Any] | None]] = []
        self._presence: dict[str, Any] | None = None

    def subscribe(self, topic: str) -> None:
        self._subscribed.append(topic)

    def on(self, topic: str, handler: Callable[..., Any]) -> None:
        self._listeners[topic].append(handler)

    def emit(self, topic: str, data: Any, options: dict[str, Any] | None = None) -> None:
        self._published.append((topic, data, options))

    def set_presence(self, data: dict[str, Any]) -> None:
        self._presence = data

    async def fetch_presence(self) -> list[dict[str, Any]]:
        return []

    def simulate_message(self, topic: str, data: Any) -> None:
        """Simulate an incoming message on a topic."""
        for handler in self._listeners.get(topic, []):
            handler(data)


class MockClient:
    """Mock of a nolag client for testing."""

    def __init__(self) -> None:
        self._listeners: dict[str, list[Callable[..., Any]]] = defaultdict(list)

    def on(self, event: str, handler: Callable[..., Any]) -> None:
        self._listeners[event].append(handler)

    def simulate_event(self, event: str, *args: Any) -> None:
        for handler in self._listeners.get(event, []):
            handler(*args)


def _noop_log(*args: Any) -> None:
    pass


@pytest.fixture
def mock_room_context() -> MockRoomContext:
    return MockRoomContext()


@pytest.fixture
def mock_client() -> MockClient:
    return MockClient()


@pytest.fixture
def agent_room(mock_room_context: MockRoomContext, mock_client: MockClient) -> AgentRoom:
    return AgentRoom(
        name="test-room",
        room_context=mock_room_context,
        client=mock_client,
        log=_noop_log,
        agent_id="test-agent",
    )


@pytest.fixture
def agent_room_with_presence(
    mock_room_context: MockRoomContext, mock_client: MockClient,
) -> AgentRoom:
    return AgentRoom(
        name="test-room",
        room_context=mock_room_context,
        client=mock_client,
        log=_noop_log,
        agent_id="test-agent",
        presence=AgentPresenceData(name="Test Agent", role="agent", capabilities=["test"]),
    )
