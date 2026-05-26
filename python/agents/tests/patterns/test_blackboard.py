import pytest
from nolag_agents.patterns.blackboard import Blackboard


class TestBlackboard:
    @pytest.mark.asyncio
    async def test_set_and_get(self, agent_room, mock_room_context):
        bb = Blackboard(agent_room, "agent-1")
        await bb.set("key1", "value1")
        assert bb.get("key1") == "value1"
        assert len(mock_room_context._published) == 1
        topic, data, opts = mock_room_context._published[0]
        assert topic == "state"
        assert opts == {"retain": True}

    @pytest.mark.asyncio
    async def test_version_increments(self, agent_room, mock_room_context):
        bb = Blackboard(agent_room, "agent-1")
        await bb.set("key1", "v1")
        await bb.set("key1", "v2")
        env = bb.get_envelope("key1")
        assert env is not None
        assert env.version == 2

    def test_get_returns_none_for_missing(self, agent_room):
        bb = Blackboard(agent_room, "agent-1")
        assert bb.get("missing") is None

    def test_get_envelope(self, agent_room, mock_room_context):
        bb = Blackboard(agent_room, "agent-1")
        mock_room_context.simulate_message("state", {
            "key": "k1", "value": 42, "version": 1,
            "updatedBy": "other", "updatedAt": 100,
        })
        env = bb.get_envelope("k1")
        assert env is not None
        assert env.value == 42
        assert env.updated_by == "other"

    def test_get_all(self, agent_room, mock_room_context):
        bb = Blackboard(agent_room, "agent-1")
        mock_room_context.simulate_message("state", {"key": "a", "value": 1, "version": 1, "updatedBy": "x", "updatedAt": 1})
        mock_room_context.simulate_message("state", {"key": "b", "value": 2, "version": 1, "updatedBy": "x", "updatedAt": 1})
        all_state = bb.get_all()
        assert len(all_state) == 2
        assert "a" in all_state
        assert "b" in all_state

    def test_on_change(self, agent_room, mock_room_context):
        bb = Blackboard(agent_room, "agent-1")
        received = []
        bb.on_change("watched", lambda env: received.append(env))

        mock_room_context.simulate_message("state", {"key": "watched", "value": "new", "version": 1, "updatedBy": "x", "updatedAt": 1})
        mock_room_context.simulate_message("state", {"key": "other", "value": "x", "version": 1, "updatedBy": "x", "updatedAt": 1})

        assert len(received) == 1
        assert received[0].key == "watched"
