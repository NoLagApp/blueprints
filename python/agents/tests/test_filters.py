"""Filter API contract for nolag-agents.

The headline use is capability routing: today a worker receives every task and
discards what it cannot handle, which under load balancing means a task can be
handed to a worker that drops it. Filters move that matching to the broker.

``results`` is deliberately NOT filterable — it carries directed replies keyed
to the recipient's agent id, and repointing it would strand every pending task
result and tool response.
"""

from __future__ import annotations

import pytest

from nolag_agents.agent_room import ALL_FILTER_TOPICS, AgentRoom
from nolag_agents.utils import composite_filter_key, inherit_filter, merge_filters, without_filters

from .conftest import MockClient, MockRoomContext


def _noop_log(*_args: object) -> None:
    pass


def make_room(
    ctx: MockRoomContext,
    client: MockClient,
    filters: list[object] | None = None,
) -> AgentRoom:
    return AgentRoom(
        name="test-room",
        room_context=ctx,
        client=client,
        log=_noop_log,
        agent_id="test-agent",
        filters=filters,  # type: ignore[arg-type]
    )


class TestFilterHelpers:
    def test_merge_preserves_and_groups(self) -> None:
        assert merge_filters(["a", ["b", "c"]], ["d"]) == ["a", "d", ["b", "c"]]

    def test_merge_does_not_duplicate(self) -> None:
        assert merge_filters(["a"], ["a"]) == ["a"]

    def test_without_drops_only_named_or_terms(self) -> None:
        assert without_filters(["a", "b", ["a", "c"]], ["a"]) == ["b", ["a", "c"]]

    def test_composite_key_matches_server_normalisation(self) -> None:
        # Server lowercases, sorts, and joins with '|'.
        assert composite_filter_key(["Sports", "live"]) == "live|sports"

    def test_inherit_splits_a_composite_back_apart(self) -> None:
        # '|' is not legal inside a single filter value.
        assert inherit_filter("live|sports") == {"filters": ["live", "sports"]}

    def test_inherit_passes_a_plain_filter_through(self) -> None:
        assert inherit_filter("sports") == {"filter": "sports"}

    def test_inherit_of_nothing_is_unfiltered(self) -> None:
        assert inherit_filter(None) == {}


class TestSubscribe:
    @pytest.mark.asyncio
    async def test_subscribes_unfiltered_by_default(
        self, mock_room_context: MockRoomContext, mock_client: MockClient
    ) -> None:
        room = make_room(mock_room_context, mock_client)
        await room.initialize()

        opts = mock_room_context.subscribe_options("tasks")
        assert getattr(opts, "filters", None) is None

    @pytest.mark.asyncio
    async def test_keeps_results_keyed_to_this_agent(
        self, mock_room_context: MockRoomContext, mock_client: MockClient
    ) -> None:
        room = make_room(mock_room_context, mock_client)
        await room.initialize()

        assert mock_room_context.topic_filters["results"] == ["test-agent"]

    @pytest.mark.asyncio
    async def test_applies_filters_to_every_filterable_topic(
        self, mock_room_context: MockRoomContext, mock_client: MockClient
    ) -> None:
        room = make_room(mock_room_context, mock_client, filters=["ocr"])
        await room.initialize()

        for topic in ALL_FILTER_TOPICS:
            assert mock_room_context.topic_filters[topic] == ["ocr"], topic

    @pytest.mark.asyncio
    async def test_never_applies_them_to_results(
        self, mock_room_context: MockRoomContext, mock_client: MockClient
    ) -> None:
        room = make_room(mock_room_context, mock_client, filters=["ocr"])
        await room.initialize()

        assert mock_room_context.topic_filters["results"] == ["test-agent"]


class TestSetFilters:
    @pytest.mark.asyncio
    async def test_covers_every_filterable_topic_and_never_results(
        self, mock_room_context: MockRoomContext, mock_client: MockClient
    ) -> None:
        room = make_room(mock_room_context, mock_client)
        await room.initialize()
        mock_room_context.filter_calls.clear()

        await room.set_filters(["ocr"])

        touched = sorted(topic for _, topic, _ in mock_room_context.filter_calls)
        assert touched == sorted(ALL_FILTER_TOPICS)
        assert "results" not in touched

    @pytest.mark.asyncio
    async def test_scopes_to_one_topic(
        self, mock_room_context: MockRoomContext, mock_client: MockClient
    ) -> None:
        room = make_room(mock_room_context, mock_client)
        await room.initialize()
        mock_room_context.filter_calls.clear()

        await room.set_filters(["ocr"], topic="tasks")

        assert [t for _, t, _ in mock_room_context.filter_calls] == ["tasks"]
        assert room.filters["tasks"] == ["ocr"]
        assert room.filters["events"] == []

    @pytest.mark.asyncio
    async def test_empty_list_reverts_to_wildcard(
        self, mock_room_context: MockRoomContext, mock_client: MockClient
    ) -> None:
        room = make_room(mock_room_context, mock_client, filters=["ocr"])
        await room.initialize()

        await room.set_filters([])

        assert room.filters["tasks"] == []
        assert "tasks" not in mock_room_context.topic_filters

    @pytest.mark.asyncio
    async def test_clearing_leaves_results_directed(
        self, mock_room_context: MockRoomContext, mock_client: MockClient
    ) -> None:
        room = make_room(mock_room_context, mock_client, filters=["ocr"])
        await room.initialize()

        await room.set_filters([])

        assert mock_room_context.topic_filters["results"] == ["test-agent"]

    @pytest.mark.asyncio
    async def test_add_and_remove(
        self, mock_room_context: MockRoomContext, mock_client: MockClient
    ) -> None:
        room = make_room(mock_room_context, mock_client, filters=["ocr"])
        await room.initialize()

        await room.add_filters(["translate"], topic="tasks")
        assert room.filters["tasks"] == ["ocr", "translate"]

        await room.remove_filters(["ocr"], topic="tasks")
        assert room.filters["tasks"] == ["translate"]

    @pytest.mark.asyncio
    async def test_preserves_and_groups(
        self, mock_room_context: MockRoomContext, mock_client: MockClient
    ) -> None:
        room = make_room(mock_room_context, mock_client, filters=[["ocr", "gpu"]])
        await room.initialize()

        await room.add_filters(["translate"], topic="tasks")

        assert room.filters["tasks"] == ["translate", ["ocr", "gpu"]]

    @pytest.mark.asyncio
    async def test_rejects_an_unknown_topic(
        self, mock_room_context: MockRoomContext, mock_client: MockClient
    ) -> None:
        room = make_room(mock_room_context, mock_client)
        await room.initialize()

        # 'results' is not filterable, so naming it is a mistake worth catching
        # rather than a silent no-op.
        with pytest.raises(ValueError, match="unknown filter topic"):
            await room.set_filters(["x"], topic="results")  # type: ignore[arg-type]

    @pytest.mark.asyncio
    async def test_filters_property_is_a_copy(
        self, mock_room_context: MockRoomContext, mock_client: MockClient
    ) -> None:
        room = make_room(mock_room_context, mock_client, filters=["ocr"])
        await room.initialize()

        room.filters["tasks"].append("mallory")

        assert room.filters["tasks"] == ["ocr"]


class TestPublish:
    @pytest.mark.asyncio
    async def test_publish_task_routes_by_capability(
        self, mock_room_context: MockRoomContext, mock_client: MockClient
    ) -> None:
        room = make_room(mock_room_context, mock_client)
        await room.initialize()

        await room.publish_task({"taskId": "t1", "capability": "ocr"}, filter="ocr")

        topic, _data, options = mock_room_context._published[-1]
        assert topic == "tasks"
        assert options.filter == "ocr"

    @pytest.mark.asyncio
    async def test_publish_task_stays_a_broadcast_without_a_filter(
        self, mock_room_context: MockRoomContext, mock_client: MockClient
    ) -> None:
        room = make_room(mock_room_context, mock_client)
        await room.initialize()

        await room.publish_task({"taskId": "t1", "capability": "ocr"})

        topic, _data, options = mock_room_context._published[-1]
        assert topic == "tasks"
        assert options is None

    @pytest.mark.asyncio
    async def test_filter_wins_over_filters(
        self, mock_room_context: MockRoomContext, mock_client: MockClient
    ) -> None:
        room = make_room(mock_room_context, mock_client)
        await room.initialize()

        await room.publish_task({"taskId": "t1"}, filter="ocr", filters=["a", "b"])

        _topic, _data, options = mock_room_context._published[-1]
        assert options.filter == "ocr"
        # getattr, not attribute access: the composite `filters` field only
        # exists on nolag >= 2.5.1, and an unfiltered publish must not require
        # it. Either way, no composite may have been applied.
        assert getattr(options, "filters", None) is None

    @pytest.mark.asyncio
    async def test_a_directed_result_ignores_caller_filters(
        self, mock_room_context: MockRoomContext, mock_client: MockClient
    ) -> None:
        room = make_room(mock_room_context, mock_client)
        await room.initialize()

        await room.publish_result({"taskId": "t1", "replyTo": "agent-9"})

        topic, _data, options = mock_room_context._published[-1]
        assert topic == "results"
        assert options.filter == "agent-9"

    @pytest.mark.asyncio
    async def test_a_tool_response_stays_directed(
        self, mock_room_context: MockRoomContext, mock_client: MockClient
    ) -> None:
        room = make_room(mock_room_context, mock_client)
        await room.initialize()

        await room.publish_tools(
            {"type": "tool_response", "replyTo": "agent-9"},
            filter="should-be-ignored",
        )

        topic, _data, options = mock_room_context._published[-1]
        assert topic == "results"
        assert options.filter == "agent-9"

    @pytest.mark.asyncio
    async def test_a_tool_request_honours_a_caller_filter(
        self, mock_room_context: MockRoomContext, mock_client: MockClient
    ) -> None:
        room = make_room(mock_room_context, mock_client)
        await room.initialize()

        await room.publish_tools({"type": "tool_request"}, filter="search-pool")

        topic, _data, options = mock_room_context._published[-1]
        assert topic == "tools"
        assert options.filter == "search-pool"

    @pytest.mark.asyncio
    async def test_event_inbox_and_approval_accept_a_filter(
        self, mock_room_context: MockRoomContext, mock_client: MockClient
    ) -> None:
        room = make_room(mock_room_context, mock_client)
        await room.initialize()

        for send, topic in (
            (room.publish_event, "events"),
            (room.publish_inbox, "inbox"),
            (room.publish_approval, "approval"),
        ):
            await send({"kind": "x"}, filter="ops")
            published_topic, _data, options = mock_room_context._published[-1]
            assert published_topic == topic
            assert options.filter == "ops"


class TestObservePattern:
    """`Observe` is what @nolag/voice is built on, so its scoping matters."""

    @pytest.mark.asyncio
    async def test_emits_unfiltered_by_default(
        self, mock_room_context: MockRoomContext, mock_client: MockClient
    ) -> None:
        from nolag_agents.patterns.observe import Observe

        room = make_room(mock_room_context, mock_client)
        await room.initialize()
        observe = Observe(room, "agent-1")

        await observe.emit("task-started", {"taskId": "t1"})

        _topic, _data, options = mock_room_context._published[-1]
        assert options is None

    @pytest.mark.asyncio
    async def test_routes_an_emit_when_given_a_filter(
        self, mock_room_context: MockRoomContext, mock_client: MockClient
    ) -> None:
        from nolag_agents.patterns.observe import Observe

        room = make_room(mock_room_context, mock_client)
        await room.initialize()
        observe = Observe(room, "agent-1")

        await observe.emit("task-started", {"taskId": "t1"}, filter="task-started")

        topic, _data, options = mock_room_context._published[-1]
        assert topic == "events"
        assert options.filter == "task-started"

    @pytest.mark.asyncio
    async def test_set_filters_is_scoped_to_events(
        self, mock_room_context: MockRoomContext, mock_client: MockClient
    ) -> None:
        from nolag_agents.patterns.observe import Observe

        room = make_room(mock_room_context, mock_client)
        await room.initialize()
        mock_room_context.filter_calls.clear()
        observe = Observe(room, "agent-1")

        await observe.set_filters(["task-started"])

        # Room-wide would also filter `inbox`, whose messages are published
        # unfiltered and matched on `to` client-side — they would stop arriving.
        assert [t for _, t, _ in mock_room_context.filter_calls] == ["events"]
        assert room.filters["inbox"] == []
