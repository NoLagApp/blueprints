import pytest

from nolag_agents.client import NoLagAgents
from nolag_agents.types import NoLagAgentsOptions

from .conftest import MockClient


def make_agents(client=None, **opts) -> NoLagAgents:
    """Construct with an injected client, the way applications now do."""
    return NoLagAgents(client or MockClient(), NoLagAgentsOptions(**opts) if opts else None)


class TestInjectionContract:
    def test_requires_an_injected_client(self):
        with pytest.raises(TypeError, match="requires an injected NoLag client"):
            NoLagAgents(None)

    def test_attaches_handlers_at_construction(self):
        client = MockClient(connected=False)
        make_agents(client)

        # Attach happens in the constructor, before any connect.
        for event in ("connect", "disconnect", "reconnect", "error"):
            assert client.handler_count(event) == 1, f"{event} handler not attached"

    def test_sets_app_context_at_construction(self):
        client = MockClient(connected=False)
        make_agents(client, app_name="my-app")
        assert [c.name for c in client.app_contexts] == ["my-app"]

    def test_exposes_the_injected_client(self):
        client = MockClient(connected=False)
        agents = make_agents(client)
        assert agents.client is client


class TestNoLagAgents:
    def test_default_options(self):
        agents = make_agents(MockClient(connected=False))
        assert agents.agent_id != ""
        assert not agents.connected
        assert agents.rooms == {}

    def test_custom_options(self):
        agents = make_agents(
            MockClient(connected=False),
            app_name="my-app",
            agent_id="worker-1",
            debug=True,
            rooms=["room-a", "room-b"],
        )
        assert agents.agent_id == "worker-1"

    def test_connected_tracks_the_injected_client(self):
        client = MockClient(connected=True)
        agents = make_agents(client)
        assert agents.connected

        client.set_connected(False)
        assert not agents.connected

    def test_event_emitter_integration(self):
        agents = make_agents(MockClient(connected=False))
        received = []
        agents.on("connected", lambda: received.append("connected"))
        agents._emit("connected")
        assert received == ["connected"]


class TestDetach:
    @pytest.mark.asyncio
    async def test_detach_removes_only_its_own_handlers(self):
        client = MockClient(connected=False)
        agents = make_agents(client)

        # A sibling handler owned by the application, which must survive.
        sentinel_called = []
        client.on("connect", lambda *a: sentinel_called.append(True))
        assert client.handler_count("connect") == 2

        await agents.detach()

        assert client.handler_count("connect") == 1, "detach removed a foreign handler"
        client.simulate_event("connect")
        assert sentinel_called == [True], "the surviving handler stopped firing"

    @pytest.mark.asyncio
    async def test_detach_never_disconnects_the_client(self):
        client = MockClient(connected=True)
        agents = make_agents(client)

        await agents.detach()

        assert client.disconnect_calls == 0, "the wrapper closed a connection it does not own"
        assert client.connected, "the shared client was left disconnected"

    @pytest.mark.asyncio
    async def test_detach_is_idempotent(self):
        client = MockClient(connected=False)
        agents = make_agents(client)

        detached = []
        agents.on("detached", lambda: detached.append(True))

        await agents.detach()
        await agents.detach()
        await agents.detach()

        assert detached == [True]
        assert agents.detached
        assert not agents.connected

    @pytest.mark.asyncio
    async def test_ready_raises_when_detached_first(self):
        agents = make_agents(MockClient(connected=False))
        await agents.detach()

        with pytest.raises(RuntimeError, match="detached before ready"):
            await agents.ready()


class TestReady:
    @pytest.mark.asyncio
    async def test_ready_joins_configured_rooms(self):
        client = MockClient(connected=True)
        agents = make_agents(client, rooms=["alpha", "beta"], presence=None)

        await agents.ready()

        assert sorted(agents.rooms.keys()) == ["alpha", "beta"]

    @pytest.mark.asyncio
    async def test_ready_is_awaitable_more_than_once(self):
        agents = make_agents(MockClient(connected=True), rooms=["alpha"])

        await agents.ready()
        await agents.ready()

        assert list(agents.rooms.keys()) == ["alpha"]

    @pytest.mark.asyncio
    async def test_setup_runs_on_connect_event(self):
        # Constructed against a client that is not yet up.
        client = MockClient(connected=False)
        agents = make_agents(client, rooms=["alpha"])
        assert agents.rooms == {}

        client.set_connected(True)
        client.simulate_event("connect")
        await agents.ready()

        assert list(agents.rooms.keys()) == ["alpha"]

    @pytest.mark.asyncio
    async def test_reconnect_re_runs_setup(self):
        client = MockClient(connected=True)
        agents = make_agents(client, rooms=["alpha"])
        await agents.ready()

        reconnected = []
        agents.on("reconnected", lambda: reconnected.append(True))

        client.simulate_event("reconnect")
        # Let the scheduled setup task run.
        import asyncio

        await asyncio.sleep(0)
        await asyncio.sleep(0)

        assert reconnected == [True], "reconnect did not re-run setup"
