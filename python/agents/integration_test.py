#!/usr/bin/env python3
"""
Integration test for nolag-agents SDK.

Spins up two NoLagAgents instances and tests all 6 patterns end-to-end.

Usage:
    python integration_test.py token1=<token-a> token2=<token-b> appSlug=<app-slug>
"""

import asyncio
import os
import sys
import time

# Use local python-sdk source, not installed package
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..", "python-sdk"))

from nolag_agents import (
    NoLagAgents,
    NoLagAgentsOptions,
    AgentPresenceData,
)
from nolag_agents.patterns import Handoff, Blackboard, Inbox, Tools, Approve, Observe


# ── Helpers ──

PASS = "\033[92mPASS\033[0m"
FAIL = "\033[91mFAIL\033[0m"
BOLD = "\033[1m"
RESET = "\033[0m"

results: list[tuple[str, bool, str]] = []


def report(name: str, passed: bool, detail: str = "") -> None:
    results.append((name, passed, detail))
    status = PASS if passed else FAIL
    msg = f"  {status}  {name}"
    if detail:
        msg += f"  ({detail})"
    print(msg)


async def with_timeout(coro, seconds: float = 10.0, label: str = ""):
    try:
        return await asyncio.wait_for(coro, timeout=seconds)
    except asyncio.TimeoutError:
        raise TimeoutError(f"Timed out after {seconds}s: {label}")


# ── Pattern Tests ──

async def test_handoff(room_a, room_b):
    """Agent A dispatches a task, Agent B handles it and returns a result."""
    handoff_a = Handoff(room_a)
    handoff_b = Handoff(room_b)

    received_task = asyncio.get_running_loop().create_future()

    def worker_handler(task, respond):
        asyncio.ensure_future(respond("success", {"answer": task.payload.get("x", 0) * 2}))
        if not received_task.done():
            received_task.set_result(task)

    handoff_b.on_task(["multiply"], worker_handler)

    await asyncio.sleep(0.5)

    result = await with_timeout(
        handoff_a.dispatch(
            "multiply",
            {"x": 21},
            wait_for_result=True,
            timeout=10000,
            allow_no_workers=True,
        ),
        seconds=15,
        label="handoff dispatch",
    )

    task = await with_timeout(received_task, seconds=5, label="worker receive task")

    ok = (
        result is not None
        and result.status == "success"
        and result.payload.get("answer") == 42
        and task.capability == "multiply"
    )
    report("Handoff", ok, f"result={result.payload if result else None}")

    handoff_a.dispose()
    handoff_b.dispose()


async def test_blackboard(room_a, room_b):
    """Agent A sets a value, Agent B reads it via state_change event."""
    bb_a = Blackboard(room_a, room_a.agent_id)
    bb_b = Blackboard(room_b, room_b.agent_id)

    received = asyncio.get_running_loop().create_future()
    bb_b.on_change("shared_counter", lambda env: (
        received.set_result(env) if not received.done() else None
    ))

    await asyncio.sleep(0.3)
    await bb_a.set("shared_counter", 99)

    env = await with_timeout(received, seconds=10, label="blackboard change")
    ok = env.key == "shared_counter" and env.value == 99 and env.version >= 1
    report("Blackboard", ok, f"key={env.key} value={env.value} version={env.version}")


async def test_inbox(room_a, room_b):
    """Agent A sends a direct message to Agent B's inbox."""
    inbox_a = Inbox(room_a, room_a.agent_id)
    inbox_b = Inbox(room_b, room_b.agent_id)

    received = asyncio.get_running_loop().create_future()
    inbox_b.on_message(lambda msg: (
        received.set_result(msg) if not received.done() else None
    ))

    await asyncio.sleep(0.3)
    await inbox_a.send(room_b.agent_id, {"text": "hello from A"})

    msg = await with_timeout(received, seconds=10, label="inbox message")
    ok = msg.from_agent == room_a.agent_id and msg.payload.get("text") == "hello from A"
    report("Inbox", ok, f"from={msg.from_agent} payload={msg.payload}")


async def test_tools(room_a, room_b):
    """Agent B registers a tool, Agent A invokes it remotely."""
    tools_a = Tools(room_a, room_a.agent_id)
    tools_b = Tools(room_b, room_b.agent_id)

    def calculator(args):
        op = args.get("op", "add")
        a, b = args.get("a", 0), args.get("b", 0)
        if op == "add":
            return a + b
        elif op == "mul":
            return a * b
        raise ValueError(f"Unknown op: {op}")

    tools_b.register("calculator", calculator)

    await asyncio.sleep(0.5)

    response = await with_timeout(
        tools_a.invoke("calculator", {"op": "add", "a": 17, "b": 25}, timeout=10000),
        seconds=15,
        label="tools invoke",
    )

    ok = response.status == "success" and response.result == 42
    report("Tools", ok, f"status={response.status} result={response.result}")

    tools_a.dispose()
    tools_b.dispose()


async def test_approve(room_a, room_b):
    """Agent A requests approval, Agent B (human proxy) approves it."""
    approve_a = Approve(room_a, room_a.agent_id)
    approve_b = Approve(room_b, room_b.agent_id)

    def approval_handler(request, respond):
        if request.action == "deploy_to_prod":
            asyncio.ensure_future(respond("approved", "LGTM"))
        else:
            asyncio.ensure_future(respond("rejected", "unknown action"))

    approve_b.on_request(approval_handler)

    await asyncio.sleep(0.5)

    response = await with_timeout(
        approve_a.request("deploy_to_prod", {"env": "production"}, timeout=10000),
        seconds=15,
        label="approve request",
    )

    ok = response.decision == "approved" and response.reason == "LGTM"
    report("Approve", ok, f"decision={response.decision} reason={response.reason}")

    approve_a.dispose()
    approve_b.dispose()


async def test_observe(room_a, room_b):
    """Agent A emits an observability event, Agent B receives it."""
    observe_a = Observe(room_a, room_a.agent_id)
    observe_b = Observe(room_b, room_b.agent_id)

    received = asyncio.get_running_loop().create_future()
    observe_b.on(
        lambda env: received.set_result(env) if not received.done() else None,
        category="task.completed",
    )

    await asyncio.sleep(0.3)
    await observe_a.emit("task.completed", {"task_id": "t1", "duration_ms": 150}, severity="info")

    env = await with_timeout(received, seconds=10, label="observe event")
    ok = (
        env.category == "task.completed"
        and env.severity == "info"
        and (env.payload.get("task_id") == "t1" or env.payload.get("taskId") == "t1")
    )
    report("Observe", ok, f"category={env.category} severity={env.severity}")


async def test_load_balance(token1, token2, app_slug):
    """Two workers with load_balance share tasks via round-robin."""
    # Spin up 3 agents: 1 orchestrator (token1), 2 workers (both token2, same group)
    orchestrator = NoLagAgents(token1, NoLagAgentsOptions(
        app_name=app_slug,
        agent_id="lb-orchestrator",
        debug=False,
        rooms=["default-workflow"],
    ))
    worker1 = NoLagAgents(token2, NoLagAgentsOptions(
        app_name=app_slug,
        agent_id="lb-worker-1",
        debug=False,
        rooms=["default-workflow"],
        load_balance=True,
        load_balance_group="task-workers",
    ))
    worker2 = NoLagAgents(token2, NoLagAgentsOptions(
        app_name=app_slug,
        agent_id="lb-worker-2",
        debug=False,
        rooms=["default-workflow"],
        load_balance=True,
        load_balance_group="task-workers",
    ))

    await orchestrator.connect()
    await worker1.connect()
    await worker2.connect()

    await asyncio.sleep(1.0)

    room_orch = await orchestrator.room("default-workflow")
    room_w1 = await worker1.room("default-workflow")
    room_w2 = await worker2.room("default-workflow")

    handoff_orch = Handoff(room_orch)
    handoff_w1 = Handoff(room_w1)
    handoff_w2 = Handoff(room_w2)

    received_w1 = []
    received_w2 = []

    handoff_w1.on_task("*", lambda task, respond: received_w1.append(task))
    handoff_w2.on_task("*", lambda task, respond: received_w2.append(task))

    await asyncio.sleep(0.5)

    # Dispatch multiple tasks
    task_count = 6
    for i in range(task_count):
        await handoff_orch.dispatch(
            "work", {"seq": i}, allow_no_workers=True,
        )

    await asyncio.sleep(2.0)

    total = len(received_w1) + len(received_w2)
    distributed = len(received_w1) > 0 and len(received_w2) > 0
    ok = total == task_count and distributed
    report(
        "Load Balance (Handoff)",
        ok,
        f"W1={len(received_w1)} W2={len(received_w2)} total={total}/{task_count} distributed={distributed}",
    )

    handoff_orch.dispose()
    handoff_w1.dispose()
    handoff_w2.dispose()
    orchestrator.disconnect()
    worker1.disconnect()
    worker2.disconnect()
    await asyncio.sleep(0.5)


# ── Main ──

async def run(token1: str, token2: str, app_slug: str):
    print(f"\n{BOLD}NoLag Agents Integration Test{RESET}")
    print(f"  App: {app_slug}")
    print(f"  Room: default-workflow\n")

    agent_a = NoLagAgents(token1, NoLagAgentsOptions(
        app_name=app_slug,
        agent_id="agent-a",
        debug=False,
        rooms=["default-workflow"],
        presence=AgentPresenceData(
            name="Agent A",
            role="orchestrator",
            capabilities=["dispatch", "invoke"],
        ),
    ))

    agent_b = NoLagAgents(token2, NoLagAgentsOptions(
        app_name=app_slug,
        agent_id="agent-b",
        debug=False,
        rooms=["default-workflow"],
        presence=AgentPresenceData(
            name="Agent B",
            role="worker",
            capabilities=["multiply", "calculator", "approve"],
        ),
    ))

    print("Connecting agents...")
    await agent_a.connect()
    await agent_b.connect()
    print(f"  Agent A connected: {agent_a.connected}")
    print(f"  Agent B connected: {agent_b.connected}\n")

    # Let subscriptions settle
    await asyncio.sleep(1.0)

    room_a = await agent_a.room("default-workflow")
    room_b = await agent_b.room("default-workflow")

    print(f"{BOLD}Running patterns:{RESET}\n")

    tests = [
        ("Handoff", test_handoff),
        ("Blackboard", test_blackboard),
        ("Inbox", test_inbox),
        ("Tools", test_tools),
        ("Approve", test_approve),
        ("Observe", test_observe),
    ]

    for name, test_fn in tests:
        try:
            await test_fn(room_a, room_b)
        except Exception as e:
            report(name, False, str(e))

    print(f"\n{BOLD}Load Balancing:{RESET}\n")
    try:
        await test_load_balance(token1, token2, app_slug)
    except Exception as e:
        report("Load Balance (Handoff)", False, str(e))

    # Summary
    passed = sum(1 for _, ok, _ in results if ok)
    total = len(results)
    print(f"\n{BOLD}Results: {passed}/{total} passed{RESET}")

    agent_a.disconnect()
    agent_b.disconnect()

    if passed < total:
        sys.exit(1)


def main():
    args = {}
    for arg in sys.argv[1:]:
        if "=" in arg:
            key, val = arg.split("=", 1)
            args[key] = val

    token1 = args.get("token1")
    token2 = args.get("token2")
    app_slug = args.get("appSlug")

    if not all([token1, token2, app_slug]):
        print("Usage: python integration_test.py token1=<token-a> token2=<token-b> appSlug=<app-slug>")
        sys.exit(1)

    asyncio.run(run(token1, token2, app_slug))


if __name__ == "__main__":
    main()
