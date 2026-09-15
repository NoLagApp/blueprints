"""Filter API contract for nolag-signal.

Signaling defaults to a room broadcast with peers discarding what is not
addressed to them. Filters move that addressing to the server: each peer
filters on its own peer id and sends with ``filter=to_peer_id``.

This is exclusive rather than additive — a filtered peer no longer receives the
unfiltered broadcasts other peers send — so it is opt-in and the whole room has
to adopt it together.
"""

from __future__ import annotations

from collections import defaultdict
from typing import Any, Callable

import pytest

from nolag_signal.constants import TOPIC_SIGNALING
from nolag_signal.signal_room import (
    SignalRoom,
    _merge_filters,
    _without_filters,
)
from nolag_signal.types import NoLagSignalOptions, Peer


class MockRoom:
    """Mock of a nolag Room, recording subscribes, publishes and filter calls."""

    def __init__(self) -> None:
        self._listeners: dict[str, list[Callable[..., Any]]] = defaultdict(list)
        self.subscribed: list[tuple[str, Any]] = []
        self.published: list[tuple[str, Any, Any]] = []
        self.filter_calls: list[tuple[str, Any]] = []
        self.topic_filters: dict[str, Any] = {}

    async def subscribe(self, topic: str, options: Any = None) -> None:
        self.subscribed.append((topic, options))
        filters = getattr(options, "filters", None)
        if filters:
            self.topic_filters[topic] = filters

    async def unsubscribe(self, topic: str) -> None:
        pass

    def on(self, topic: str, handler: Callable[..., Any]) -> None:
        self._listeners[topic].append(handler)

    def off(self, topic: str, handler: Callable[..., Any] | None = None) -> None:
        self._listeners[topic] = []

    async def emit(self, topic: str, data: Any, options: Any = None) -> None:
        self.published.append((topic, data, options))

    async def set_filters(self, topic: str, filters: Any, callback: Any = None) -> None:
        self.filter_calls.append((topic, filters))
        if isinstance(filters, list) and not filters:
            # Mirrors the core: an empty set reverts the topic to wildcard.
            self.topic_filters.pop(topic, None)
        else:
            self.topic_filters[topic] = filters

    async def set_presence(self, data: dict[str, Any]) -> None:
        pass

    def subscribe_options(self, topic: str) -> Any:
        for t, opts in self.subscribed:
            if t == topic:
                return opts
        return None


def _noop_log(*_args: object) -> None:
    pass


@pytest.fixture
def room() -> MockRoom:
    return MockRoom()


@pytest.fixture
def signal_room(room: MockRoom) -> SignalRoom:
    return SignalRoom(
        name="call-1",
        room_context=room,  # type: ignore[arg-type]
        local_peer=Peer(peer_id="peer-a", actor_token_id="actor-1", is_local=True),
        options=NoLagSignalOptions(app_name="signal-app"),
        log=_noop_log,
    )


class TestFilterHelpers:
    def test_merge_preserves_and_groups(self) -> None:
        assert _merge_filters(["a", ["b", "c"]], ["d"]) == ["a", "d", ["b", "c"]]

    def test_merge_does_not_duplicate(self) -> None:
        assert _merge_filters(["a"], ["a"]) == ["a"]

    def test_without_drops_only_named_or_terms(self) -> None:
        assert _without_filters(["a", "b", ["a", "c"]], ["a"]) == ["b", ["a", "c"]]


class TestSubscribe:
    async def test_subscribes_unfiltered_by_default(
        self, signal_room: SignalRoom, room: MockRoom
    ) -> None:
        await signal_room._subscribe()

        assert room.subscribe_options(TOPIC_SIGNALING) is None
        assert signal_room.filters == []

    async def test_subscribes_with_join_time_filters(
        self, signal_room: SignalRoom, room: MockRoom
    ) -> None:
        await signal_room._subscribe(["peer-a"])

        assert room.topic_filters[TOPIC_SIGNALING] == ["peer-a"]
        assert signal_room.filters == ["peer-a"]

    async def test_exposes_the_local_peer_id_to_filter_on(
        self, signal_room: SignalRoom
    ) -> None:
        assert signal_room.local_peer_id == "peer-a"


class TestSetFilters:
    async def test_replaces_the_set(self, signal_room: SignalRoom, room: MockRoom) -> None:
        await signal_room._subscribe()

        await signal_room.set_filters([signal_room.local_peer_id])

        assert signal_room.filters == ["peer-a"]
        assert room.topic_filters[TOPIC_SIGNALING] == ["peer-a"]

    async def test_empty_list_returns_to_room_broadcast(
        self, signal_room: SignalRoom, room: MockRoom
    ) -> None:
        await signal_room._subscribe(["peer-a"])

        await signal_room.set_filters([])

        assert signal_room.filters == []
        assert TOPIC_SIGNALING not in room.topic_filters

    async def test_add_and_remove(self, signal_room: SignalRoom) -> None:
        await signal_room._subscribe(["peer-a"])

        await signal_room.add_filters(["peer-b"])
        assert signal_room.filters == ["peer-a", "peer-b"]

        await signal_room.remove_filters(["peer-a"])
        assert signal_room.filters == ["peer-b"]

    async def test_filters_property_is_a_copy(self, signal_room: SignalRoom) -> None:
        await signal_room._subscribe(["peer-a"])

        signal_room.filters.append("mallory")

        assert signal_room.filters == ["peer-a"]


class TestSignalPublish:
    async def test_broadcasts_unfiltered_by_default(
        self, signal_room: SignalRoom, room: MockRoom
    ) -> None:
        await signal_room._subscribe()

        await signal_room.signal("peer-b", "offer", {"sdp": "x"})

        topic, _data, options = room.published[-1]
        assert topic == TOPIC_SIGNALING
        assert options.echo is False
        assert getattr(options, "filter", None) is None

    async def test_routes_directly_when_given_a_filter(
        self, signal_room: SignalRoom, room: MockRoom
    ) -> None:
        await signal_room._subscribe()

        await signal_room.signal("peer-b", "offer", {"sdp": "x"}, filter="peer-b")

        _topic, _data, options = room.published[-1]
        assert options.filter == "peer-b"
        assert options.echo is False

    async def test_addresses_the_intended_peer_in_the_payload_too(
        self, signal_room: SignalRoom, room: MockRoom
    ) -> None:
        await signal_room._subscribe()

        await signal_room.signal("peer-b", "offer", {"sdp": "x"}, filter="peer-b")

        _topic, data, _options = room.published[-1]
        assert data["toPeerId"] == "peer-b"
        assert data["fromPeerId"] == "peer-a"

    async def test_send_helpers_forward_the_filter(
        self, signal_room: SignalRoom, room: MockRoom
    ) -> None:
        await signal_room._subscribe()

        for send in (
            lambda: signal_room.send_offer("peer-b", {"sdp": "x"}, filter="peer-b"),
            lambda: signal_room.send_answer("peer-b", {"sdp": "x"}, filter="peer-b"),
            lambda: signal_room.send_ice_candidate("peer-b", {"candidate": "c"}, filter="peer-b"),
            lambda: signal_room.send_bye("peer-b", filter="peer-b"),
        ):
            room.published.clear()
            await send()
            _topic, _data, options = room.published[-1]
            assert options.filter == "peer-b"

    async def test_send_helpers_stay_broadcast_without_a_filter(
        self, signal_room: SignalRoom, room: MockRoom
    ) -> None:
        await signal_room._subscribe()

        await signal_room.send_bye("peer-b")

        _topic, _data, options = room.published[-1]
        assert getattr(options, "filter", None) is None
