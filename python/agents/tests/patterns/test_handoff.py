import pytest
from nolag_agents.patterns.handoff import Handoff
from nolag_agents.types import ConnectedAgent


class TestHandoff:
    def test_dispatch_raises_without_capable_agents(self, agent_room):
        handoff = Handoff(agent_room)
        with pytest.raises(RuntimeError, match='No agent with capability "summarize"'):
            import asyncio
            asyncio.get_event_loop().run_until_complete(
                handoff.dispatch("summarize", {"text": "hi"})
            )

    @pytest.mark.asyncio
    async def test_dispatch_with_allow_no_workers(self, agent_room, mock_room_context):
        handoff = Handoff(agent_room)
        await handoff.dispatch("summarize", {"text": "hi"}, allow_no_workers=True)
        assert len(mock_room_context._published) == 1
        topic, data, _ = mock_room_context._published[0]
        assert topic == "tasks"
        assert data["capability"] == "summarize"

    @pytest.mark.asyncio
    async def test_dispatch_with_capable_agent(self, agent_room, mock_room_context):
        agent_room._agents["worker"] = ConnectedAgent(
            actor_id="worker", name="W", role="agent", capabilities=["summarize"]
        )
        handoff = Handoff(agent_room)
        await handoff.dispatch("summarize", {"text": "hi"})
        assert len(mock_room_context._published) == 1

    @pytest.mark.asyncio
    async def test_dispatch_wait_for_result(self, agent_room, mock_room_context):
        agent_room._agents["worker"] = ConnectedAgent(
            actor_id="worker", name="W", role="agent", capabilities=["summarize"]
        )
        handoff = Handoff(agent_room)

        import asyncio
        async def dispatch_and_resolve():
            task = asyncio.ensure_future(
                handoff.dispatch("summarize", {}, wait_for_result=True, timeout=5000, allow_no_workers=True)
            )
            await asyncio.sleep(0.01)
            # Get the published task to find correlation ID
            _, published_data, _ = mock_room_context._published[0]
            # Simulate a result coming back
            mock_room_context.simulate_message("results", {
                "type": "result",
                "correlationId": published_data["correlationId"],
                "taskId": published_data["taskId"],
                "status": "success",
                "payload": {"summary": "done"},
                "completedAt": 123,
            })
            return await task

        result = await dispatch_and_resolve()
        assert result is not None
        assert result.status == "success"
        assert result.payload == {"summary": "done"}

    def test_on_task_filters_by_capability(self, agent_room, mock_room_context):
        handoff = Handoff(agent_room)
        received = []
        handoff.on_task(["summarize"], lambda task, respond: received.append(task))

        mock_room_context.simulate_message("tasks", {
            "type": "task",
            "taskId": "t1",
            "correlationId": "c1",
            "capability": "summarize",
            "payload": {},
            "priority": "medium",
            "createdAt": 123,
        })
        mock_room_context.simulate_message("tasks", {
            "type": "task",
            "taskId": "t2",
            "correlationId": "c2",
            "capability": "translate",
            "payload": {},
            "priority": "medium",
            "createdAt": 124,
        })
        assert len(received) == 1
        assert received[0].capability == "summarize"

    def test_on_task_wildcard(self, agent_room, mock_room_context):
        handoff = Handoff(agent_room)
        received = []
        handoff.on_task("*", lambda task, respond: received.append(task))

        mock_room_context.simulate_message("tasks", {
            "type": "task", "taskId": "t1", "correlationId": "c1",
            "capability": "summarize", "payload": {}, "priority": "medium", "createdAt": 1,
        })
        mock_room_context.simulate_message("tasks", {
            "type": "task", "taskId": "t2", "correlationId": "c2",
            "capability": "translate", "payload": {}, "priority": "medium", "createdAt": 2,
        })
        assert len(received) == 2

    def test_get_capable_agents(self, agent_room):
        handoff = Handoff(agent_room)
        agent_room._agents["w1"] = ConnectedAgent(
            actor_id="w1", name="W1", role="agent", capabilities=["cap1"]
        )
        result = handoff.get_capable_agents("cap1")
        assert len(result) == 1

    def test_dispose(self, agent_room):
        handoff = Handoff(agent_room)
        handoff.dispose()
