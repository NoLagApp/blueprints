/** Default app name for agent coordination */
export const DEFAULT_APP_NAME = "agents";

/** Topic name for task dispatch (Handoff pattern) */
export const TOPIC_TASKS = "tasks";

/** Topic name for task results */
export const TOPIC_RESULTS = "results";

/** Topic name for shared state (Blackboard pattern) */
export const TOPIC_STATE = "state";

/** Topic name for observability events (Observe pattern) */
export const TOPIC_EVENTS = "events";

/** Topic name for per-agent inboxes (Inbox pattern) */
export const TOPIC_INBOX = "inbox";

/** Topic name for tool invocations (Tools pattern) */
export const TOPIC_TOOLS = "tools";

/** Topic name for human-in-the-loop approval (Approve pattern) */
export const TOPIC_APPROVAL = "approval";

/** Default room for agent coordination */
export const DEFAULT_ROOM = "default-workflow";

/** Lobby for agent activity observation */
export const LOBBY_AGENT_ACTIVITY = "agent-activity";
