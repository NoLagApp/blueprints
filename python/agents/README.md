# nolag-agents

> Protocol contract (topics, directed replies, NACKs, version advertisement): [docs/AGENTS-PROTOCOL.md](../../docs/AGENTS-PROTOCOL.md)

Multi-agent coordination SDK for Python, built on the [nolag](https://pypi.org/project/nolag/) real-time SDK.

Six coordination patterns out of the box: **Handoff**, **Blackboard**, **Inbox**, **Tools**, **Approve**, and **Observe**. Plus built-in load balancing for worker pools.

## Install

```bash
pip install nolag-agents
```

Requires Python 3.10+ and `nolag>=2.1.0` (installed automatically).

## Quick Start

### Orchestrator

```python
from nolag_agents import NoLagAgents, NoLagAgentsOptions, AgentPresenceData
from nolag_agents.patterns import Handoff

agents = NoLagAgents(ORCHESTRATOR_TOKEN, NoLagAgentsOptions(
    app_name="my-agents",
    presence=AgentPresenceData(name="orchestrator", role="orchestrator", capabilities=["dispatch"]),
))
await agents.connect()

room = await agents.room("default-workflow")
handoff = Handoff(room)

result = await handoff.dispatch("summarize",
    {"url": "https://example.com/article"},
    wait_for_result=True, timeout=30000,
)
print("Result:", result.payload)
```

### Worker

```python
from nolag_agents import NoLagAgents, NoLagAgentsOptions, AgentPresenceData
from nolag_agents.patterns import Handoff

agents = NoLagAgents(WORKER_TOKEN, NoLagAgentsOptions(
    app_name="my-agents",
    presence=AgentPresenceData(name="summarizer", role="worker", capabilities=["summarize"]),
))
await agents.connect()

room = await agents.room("default-workflow")
handoff = Handoff(room)

def handle_task(task, respond):
    summary = do_summarize(task.payload["url"])
    await respond("success", {"summary": summary})

handoff.on_task(["summarize"], handle_task)
```

## Patterns

### Handoff

Dispatch tasks to agents by capability. Workers register capabilities via presence, and the orchestrator routes work to capable agents.

```python
from nolag_agents.patterns import Handoff

handoff = Handoff(room)

# Dispatch (orchestrator)
result = await handoff.dispatch("translate", {"text": "hello"}, wait_for_result=True)

# Receive (worker)
handoff.on_task(["translate"], handler)

# Find agents with a capability
agents = handoff.get_capable_agents("translate")
```

### Blackboard

Shared key-value state visible to all agents in a room. Uses retained messages so state is available immediately on join.

```python
from nolag_agents.patterns import Blackboard

blackboard = Blackboard(room, agents.agent_id)

await blackboard.set("status", "processing")
value = blackboard.get("status")  # "processing"

# Watch for changes
blackboard.on_change("status", lambda envelope: print(envelope.value))

# Get all state
all_state = blackboard.get_all()
```

### Inbox

Per-agent direct messaging. Messages are filtered by recipient agent ID.

```python
from nolag_agents.patterns import Inbox

inbox = Inbox(room, agents.agent_id)

# Send a direct message
await inbox.send("other-agent-id", {"action": "ping"})

# Receive messages (via room event listener)
room.on("inbox", lambda msg: print(msg))
```

### Tools

Remote tool invocation over pub/sub with correlated request/response.

```python
from nolag_agents.patterns import Tools

tools = Tools(room, agents.agent_id)

# Register a tool handler
tools.register("lookup", lambda args: {"result": db.find(args["id"])})

# Call a remote tool
response = await tools.call("lookup", {"id": "abc123"}, timeout=5000)
print(response.result)
```

### Approve

Human-in-the-loop approval gates. Agents request approval before taking actions.

```python
from nolag_agents.patterns import Approve

approve = Approve(room, agents.agent_id)

# Request approval (agent side)
response = await approve.request(
    action="delete_record",
    context={"record_id": "123"},
    timeout=60000,
)
if response.decision == "approved":
    delete_record("123")

# Respond to requests (human/dashboard side)
approve.on_request(lambda req: approve.respond(req.request_id, "approved"))
```

### Observe

Structured observability events. Agents emit events, dashboards and monitors subscribe.

```python
from nolag_agents.patterns import Observe

observe = Observe(room, agents.agent_id)

# Emit an event
await observe.emit("task_started", {"task_id": "abc"}, severity="info")

# Listen for events
observe.on("task_started", lambda event: print(event.payload))
```

## Load Balancing

Distribute tasks across a pool of workers. When enabled, NoLag routes each message to only one subscriber in the group.

```python
agents = NoLagAgents(WORKER_TOKEN, NoLagAgentsOptions(
    app_name="my-agents",
    presence=AgentPresenceData(name="worker-1", role="worker", capabilities=["process"]),
    load_balance=True,
    load_balance_group="workers",
))
```

## Lobby Presence

Observe agent presence across multiple rooms at once. Useful for dashboards and orchestrator discovery.

```python
agents = NoLagAgents(TOKEN, NoLagAgentsOptions(
    app_name="my-agents",
    lobby="agent-dashboard",
    presence=AgentPresenceData(name="monitor", role="observer"),
))
await agents.connect()

room = await agents.room("default-workflow")
connected = room.get_connected_agents()
capabilities = room.get_available_capabilities()
```

## Configuration

`NoLagAgentsOptions` fields:

| Field | Type | Default | Description |
|---|---|---|---|
| `app_name` | `str` | `"agents"` | NoLag app slug |
| `agent_id` | `str` | auto-generated | Unique agent identifier |
| `debug` | `bool` | `False` | Enable debug logging |
| `rooms` | `list[str]` | `["default-workflow"]` | Rooms to join on connect |
| `lobby` | `str` | `None` | Lobby slug for cross-room presence |
| `presence` | `AgentPresenceData` | `None` | Agent presence metadata |
| `client_options` | `dict` | `None` | Passed to the underlying `nolag` client |
| `load_balance` | `bool` | `False` | Enable load balancing |
| `load_balance_group` | `str` | `None` | Load balance group name |
| `load_balance_topics` | `list[str]` | `None` | Topics to load balance |

## Testing

```bash
# Unit tests
pytest tests/

# Integration tests (requires NOLAG_ACCESS_TOKEN)
NOLAG_ACCESS_TOKEN=<token> pytest integration_test.py -v
```

## License

MIT
