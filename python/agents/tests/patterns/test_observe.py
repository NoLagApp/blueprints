import pytest
from nolag_agents.patterns.observe import Observe


class TestObserve:
    @pytest.mark.asyncio
    async def test_emit(self, agent_room, mock_room_context):
        observe = Observe(agent_room, "agent-1")
        await observe.emit("task.completed", {"taskId": "t1"})
        assert len(mock_room_context._published) == 1
        topic, data, _ = mock_room_context._published[0]
        assert topic == "events"
        assert data["category"] == "task.completed"
        assert data["severity"] == "info"
        assert data["emittedBy"] == "agent-1"

    @pytest.mark.asyncio
    async def test_emit_with_severity(self, agent_room, mock_room_context):
        observe = Observe(agent_room, "agent-1")
        await observe.emit("error", {"msg": "fail"}, severity="error")
        _, data, _ = mock_room_context._published[0]
        assert data["severity"] == "error"

    def test_on_receives_events(self, agent_room, mock_room_context):
        observe = Observe(agent_room, "agent-1")
        received = []
        observe.on(lambda env: received.append(env))

        mock_room_context.simulate_message("events", {
            "type": "event", "eventId": "e1", "severity": "info",
            "category": "test", "payload": {}, "timestamp": 1,
            "emittedBy": "other",
        })
        assert len(received) == 1
        assert received[0].category == "test"

    def test_on_filters_by_category(self, agent_room, mock_room_context):
        observe = Observe(agent_room, "agent-1")
        received = []
        observe.on(lambda env: received.append(env), category="important")

        mock_room_context.simulate_message("events", {
            "type": "event", "eventId": "e1", "severity": "info",
            "category": "important", "payload": {}, "timestamp": 1,
            "emittedBy": "a",
        })
        mock_room_context.simulate_message("events", {
            "type": "event", "eventId": "e2", "severity": "info",
            "category": "other", "payload": {}, "timestamp": 2,
            "emittedBy": "a",
        })
        assert len(received) == 1

    def test_on_filters_by_severity(self, agent_room, mock_room_context):
        observe = Observe(agent_room, "agent-1")
        received = []
        observe.on(lambda env: received.append(env), severity="error")

        mock_room_context.simulate_message("events", {
            "type": "event", "eventId": "e1", "severity": "error",
            "category": "x", "payload": {}, "timestamp": 1, "emittedBy": "a",
        })
        mock_room_context.simulate_message("events", {
            "type": "event", "eventId": "e2", "severity": "info",
            "category": "x", "payload": {}, "timestamp": 2, "emittedBy": "a",
        })
        assert len(received) == 1
