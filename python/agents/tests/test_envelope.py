from nolag_agents.envelope import (
    create_task_envelope,
    create_result_envelope,
    create_state_envelope,
    create_event_envelope,
    create_approval_request,
    create_approval_response,
    create_tool_request,
    create_tool_response,
)


class TestCreateTaskEnvelope:
    def test_defaults(self):
        env = create_task_envelope("summarize", {"text": "hello"})
        assert env.type == "task"
        assert env.capability == "summarize"
        assert env.payload == {"text": "hello"}
        assert env.priority == "medium"
        assert env.task_id != ""
        assert env.correlation_id != ""
        assert env.created_at > 0

    def test_with_options(self):
        env = create_task_envelope(
            "translate",
            {"text": "hi"},
            tags=["urgent"],
            priority="high",
            timeout=5000,
            created_by="agent-1",
            metadata={"lang": "en"},
        )
        assert env.priority == "high"
        assert env.tags == ["urgent"]
        assert env.timeout == 5000
        assert env.created_by == "agent-1"
        assert env.metadata == {"lang": "en"}

    def test_to_dict_camel_case(self):
        env = create_task_envelope("test", {}, created_by="a")
        d = env.to_dict()
        assert "taskId" in d
        assert "correlationId" in d
        assert "createdAt" in d
        assert "createdBy" in d


class TestCreateResultEnvelope:
    def test_creates_result(self):
        env = create_result_envelope("t1", "c1", "success", {"result": 42})
        assert env.type == "result"
        assert env.task_id == "t1"
        assert env.correlation_id == "c1"
        assert env.status == "success"
        assert env.payload == {"result": 42}
        assert env.completed_at > 0


class TestCreateStateEnvelope:
    def test_creates_state(self):
        env = create_state_envelope("key1", "value1", 1, "agent-1")
        assert env.type == "state"
        assert env.key == "key1"
        assert env.value == "value1"
        assert env.version == 1
        assert env.updated_by == "agent-1"


class TestCreateEventEnvelope:
    def test_creates_event(self):
        env = create_event_envelope("task.completed", "agent-1", {"taskId": "t1"})
        assert env.type == "event"
        assert env.category == "task.completed"
        assert env.severity == "info"
        assert env.emitted_by == "agent-1"

    def test_custom_severity(self):
        env = create_event_envelope("error", "a", {}, severity="error")
        assert env.severity == "error"


class TestCreateApprovalRequest:
    def test_creates_request(self):
        env = create_approval_request("delete_file", {"path": "/tmp"}, "agent-1")
        assert env.type == "approval_request"
        assert env.action == "delete_file"
        assert env.requested_by == "agent-1"
        assert env.urgency == "medium"

    def test_custom_urgency(self):
        env = create_approval_request("x", {}, "a", urgency="critical")
        assert env.urgency == "critical"


class TestCreateApprovalResponse:
    def test_creates_response(self):
        env = create_approval_response("r1", "c1", "approved", "human-1", "looks good")
        assert env.type == "approval_response"
        assert env.decision == "approved"
        assert env.reason == "looks good"
        assert env.responded_by == "human-1"


class TestCreateToolRequest:
    def test_creates_request(self):
        env = create_tool_request("calculator", {"a": 1, "b": 2}, "agent-1")
        assert env.type == "tool_request"
        assert env.tool_name == "calculator"
        assert env.arguments == {"a": 1, "b": 2}
        assert env.requested_by == "agent-1"


class TestCreateToolResponse:
    def test_creates_response(self):
        env = create_tool_response("r1", "c1", "success", 42)
        assert env.type == "tool_response"
        assert env.status == "success"
        assert env.result == 42
