#!/usr/bin/env python3
"""Python half of the cross-SDK agents e2e.

Phase 1 (responder): registers the `py.echo` tool and a `py.double` task
handler, then prints READY and serves the JS driver.

Phase 2 (requester): on "GO" via stdin, invokes the JS-hosted `js.echo`
tool and dispatches a `js.double` task with wait_for_result — proving the
JS side's filter-directed replies reach a Python requester, and vice versa.

All output lines are JSON for the driver to parse.
"""
from __future__ import annotations

import asyncio
import json
import os
import sys

sys.path.insert(0, os.environ["PY_AGENTS_PATH"])

from nolag_agents import NoLagAgents, NoLagAgentsOptions, AgentPresenceData  # noqa: E402
from nolag_agents.patterns import Handoff, Tools  # noqa: E402


def emit(event: str, **kwargs) -> None:
    print(json.dumps({"event": event, **kwargs}), flush=True)


async def main() -> None:
    token = os.environ["NOLAG_TOKEN"]
    app_name = os.environ.get("E2E_APP_NAME", "agents")
    room_name = os.environ.get("E2E_ROOM", "e2e-cross-sdk")

    client = NoLagAgents(
        token,
        NoLagAgentsOptions(
            app_name=app_name,
            agent_id="py-agent-1",
            rooms=[room_name],
            presence=AgentPresenceData(
                name="py-agent-1", role="agent", capabilities=["py.double"],
            ),
            # Exercise the python SDK's per-topic LB path too (group of one)
            load_balance=True,
            load_balance_group="e2e-py-pool",
        ),
    )
    await client.connect()
    room = await client.room(room_name)

    tools = Tools(room, "py-agent-1")
    tools.register("py.echo", lambda args: {"lang": "python", "echo": args})

    handoff = Handoff(room)

    def on_double(task, respond):
        asyncio.ensure_future(
            respond("success", {"doubled": task.payload.get("x", 0) * 2, "lang": "python"})
        )

    handoff.on_task(["py.double"], on_double)

    emit("ready", agent_id="py-agent-1")

    # Wait for the driver's GO before starting the requester phase
    loop = asyncio.get_running_loop()
    line = await loop.run_in_executor(None, sys.stdin.readline)
    if line.strip() != "GO":
        emit("error", message=f"unexpected stdin: {line!r}")
        return

    # ── Phase 2: Python requester → JS responders ──
    ok = True

    for i in range(3):
        try:
            res = await tools.invoke("js.echo", {"n": i}, timeout=15000)
            payload = res.result if isinstance(res.result, dict) else {}
            if res.status == "success" and payload.get("lang") == "javascript":
                emit("tool_ok", i=i)
            else:
                ok = False
                emit("tool_fail", i=i, status=res.status, result=res.result)
        except Exception as err:  # noqa: BLE001
            ok = False
            emit("tool_fail", i=i, error=str(err))

    # NO_HANDLER NACK: js workers serve the 'js.' namespace, so an unknown
    # js.* tool must come back as a fast NACK, not a timeout
    import time
    t0 = time.monotonic()
    try:
        res = await tools.invoke("js.does_not_exist", {}, timeout=10000)
        elapsed = time.monotonic() - t0
        err = res.error or {}
        if res.status == "error" and err.get("code") == "NO_HANDLER" and elapsed < 5.0:
            emit("nack_ok", elapsed=round(elapsed, 2))
        else:
            ok = False
            emit("nack_fail", status=res.status, error=err, elapsed=round(elapsed, 2))
    except Exception as err:  # noqa: BLE001
        ok = False
        emit("nack_fail", error=str(err), elapsed=round(time.monotonic() - t0, 2))

    try:
        result = await handoff.dispatch(
            "js.double", {"x": 34},
            wait_for_result=True, timeout=15000, allow_no_workers=True,
        )
        if result and result.status == "success" and result.payload.get("doubled") == 68:
            emit("task_ok", doubled=result.payload.get("doubled"))
        else:
            ok = False
            emit("task_fail", payload=getattr(result, "payload", None))
    except Exception as err:  # noqa: BLE001
        ok = False
        emit("task_fail", error=str(err))

    emit("done", ok=ok)
    await client.disconnect()


if __name__ == "__main__":
    asyncio.run(main())
