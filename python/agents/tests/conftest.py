from __future__ import annotations

import asyncio
from collections import defaultdict
from typing import Any, Callable
from unittest.mock import MagicMock

import pytest

from nolag_agents.agent_room import AgentRoom
from nolag_agents.types import AgentPresenceData


class MockRoomContext:
    """Mock of a nolag Room for testing (async API, matching the real Room)."""

    def __init__(self) -> None:
        self._listeners: dict[str, list[Callable[..., Any]]] = defaultdict(list)
        self._subscribed: list[tuple[str, Any]] = []
        self._published: list[tuple[str, Any, Any]] = []
        self._presence: dict[str, Any] | None = None
        self.unsubscribed: list[str] = []
        #: ("set" | "add" | "remove", topic, filters) in call order.
        self.filter_calls: list[tuple[str, str, Any]] = []
        #: Filters last applied per topic, so tests can assert the live set.
        self.topic_filters: dict[str, Any] = {}

    async def subscribe(self, topic: str, options: Any = None) -> None:
        self._subscribed.append((topic, options))
        filters = getattr(options, "filters", None)
        if filters:
            self.topic_filters[topic] = filters

    @property
    def subscribed_topics(self) -> list[str]:
        return [t for t, _ in self._subscribed]

    def subscribe_options(self, topic: str) -> Any:
        for t, opts in self._subscribed:
            if t == topic:
                return opts
        return None

    def on(self, topic: str, handler: Callable[..., Any]) -> None:
        self._listeners[topic].append(handler)

    def off(self, topic: str, handler: Callable[..., Any] | None = None) -> None:
        if handler is None:
            self._listeners[topic] = []
        else:
            self._listeners[topic] = [h for h in self._listeners[topic] if h != handler]

    def handler_count(self, topic: str) -> int:
        return len(self._listeners.get(topic, []))

    async def unsubscribe(self, topic: str) -> None:
        self.unsubscribed.append(topic)

    async def emit(self, topic: str, data: Any, options: Any = None) -> None:
        self._published.append((topic, data, options))

    async def set_filters(self, topic: str, filters: Any, callback: Any = None) -> None:
        self.filter_calls.append(("set", topic, filters))
        if isinstance(filters, list) and not filters:
            # Mirrors the core: an empty set reverts the topic to wildcard.
            self.topic_filters.pop(topic, None)
        else:
            self.topic_filters[topic] = filters

    async def add_filters(self, topic: str, filters: list[str], callback: Any = None) -> None:
        self.filter_calls.append(("add", topic, filters))

    async def remove_filters(self, topic: str, filters: list[str], callback: Any = None) -> None:
        self.filter_calls.append(("remove", topic, filters))

    async def set_presence(self, data: dict[str, Any]) -> None:
        self._presence = data

    async def fetch_presence(self) -> list[dict[str, Any]]:
        return []

    def simulate_message(self, topic: str, data: Any) -> None:
        """Simulate an incoming message on a topic."""
        for handler in self._listeners.get(topic, []):
            handler(data)


class MockAppContext:
    """Mock of a nolag app context (what client.set_app returns)."""

    def __init__(self, name: str) -> None:
        self.name = name
        self.rooms: dict[str, MockRoomContext] = {}
        self.lobbies: list[str] = []

    def set_room(self, name: str) -> "MockRoomContext":
        ctx = self.rooms.get(name)
        if ctx is None:
            ctx = MockRoomContext()
            self.rooms[name] = ctx
        return ctx

    def set_lobby(self, slug: str) -> Any:
        self.lobbies.append(slug)

        class _Lobby:
            async def subscribe(self_inner) -> dict[str, Any]:
                return {}

        return _Lobby()


class MockClient:
    """Mock of a nolag client for testing.

    Supports per-handler removal, matching the real SDK, so tests can assert that
    detach() takes back exactly its own handlers.
    """

    def __init__(self, connected: bool = True) -> None:
        self._listeners: dict[str, list[Callable[..., Any]]] = defaultdict(list)
        self._connected = connected
        self.app_contexts: list[MockAppContext] = []
        self.disconnect_calls = 0

    @property
    def connected(self) -> bool:
        return self._connected

    def set_connected(self, value: bool) -> None:
        self._connected = value

    def set_app(self, name: str) -> MockAppContext:
        ctx = MockAppContext(name)
        self.app_contexts.append(ctx)
        return ctx

    def disconnect(self) -> None:
        # A wrapper must never call this. Counted so tests can assert it stays 0.
        self.disconnect_calls += 1
        self._connected = False

    def on(self, event: str, handler: Callable[..., Any]) -> None:
        self._listeners[event].append(handler)

    def off(self, event: str, handler: Callable[..., Any] | None = None) -> None:
        if handler is None:
            self._listeners[event] = []
        else:
            self._listeners[event] = [h for h in self._listeners[event] if h != handler]

    def handler_count(self, event: str) -> int:
        return len(self._listeners.get(event, []))

    def simulate_event(self, event: str, *args: Any) -> None:
        for handler in list(self._listeners.get(event, [])):
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
