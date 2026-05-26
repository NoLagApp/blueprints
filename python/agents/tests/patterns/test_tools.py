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
