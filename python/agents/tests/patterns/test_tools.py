import asyncio
import pytest
from nolag_agents.patterns.tools import Tools


class TestTools:
    def test_register(self, agent_room):
        tools = Tools(agent_room, "agent-1")
        tools.register("calculator", lambda args: args["a"] + args["b"])
        assert "calculator" in tools._handlers

    @pytest.mark.asyncio
    async def test_invoke_and_receive_response(self, agent_room, mock_room_context):
        tools = Tools(agent_room, "agent-1")

        async def invoke_and_respond():
            task = asyncio.ensure_future(
                tools.invoke("calc", {"a": 1, "b": 2}, timeout=5000)
            )
            await asyncio.sleep(0.01)
            _, published_data, _ = mock_room_context._published[0]
            mock_room_context.simulate_message("tools", {
                "type": "tool_response",
                "requestId": published_data["requestId"],
                "correlationId": published_data["correlationId"],
                "status": "success",
                "result": 3,
                "respondedAt": 123,
            })
            return await task

        result = await invoke_and_respond()
        assert result.status == "success"
        assert result.result == 3

    @pytest.mark.asyncio
    async def test_handle_request_sync_handler(self, agent_room, mock_room_context):
        tools = Tools(agent_room, "agent-1")
        tools.register("add", lambda args: args["a"] + args["b"])

        mock_room_context.simulate_message("tools", {
            "type": "tool_request",
            "requestId": "r1",
            "correlationId": "c1",
            "toolName": "add",
            "arguments": {"a": 1, "b": 2},
            "requestedBy": "other",
            "requestedAt": 100,
        })

        await asyncio.sleep(0.05)
        assert len(mock_room_context._published) >= 1
        _, response_data, _ = mock_room_context._published[-1]
        assert response_data["status"] == "success"
        assert response_data["result"] == 3

    @pytest.mark.asyncio
    async def test_handle_request_async_handler(self, agent_room, mock_room_context):
        async def async_add(args):
            await asyncio.sleep(0.01)
            return args["a"] + args["b"]

        tools = Tools(agent_room, "agent-1")
        tools.register("add", async_add)

        mock_room_context.simulate_message("tools", {
            "type": "tool_request",
            "requestId": "r1",
            "correlationId": "c1",
            "toolName": "add",
            "arguments": {"a": 10, "b": 20},
            "requestedBy": "other",
            "requestedAt": 100,
        })

        await asyncio.sleep(0.1)
        assert len(mock_room_context._published) >= 1
        _, response_data, _ = mock_room_context._published[-1]
        assert response_data["status"] == "success"
        assert response_data["result"] == 30

    @pytest.mark.asyncio
    async def test_handle_request_error(self, agent_room, mock_room_context):
        def bad_handler(args):
            raise ValueError("bad input")

        tools = Tools(agent_room, "agent-1")
        tools.register("bad", bad_handler)

        mock_room_context.simulate_message("tools", {
            "type": "tool_request",
            "requestId": "r1",
            "correlationId": "c1",
            "toolName": "bad",
            "arguments": {},
            "requestedBy": "other",
            "requestedAt": 100,
        })

        await asyncio.sleep(0.05)
        _, response_data, _ = mock_room_context._published[-1]
        assert response_data["status"] == "error"
        assert "bad input" in response_data["error"]["message"]

    def test_dispose(self, agent_room):
        tools = Tools(agent_room, "agent-1")
        tools.register("x", lambda args: None)
        tools.dispose()
        assert len(tools._handlers) == 0


class TestDirectedReplies:
    """Regression tests for filter-directed replies (v0.3.0).

    Replies must be routed straight to the requester via the results topic
    with filter=reply_to — never load-balanced across the requester's group.
    """

    @pytest.mark.asyncio
    async def test_invoke_sets_reply_to_room_agent_id(self, agent_room, mock_room_context):
        tools = Tools(agent_room, "logical-agent")
        task = asyncio.ensure_future(tools.invoke("calc", {"a": 1}, timeout=1000))
        await asyncio.sleep(0.01)
        topic, request_data, _ = mock_room_context._published[0]
        assert topic == "tools"
        # Delivery address is the ROOM's agentId (the subscribed filter),
        # not the logical agent attribution
        assert request_data["replyTo"] == "test-agent"
        task.cancel()

    @pytest.mark.asyncio
    async def test_response_is_directed_to_requester_on_results_topic(
        self, agent_room, mock_room_context,
    ):
        tools = Tools(agent_room, "agent-1")
        tools.register("add", lambda args: args["a"] + args["b"])

        mock_room_context.simulate_message("tools", {
            "type": "tool_request",
            "requestId": "r1",
            "correlationId": "c1",
            "replyTo": "requester-7",
            "toolName": "add",
            "arguments": {"a": 1, "b": 2},
            "requestedBy": "requester-7",
            "requestedAt": 100,
        })
        await asyncio.sleep(0.05)

        topic, response_data, opts = mock_room_context._published[-1]
        assert topic == "results"
        assert response_data["type"] == "tool_response"
        assert response_data["replyTo"] == "requester-7"
        assert opts is not None and opts.filter == "requester-7"

    @pytest.mark.asyncio
    async def test_response_falls_back_to_requested_by_without_reply_to(
        self, agent_room, mock_room_context,
    ):
        tools = Tools(agent_room, "agent-1")
        tools.register("add", lambda args: 1)

        mock_room_context.simulate_message("tools", {
            "type": "tool_request",
            "requestId": "r1",
            "correlationId": "c1",
            "toolName": "add",
            "arguments": {},
            "requestedBy": "legacy-requester",
            "requestedAt": 100,
        })
        await asyncio.sleep(0.05)

        topic, response_data, opts = mock_room_context._published[-1]
        assert topic == "results"
        assert response_data["replyTo"] == "legacy-requester"
        assert opts is not None and opts.filter == "legacy-requester"

    @pytest.mark.asyncio
    async def test_response_arriving_on_results_topic_resolves_correlation(
        self, agent_room, mock_room_context,
    ):
        tools = Tools(agent_room, "agent-1")
        task = asyncio.ensure_future(tools.invoke("calc", {}, timeout=5000))
        await asyncio.sleep(0.01)
        _, request_data, _ = mock_room_context._published[0]
        # Directed reply arrives on the RESULTS topic (filter sub-topic)
        mock_room_context.simulate_message("results", {
            "type": "tool_response",
            "requestId": request_data["requestId"],
            "correlationId": request_data["correlationId"],
            "status": "success",
            "result": 42,
            "replyTo": "test-agent",
            "respondedAt": 123,
        })
        result = await task
        assert result.result == 42


class TestNackAndProtocolGate:
    """Regression tests for NO_HANDLER NACKs and protocol gating (v0.4.0)."""

    @pytest.mark.asyncio
    async def test_tool_server_nacks_missing_tool(self, agent_room, mock_room_context):
        server = Tools(agent_room, "server-1")
        server.register("known", lambda args: 1)

        mock_room_context.simulate_message("tools", {
            "type": "tool_request",
            "requestId": "r9",
            "correlationId": "c9",
            "replyTo": "requester-9",
            "toolName": "missing",
            "arguments": {},
            "requestedBy": "requester-9",
            "requestedAt": 1,
        })
        await asyncio.sleep(0.05)

        topic, nack, opts = mock_room_context._published[-1]
        assert topic == "results"  # directed reply path
        assert nack["status"] == "error"
        assert nack["error"]["code"] == "NO_HANDLER"
        assert "missing" in nack["error"]["message"]
        assert opts is not None and opts.filter == "requester-9"

    @pytest.mark.asyncio
    async def test_pure_requester_stays_silent(self, agent_room, mock_room_context):
        Tools(agent_room, "requester-only")
        mock_room_context.simulate_message("tools", {
            "type": "tool_request",
            "requestId": "r9",
            "correlationId": "c9",
            "toolName": "anything",
            "arguments": {},
            "requestedBy": "other",
            "requestedAt": 1,
        })
        await asyncio.sleep(0.05)
        assert mock_room_context._published == []

    @pytest.mark.asyncio
    async def test_invoke_fails_fast_when_all_servers_old(self, agent_room):
        from nolag_agents.types import ConnectedAgent
        from nolag_agents.errors import IncompatibleProtocolError
        agent_room._agents["old-server"] = ConnectedAgent(
            actor_id="old-server", name="old", role="tool-server",
            capabilities=[], protocol=1,
        )
        tools = Tools(agent_room, "requester")
        with pytest.raises(IncompatibleProtocolError):
            await tools.invoke("calc", {}, timeout=50)

    @pytest.mark.asyncio
    async def test_allow_legacy_responders_bypasses_gate(self, agent_room):
        from nolag_agents.types import ConnectedAgent
        agent_room._agents["old-server"] = ConnectedAgent(
            actor_id="old-server", name="old", role="tool-server",
            capabilities=[], protocol=1,
        )
        tools = Tools(agent_room, "requester")
        with pytest.raises(TimeoutError, match="timed out"):
            await tools.invoke("calc", {}, timeout=30, allow_legacy_responders=True)

    @pytest.mark.asyncio
    async def test_timeout_message_names_tool_room_and_causes(self, agent_room):
        tools = Tools(agent_room, "requester")
        with pytest.raises(TimeoutError) as exc:
            await tools.invoke("calc", {}, timeout=30)
        msg = str(exc.value)
        assert "Tool 'calc' invocation" in msg
        assert "test-room" in msg
        assert "Likely causes" in msg
