import pytest
from nolag_agents.patterns.inbox import Inbox


class TestInbox:
    @pytest.mark.asyncio
    async def test_send(self, agent_room, mock_room_context):
        inbox = Inbox(agent_room, "agent-1")
        await inbox.send("agent-2", {"text": "hello"})
        assert len(mock_room_context._published) == 1
        topic, data, _ = mock_room_context._published[0]
        assert topic == "inbox"
        assert data["to"] == "agent-2"
        assert data["from"] == "agent-1"
        assert data["payload"] == {"text": "hello"}

    def test_on_message_filters_by_recipient(self, agent_room, mock_room_context):
        inbox = Inbox(agent_room, "agent-1")
        received = []
        inbox.on_message(lambda msg: received.append(msg))

        # Message addressed to agent-1 - should be received
        mock_room_context.simulate_message("inbox", {
            "messageId": "m1", "from": "agent-2", "to": "agent-1",
            "payload": {"text": "hi"}, "createdAt": 1,
        })
        # Message addressed to agent-2 - should be ignored
        mock_room_context.simulate_message("inbox", {
            "messageId": "m2", "from": "agent-1", "to": "agent-2",
            "payload": {"text": "bye"}, "createdAt": 2,
        })

        assert len(received) == 1
        assert received[0].from_agent == "agent-2"
        assert received[0].payload == {"text": "hi"}
