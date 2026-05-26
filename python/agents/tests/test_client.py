import pytest
from unittest.mock import AsyncMock, MagicMock, patch
from nolag_agents.client import NoLagAgents
from nolag_agents.types import NoLagAgentsOptions, AgentPresenceData


class TestNoLagAgents:
    def test_default_options(self):
        agents = NoLagAgents("token123")
        assert agents.agent_id != ""
        assert not agents.connected
        assert agents.rooms == {}

    def test_custom_options(self):
        opts = NoLagAgentsOptions(
            app_name="my-app",
            agent_id="worker-1",
            debug=True,
            rooms=["room-a", "room-b"],
        )
        agents = NoLagAgents("token123", opts)
        assert agents.agent_id == "worker-1"

    def test_disconnect_clears_state(self):
        agents = NoLagAgents("token123")
        agents._connected = True
        agents._client = MagicMock()
        agents._app_context = MagicMock()
        agents.disconnect()
        assert not agents.connected
        assert agents._client is None
        assert agents._app_context is None

    def test_room_raises_when_not_connected(self):
        agents = NoLagAgents("token123")
        with pytest.raises(RuntimeError, match="Not connected"):
            import asyncio
            asyncio.get_event_loop().run_until_complete(agents.room("test"))

    def test_event_emitter_integration(self):
        agents = NoLagAgents("token123")
        received = []
        agents.on("connected", lambda: received.append("connected"))
        agents._emit("connected")
        assert received == ["connected"]
