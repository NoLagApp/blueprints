"""Persistent Presence E2E (python agents consumer): the Handoff gate proceeds-
and-wakes for an offline persistent agent by default, and require_online restores
strict behaviour. Mirrors the kraken full_loop / js-agents tests."""
import pytest

from nolag_agents.patterns.handoff import Handoff
from nolag_agents.types import ConnectedAgent


def _agent(status: str) -> ConnectedAgent:
    return ConnectedAgent(
        actor_id="echo", name="echo", role="agent",
        capabilities=["soil_analysis"], protocol=2, status=status,
    )


class TestPersistentPresenceHandoff:
    @pytest.mark.asyncio
    async def test_proceeds_and_wakes_offline_persistent_agent(self, agent_room, mock_room_context):
        agent_room._agents["echo"] = _agent("offline")
        await Handoff(agent_room).dispatch("soil_analysis", {"sample": 1})
        assert len(mock_room_context._published) == 1
        topic, _data, _ = mock_room_context._published[0]
        assert topic == "tasks"

    @pytest.mark.asyncio
    async def test_require_online_raises_when_only_offline(self, agent_room, mock_room_context):
        agent_room._agents["echo"] = _agent("offline")
        with pytest.raises(RuntimeError, match="online agent"):
            await Handoff(agent_room).dispatch("soil_analysis", {"sample": 1}, require_online=True)
        assert len(mock_room_context._published) == 0

    @pytest.mark.asyncio
    async def test_require_online_proceeds_when_online(self, agent_room, mock_room_context):
        agent_room._agents["echo"] = _agent("online")
        await Handoff(agent_room).dispatch("soil_analysis", {"sample": 1}, require_online=True)
        assert len(mock_room_context._published) == 1
