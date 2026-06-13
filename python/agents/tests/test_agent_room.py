import pytest
from tests.conftest import MockRoomContext, MockClient
from nolag_agents.agent_room import AgentRoom
from nolag_agents.types import AgentPresenceData, ConnectedAgent


def _noop(*args):
    pass


class TestAgentRoom:
    async def test_subscribes_to_all_topics(self, mock_room_context):
        room = AgentRoom("test", mock_room_context, MockClient(), _noop, "agent-1")
        await room.initialize()
        expected = {"tasks", "results", "state", "events", "inbox", "tools", "approval"}
        assert set(mock_room_context.subscribed_topics) == expected

    async def test_results_subscription_is_filtered_and_not_load_balanced(self, mock_room_context):
        # Directed replies: each agent listens only on its own filter
        # sub-topic of results, never load-balanced
        room = AgentRoom("test", mock_room_context, MockClient(), _noop, "agent-1")
        await room.initialize()
        opts = mock_room_context.subscribe_options("results")
        assert opts is not None
        assert opts.load_balance is False
        assert opts.filters == ["agent-1"]

    async def test_broadcast_topics_never_load_balanced(self, mock_room_context):
        room = AgentRoom(
            "test", mock_room_context, MockClient(), _noop, "agent-1",
            load_balance=True, load_balance_group="pool-1",
        )
        await room.initialize()
        for topic in ("state", "events", "inbox", "approval"):
            opts = mock_room_context.subscribe_options(topic)
            assert opts is not None, topic
            assert opts.load_balance is False, topic

    async def test_work_topics_honor_load_balance(self, mock_room_context):
        room = AgentRoom(
            "test", mock_room_context, MockClient(), _noop, "agent-1",
            load_balance=True, load_balance_group="pool-1",
        )
        await room.initialize()
        for topic in ("tasks", "tools"):
            opts = mock_room_context.subscribe_options(topic)
            assert opts is not None, topic
            assert opts.load_balance is True, topic
            assert opts.load_balance_group == "pool-1", topic

    async def test_sets_presence(self, mock_room_context):
        presence = AgentPresenceData(name="Test", role="agent", capabilities=["cap1"])
        room = AgentRoom("test", mock_room_context, MockClient(), _noop, "agent-1", presence)
        await room.initialize()
        assert mock_room_context._presence == {"name": "Test", "role": "agent", "capabilities": ["cap1"], "protocol": 2}

    def test_emits_task_event(self, agent_room, mock_room_context):
        received = []
        agent_room.on("task", lambda d: received.append(d))
        mock_room_context.simulate_message("tasks", {"type": "task", "capability": "test"})
        assert len(received) == 1
        assert received[0]["capability"] == "test"

    def test_emits_result_event(self, agent_room, mock_room_context):
        received = []
        agent_room.on("result", lambda d: received.append(d))
        mock_room_context.simulate_message("results", {"type": "result", "status": "success"})
        assert len(received) == 1

    def test_emits_state_change_event(self, agent_room, mock_room_context):
        received = []
        agent_room.on("state_change", lambda d: received.append(d))
        mock_room_context.simulate_message("state", {"key": "k", "value": "v"})
        assert len(received) == 1

    def test_multiplexes_approval_topic(self, agent_room, mock_room_context):
        requests = []
        responses = []
        agent_room.on("approval_request", lambda d: requests.append(d))
        agent_room.on("approval_response", lambda d: responses.append(d))

        mock_room_context.simulate_message("approval", {"type": "approval_request", "action": "x"})
        mock_room_context.simulate_message("approval", {"type": "approval_response", "decision": "approved"})

        assert len(requests) == 1
        assert len(responses) == 1

    def test_multiplexes_tools_topic(self, agent_room, mock_room_context):
        requests = []
        responses = []
        agent_room.on("tool_request", lambda d: requests.append(d))
        agent_room.on("tool_response", lambda d: responses.append(d))

        mock_room_context.simulate_message("tools", {"type": "tool_request", "toolName": "calc"})
        mock_room_context.simulate_message("tools", {"type": "tool_response", "status": "success"})

        assert len(requests) == 1
        assert len(responses) == 1

    @pytest.mark.asyncio
    async def test_publish_task(self, agent_room, mock_room_context):
        from nolag_agents.envelope import create_task_envelope
        env = create_task_envelope("cap", {"data": 1})
        await agent_room.publish_task(env)
        assert len(mock_room_context._published) == 1
        topic, data, opts = mock_room_context._published[0]
        assert topic == "tasks"
        assert data["createdBy"] == "test-agent"

    @pytest.mark.asyncio
    async def test_publish_state_retains(self, agent_room, mock_room_context):
        await agent_room.publish_state({"key": "k", "value": "v"})
        assert len(mock_room_context._published) == 1
        topic, data, opts = mock_room_context._published[0]
        assert topic == "state"
        assert opts is not None and opts.retain is True


class TestServiceDiscovery:
    def test_find_agents(self, agent_room):
        agent_room._agents["a1"] = ConnectedAgent(
            actor_id="a1", name="Agent 1", role="agent", capabilities=["summarize", "translate"]
        )
        agent_room._agents["a2"] = ConnectedAgent(
            actor_id="a2", name="Agent 2", role="agent", capabilities=["translate"]
        )

        found = agent_room.find_agents("summarize")
        assert len(found) == 1
        assert found[0].actor_id == "a1"

        found = agent_room.find_agents("translate")
        assert len(found) == 2

    def test_has_capability(self, agent_room):
        assert not agent_room.has_capability("test")
        agent_room._agents["a1"] = ConnectedAgent(
            actor_id="a1", name="A", role="agent", capabilities=["test"]
        )
        assert agent_room.has_capability("test")

    def test_get_available_capabilities(self, agent_room):
        agent_room._agents["a1"] = ConnectedAgent(
            actor_id="a1", name="A", role="agent", capabilities=["a", "b"]
        )
        agent_room._agents["a2"] = ConnectedAgent(
            actor_id="a2", name="B", role="agent", capabilities=["b", "c"]
        )
        caps = set(agent_room.get_available_capabilities())
        assert caps == {"a", "b", "c"}


class TestPresenceEvents:
    def test_presence_join(self, agent_room, mock_client):
        received = []
        agent_room.on("presence_join", lambda aid, data: received.append((aid, data)))
        mock_client.simulate_event("presence:join", {
            "actor_id": "new-agent",
            "data": {"name": "New", "role": "agent", "capabilities": ["x"]},
        })
        assert len(received) == 1
        assert received[0][0] == "new-agent"
        assert "new-agent" in agent_room._agents

    def test_presence_leave(self, agent_room, mock_client):
        agent_room._agents["leaving"] = ConnectedAgent(actor_id="leaving", name="L", role="agent")
        received = []
        agent_room.on("presence_leave", lambda aid: received.append(aid))
        mock_client.simulate_event("presence:leave", {"actor_id": "leaving"})
        assert len(received) == 1
        assert "leaving" not in agent_room._agents
