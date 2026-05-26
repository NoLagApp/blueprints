import asyncio
import pytest
from nolag_agents.patterns.approve import Approve


class TestApprove:
    @pytest.mark.asyncio
    async def test_request_and_receive_response(self, agent_room, mock_room_context):
        approve = Approve(agent_room, "agent-1")

        async def request_and_respond():
            task = asyncio.ensure_future(
                approve.request("delete_file", {"path": "/tmp/x"}, timeout=5000)
            )
            await asyncio.sleep(0.01)
            _, published_data, _ = mock_room_context._published[0]
            mock_room_context.simulate_message("approval", {
                "type": "approval_response",
                "requestId": published_data["requestId"],
                "correlationId": published_data["correlationId"],
                "decision": "approved",
                "reason": "looks good",
                "respondedBy": "human-1",
                "respondedAt": 123,
            })
            return await task

        result = await request_and_respond()
        assert result.decision == "approved"
        assert result.reason == "looks good"
        assert result.responded_by == "human-1"

    def test_on_request(self, agent_room, mock_room_context):
        approve = Approve(agent_room, "agent-1")
        received = []

        def handler(request, respond):
            received.append(request)

        approve.on_request(handler)

        mock_room_context.simulate_message("approval", {
            "type": "approval_request",
            "requestId": "r1",
            "correlationId": "c1",
            "action": "deploy",
            "context": {"env": "prod"},
            "urgency": "high",
            "requestedBy": "bot-1",
            "requestedAt": 100,
        })

        assert len(received) == 1
        assert received[0].action == "deploy"
        assert received[0].urgency == "high"

    @pytest.mark.asyncio
    async def test_request_publishes_to_approval_topic(self, agent_room, mock_room_context):
        approve = Approve(agent_room, "agent-1")
        # Fire and forget (will timeout, but we just check publishing)
        task = asyncio.ensure_future(
            approve.request("action", {"data": 1}, timeout=100)
        )
        await asyncio.sleep(0.01)

        assert len(mock_room_context._published) == 1
        topic, data, opts = mock_room_context._published[0]
        assert topic == "approval"
        assert data["action"] == "action"
        assert opts == {"retain": True}

        # Clean up
        approve.dispose()
        task.cancel()
        try:
            await task
        except (asyncio.CancelledError, Exception):
            pass

    def test_dispose(self, agent_room):
        approve = Approve(agent_room, "agent-1")
        approve.dispose()
