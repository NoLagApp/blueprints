DEFAULT_APP_NAME = "agents"

TOPIC_TASKS = "tasks"
TOPIC_RESULTS = "results"
TOPIC_STATE = "state"
TOPIC_EVENTS = "events"
TOPIC_INBOX = "inbox"
TOPIC_TOOLS = "tools"
TOPIC_APPROVAL = "approval"

DEFAULT_ROOM = "default-workflow"
LOBBY_AGENT_ACTIVITY = "agent-activity"

# Agents-protocol version: 2 = directed replies (filter-routed results),
# NO_HANDLER NACKs, presence protocol advertisement. Absent/1 = legacy
# broadcast replies (pre-directed-replies SDKs).
AGENTS_PROTOCOL_VERSION = 2
