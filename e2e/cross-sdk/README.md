# Cross-SDK Agents E2E

Proves `@nolag/agents` (JS, >=0.2.0) and `nolag-agents` (Python, >=0.3.0) are
wire-compatible against the real broker — specifically the **filter-directed
replies** protocol introduced to fix reply misrouting under load balancing.

## What it asserts

| # | Check |
|---|---|
| 1 | JS pool (2 connections, one `loadBalanceGroup`) invokes the Python-hosted `py.echo` tool 6×, alternating which pool member asks — every reply must land on the member that asked (pre-fix, ~half were load-balanced to the wrong member and timed out) |
| 2 | JS `Handoff.dispatch(waitForResult)` → Python worker `respond` — result delivered to the JS dispatcher |
| 3 | Python invokes the JS-hosted `js.echo` tool 3× — replies reach the Python requester |
| 4 | Python `dispatch(wait_for_result)` → JS worker — result delivered to the Python dispatcher |

## Run

```bash
NOLAG_TOKEN=<actor-token> \
E2E_APP_NAME=<app-slug> \
E2E_ROOM=<configured-room> \
node run.mjs
```

## Requirements

- **The room must be configured in the app** (Titus dashboard). Subscribing
  and publishing in an unconfigured room name does not error — messages are
  simply never delivered, so every correlation times out. If all checks fail
  with timeouts in both directions, check the room name first.
- JS side: `blueprints/js/agents` built (`yarn build` → uses `dist/index.mjs`).
- Python side: `blueprints/python/agents/.venv` with the local `nolag_agents`
  importable and the `nolag` base SDK installed (`pip install -e ../../../python-sdk`).
- Run it against a quiet room — it registers `js.echo`/`py.echo` tools and
  `js.double`/`py.double` capabilities; these are namespaced and harmless, but
  live workers in the same room add log noise.
