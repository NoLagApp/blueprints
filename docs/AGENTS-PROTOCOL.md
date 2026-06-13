# NoLag Agents Protocol

The contract shared by every agents SDK (`@nolag/agents` ≥ 0.3.0,
`nolag-agents` ≥ 0.4.0, and any future language binding). It is built on the
broker primitives in `kraken/docs/PROTOCOL.md` (topics, filters,
load-balanced shared subscriptions) and MUST be implemented identically in
every language — the cross-SDK e2e (`blueprints/e2e/cross-sdk`) is the
conformance test.

**Agents-protocol version: 2.** Version 1 (pre-0.2.0 JS / pre-0.3.0 Python)
broadcast replies; v2 directs them. The two cannot exchange replies — see
"Version advertisement".

## Room topics and their delivery semantics

Every `AgentRoom` subscribes seven topics. The semantics are NOT uniform —
getting them wrong reintroduces the reply-misrouting bug this protocol fixed:

| Topic | Carries | Subscription |
|---|---|---|
| `tasks` | Handoff task envelopes | connection-default (load-balance for worker pools: one task → one worker) |
| `tools` | tool **requests** only | connection-default (load-balance for tool-server replicas: one request → one replica per group) |
| `results` | task results AND tool responses, **directed** | `filters: [own agentId]`, never load-balanced |
| `state` | blackboard state (retained) | broadcast (`loadBalance: false`) |
| `events` | observe events | broadcast |
| `inbox` | direct messages (addressee filtered client-side) | broadcast |
| `approval` | approval requests + responses (retained requests) | broadcast |

## Directed replies

Replies are routed point-to-point with broker filters, never broadcast and
never load-balanced:

- Every request envelope carries `replyTo` = the **room's agentId** (the
  filter sub-topic its `results` subscription listens on). Note: a `Tools`
  instance may be constructed with a different logical agent id for
  attribution — delivery must always use the room's id.
- Responders publish task results and tool responses on the **results**
  topic with `filter: <replyTo>` (falling back to `requestedBy`/`createdBy`
  when `replyTo` is absent — legacy senders).
- The results topic is multiplexed by `type`: `tool_response` →
  toolResponse handling, everything else → task result handling.
- For backward compatibility, receivers still accept `tool_response`
  envelopes arriving on the `tools` topic (pre-v2 responders broadcast
  there); those replies are only reliable when the requester is not
  load-balanced.

## Envelopes

All envelopes carry `protocol: 2` (absent = 1). Shared fields per type are
defined by the reference implementations (`js/agents/src/types.ts`,
`python/agents/nolag_agents/types.py`); the wire shape is camelCase
(`replyTo`, `requestedBy`, `correlationId`...). Key reply-addressing fields:

- `task`: `replyTo` (dispatcher's room agentId), `createdBy`
- `result`: `replyTo` (copied from the task), `completedBy`
- `tool_request`: `replyTo` (requester's room agentId), `requestedBy`
- `tool_response`: `replyTo` (copied from the request), `respondedBy`,
  `error: { code, message }` on `status: "error"`

## NO_HANDLER NACKs

Tool requests are load-balanced to **every group in the room** (one member
each), so an agent regularly receives requests meant for a different tool
server. The NACK rules:

1. **Pure requesters** (zero registered handlers) never answer.
2. **Tool servers answer only within their own namespace** — the prefix
   before the first `.` (`backend.*`, `chemistry.*`). A `backend.*` server
   receiving `chemistry.analyze` stays silent; if it NACKed, the NACK would
   race and beat the real chemistry server's response.
3. Within its own namespace, a server missing the specific handler responds
   immediately with `status: "error"`, `error.code: "NO_HANDLER"` — the
   requester fails in one round-trip instead of burning its timeout.

Consequences for deployment: members of one `loadBalanceGroup` must host
identical tool sets (a NACK from one member is taken as authoritative for
the group), and tool names should always be namespaced.

## Version advertisement and mismatch behavior

- The SDK auto-injects `protocol: 2` into room presence; counterparts
  surface it as `ConnectedAgent.protocol` (absent = 1).
- **Fail fast at the operation, warn at discovery:** `Tools.invoke` and
  `Handoff.dispatch(waitForResult)` throw `IncompatibleProtocolError`
  *before* sending when every relevant visible responder (tool-servers by
  role / capability-matched workers) advertises protocol < 2 — that call is
  deterministically broken, so failing immediately beats burning the
  timeout. Mixed pools proceed with a single logged warning naming the old
  agents (presence is eventually consistent; hard-failing on one stale
  entry would flake).
- Escape hatch: `allowLegacyResponders` / `allow_legacy_responders` — 0.2.x
  JS / 0.3.0 Python responders already direct replies but predate
  advertisement and would otherwise false-positive.

## Correlation timeouts

Correlation timeout errors must carry operation context: the tool or
capability name, the room, how many responders were visible at send time,
and the likely causes (responder offline, responder pre-protocol-2, room
not deliverable). An opaque "correlation timed out" is a protocol-conformance
bug.

## Conformance

Run the cross-SDK e2e against a configured room on a real broker:

```bash
cd blueprints/e2e/cross-sdk
NOLAG_TOKEN=... E2E_APP_NAME=... E2E_ROOM=... node run.mjs
```

It asserts directed replies under load-balanced requester pools in both
directions (JS↔Python), Handoff results both ways, and is the gate for any
new language binding.
