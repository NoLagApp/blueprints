#!/usr/bin/env node
/**
 * Cross-SDK agents e2e: JS (@nolag/agents 0.2.0) <-> Python (nolag-agents 0.3.0)
 * against the real broker.
 *
 * Recreates the original reply-misrouting bug conditions: the JS side runs a
 * TWO-connection pool in one loadBalanceGroup. Pre-fix, replies were
 * load-balanced across the pool and ~half of them missed the requester
 * (correlation timeout). With filter-directed replies every reply must land.
 *
 * Phases:
 *   1. JS requester pool  -> Python tool server (py.echo x6) and
 *      Python task worker (py.double, waitForResult)
 *   2. Python requester   -> JS tool servers (js.echo x3) and
 *      JS task workers (js.double, wait_for_result)
 *
 * Usage:
 *   NOLAG_TOKEN=... [E2E_APP_NAME=...] node run.mjs
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import * as readline from "node:readline";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const JS_AGENTS = path.resolve(__dirname, "../../js/agents/dist/index.mjs");
const PY_AGENTS_DIR = path.resolve(__dirname, "../../python/agents");

const { NoLagAgents, Tools, Handoff } = await import(JS_AGENTS);

const TOKEN = process.env.NOLAG_TOKEN;
const APP_NAME = process.env.E2E_APP_NAME || "agents";
const ROOM = process.env.E2E_ROOM || "e2e-cross-sdk";
if (!TOKEN) {
  console.error("Missing NOLAG_TOKEN env var");
  process.exit(2);
}

let passed = 0;
const failures = [];
function check(name, ok, detail = "") {
  if (ok) {
    passed++;
    console.log(`  \x1b[92mPASS\x1b[0m  ${name}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.error(`  \x1b[91mFAIL\x1b[0m  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

/** Connect one JS pool member: registers js.echo + js.double like a real worker. */
async function connectPoolMember(index) {
  const agentId = `js-worker-${index}`;
  const client = new NoLagAgents(TOKEN, {
    appName: APP_NAME,
    agentId,
    rooms: [ROOM],
    presence: { name: agentId, role: "agent", capabilities: ["js.double"] },
    clientOptions: {
      loadBalance: true,
      loadBalanceGroup: "e2e-js-pool",
    },
  });
  await client.connect();
  const room = client.room(ROOM);

  const tools = new Tools(room, agentId);
  tools.register("js.echo", (args) => ({ lang: "javascript", echo: args }));

  const handoff = new Handoff(room);
  handoff.onTask(["js.double"], (task, respond) => {
    respond("success", { doubled: (task.payload.x ?? 0) * 2, lang: "javascript" });
  });

  return { client, room, tools, handoff, agentId };
}

// ── Boot the stack ─────────────────────────────────────────────
console.log("[e2e] connecting JS pool (2 members, one loadBalanceGroup)...");
const memberA = await connectPoolMember(0);
const memberB = await connectPoolMember(1);

console.log("[e2e] starting python agent...");
const py = spawn(path.join(PY_AGENTS_DIR, ".venv/bin/python"), [path.join(__dirname, "py_agent.py")], {
  env: {
    ...process.env,
    NOLAG_TOKEN: TOKEN,
    E2E_APP_NAME: APP_NAME,
    E2E_ROOM: ROOM,
    PY_AGENTS_PATH: PY_AGENTS_DIR,
  },
  stdio: ["pipe", "pipe", "inherit"],
});

const pyEvents = [];
const pyWaiters = [];
const rl = readline.createInterface({ input: py.stdout });
rl.on("line", (line) => {
  let evt;
  try {
    evt = JSON.parse(line);
  } catch {
    console.log(`[py] ${line}`);
    return;
  }
  console.log(`[py] ${line}`);
  pyEvents.push(evt);
  for (const w of pyWaiters.splice(0)) w();
});

function waitForPyEvent(name, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const probe = () => {
      const found = pyEvents.find((e) => e.event === name);
      if (found) return resolve(found);
      if (Date.now() > deadline) return reject(new Error(`timeout waiting for py event: ${name}`));
      pyWaiters.push(probe);
      setTimeout(() => {
        const idx = pyWaiters.indexOf(probe);
        if (idx >= 0) {
          pyWaiters.splice(idx, 1);
          probe();
        }
      }, 500);
    };
    probe();
  });
}

let exitCode = 1;
try {
  await waitForPyEvent("ready");
  // Let presence + subscriptions settle across all three connections
  await new Promise((r) => setTimeout(r, 3000));

  // ── Phase 1: JS pool requester -> Python responders ─────────
  console.log("\n[e2e] Phase 1: JS (load-balanced pool) -> Python");
  for (let i = 0; i < 6; i++) {
    // Alternate which pool member invokes — both must receive THEIR replies
    const member = i % 2 === 0 ? memberA : memberB;
    try {
      const res = await member.tools.invoke("py.echo", { n: i }, { timeout: 15_000 });
      check(
        `py.echo #${i} via ${member.agentId} reply delivered`,
        res.status === "success" && res.result?.lang === "python",
        JSON.stringify(res.result),
      );
    } catch (err) {
      check(`py.echo #${i} via ${member.agentId} reply delivered`, false, err.message);
    }
  }

  try {
    const result = await memberA.handoff.dispatch(
      "py.double",
      { x: 21 },
      { waitForResult: true, timeout: 15_000, allowNoWorkers: true },
    );
    check(
      "py.double task result delivered to JS dispatcher",
      result?.status === "success" && result?.payload?.doubled === 42,
      JSON.stringify(result?.payload),
    );
  } catch (err) {
    check("py.double task result delivered to JS dispatcher", false, err.message);
  }

  // (still Phase 1) JS -> PY unknown tool in the python namespace -> fast NACK
  {
    const t0 = Date.now();
    try {
      const res = await memberA.tools.invoke("py.does_not_exist", {}, { timeout: 10_000 });
      const elapsed = Date.now() - t0;
      check(
        "JS->PY unknown tool gets a fast NO_HANDLER NACK",
        res.status === "error" && res.error?.code === "NO_HANDLER" && elapsed < 5000,
        `status=${res.status} code=${res.error?.code} ${elapsed}ms`,
      );
    } catch (err) {
      check("JS->PY unknown tool gets a fast NO_HANDLER NACK", false, err.message);
    }
  }

  // ── Phase 2: Python requester -> JS responders ───────────────
  console.log("\n[e2e] Phase 2: Python -> JS (load-balanced pool)");
  py.stdin.write("GO\n");
  const done = await waitForPyEvent("done", 60_000);
  const toolOks = pyEvents.filter((e) => e.event === "tool_ok").length;
  check("js.echo replies delivered to Python requester (3/3)", toolOks === 3, `${toolOks}/3`);
  check(
    "js.double task result delivered to Python dispatcher",
    pyEvents.some((e) => e.event === "task_ok" && e.doubled === 68),
  );
  check(
    "PY->JS unknown tool gets a fast NO_HANDLER NACK",
    pyEvents.some((e) => e.event === "nack_ok"),
    JSON.stringify(pyEvents.find((e) => e.event === "nack_fail") ?? "no nack event"),
  );
  check("python side reports overall ok", done.ok === true);

  // ── Phase 3: loud failures ───────────────────────────────────
  console.log("\n[e2e] Phase 3: loud failures");

  // (b) unencodable payload throws synchronously with the topic named
  {
    const room = memberA.client.room(ROOM);
    const circular = {}; circular.self = circular;
    let threw = null;
    memberA.client.rooms?.get?.(ROOM); // noop guard
    try {
      room.context.emit("events", circular);
    } catch (err) {
      threw = err;
    }
    check(
      "unencodable payload throws synchronously naming the topic",
      threw !== null && threw.name === "NoLagEncodeError" && threw.message.includes("events"),
      threw ? `${threw.name}: ${threw.message.slice(0, 80)}` : "did not throw",
    );
  }

  // (c) responder advertising agents-protocol 1 -> fail fast, no timeout burned
  {
    const oldAgent = new NoLagAgents(TOKEN, {
      appName: APP_NAME,
      agentId: "legacy-sim-1",
      rooms: [ROOM],
      presence: { name: "legacy-sim-1", role: "agent", capabilities: ["legacy.work"], protocol: 1 },
    });
    await oldAgent.connect();
    await new Promise((r) => setTimeout(r, 2500)); // presence propagation

    const t0 = Date.now();
    try {
      await memberA.handoff.dispatch("legacy.work", {}, { waitForResult: true, timeout: 20_000 });
      check("dispatch to all-legacy workers fails fast", false, "resolved unexpectedly");
    } catch (err) {
      const elapsed = Date.now() - t0;
      check(
        "dispatch to all-legacy workers fails fast with IncompatibleProtocolError",
        err.name === "IncompatibleProtocolError" && elapsed < 5000,
        `${err.name} after ${elapsed}ms`,
      );
    }
    oldAgent.disconnect();
  }

  exitCode = failures.length === 0 ? 0 : 1;
} catch (err) {
  console.error("[e2e] fatal:", err.message);
} finally {
  py.kill("SIGTERM");
  memberA.client.disconnect();
  memberB.client.disconnect();
}

console.log(`\n[e2e] ${passed} passed, ${failures.length} failed`);
for (const f of failures) console.error(`  FAILED: ${f}`);
process.exit(exitCode);
