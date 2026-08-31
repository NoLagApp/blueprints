/**
 * The other half of the voice agent: the part that actually knows things.
 *
 * Robin, on the phone, has about a second to reply. That budget buys a small
 * model with no tools, which is the right choice for conversation and the wrong
 * one for deciding whether a booking can be moved. This process is the opposite
 * trade: a larger model, a set of real tools, and as long as it needs.
 *
 * It runs as a separate process because that is the honest shape of it. It has
 * database credentials the phone-facing server does not need, it scales on a
 * different curve, and it can be restarted without dropping a call.
 *
 * Run it alongside the server:
 *
 *     npm run orchestrator     # this file
 *     npm start                # the phone-facing server
 *
 * ## Running more than one of these
 *
 * The `tasks` topic broadcasts by default, so three replicas started with plain
 * options each receive every question and each run the same expensive
 * inference, and three answers race back to the same call.
 * `orchestratorPoolOptions()` is what makes a pool share the work instead. Both
 * halves of it matter: the load-balance group defaults to the actor token id,
 * so replicas holding different tokens still each get a copy. Nothing about
 * that failure is loud; it shows up on the bill.
 *
 * Set ORCHESTRATOR_POOL to turn pooling on. It is unset by default only
 * because a single orchestrator has no work to share; there is no reason to
 * avoid it. Verified against the broker: two replicas split 8 tasks 4/4 with
 * no duplicates, and when one scales away the survivor picks up all of the
 * next 6 rather than the departed one continuing to take a share.
 *
 * That last part needed a broker fix (kraken v0.7.0 / kraken-proxy v0.14.0).
 * Before it, a disconnected member kept its slot in the round robin, so every
 * scale-down silently dropped a share of the work and the symptom on the call
 * was an ask that timed out for no visible reason. If you run against an older
 * broker, either use a single orchestrator or give the pool a fresh group name
 * on each deploy.
 */

import "dotenv/config";
import { NoLag } from "@nolag/js-sdk";
import { Handoff, NoLagAgents } from "@nolag/agents";
import {
  ORCHESTRATOR_CAPABILITY,
  ORCHESTRATOR_ROOM,
  createRoomProvisioner,
  orchestratorPoolOptions,
} from "@nolag/voice";

function required(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required env var ${name} (see .env.example)`);
    process.exit(1);
  }
  return value;
}

const apiKey = required("OPENROUTER_API_KEY");

/**
 * Its own actor token, not the call server's.
 *
 * The broker never delivers a message back to the actor that published a
 * message. Share a token with the voice server and the two processes are one
 * actor, so every task it publishes is invisible here. Nothing looks broken:
 * both connect, both join, presence lists them both, the capability is
 * discovered. The answers simply never come, which reads like a slow
 * orchestrator rather than a token mistake.
 */
const token = process.env.ORCHESTRATOR_TOKEN ?? process.env.NOLAG_MONITOR_TOKEN;
if (!token) {
  console.error(
    "Missing ORCHESTRATOR_TOKEN. It must be a different actor token from " +
      "NOLAG_ACCESS_TOKEN, or the call server's tasks will never be delivered here."
  );
  process.exit(1);
}
if (token === process.env.NOLAG_ACCESS_TOKEN) {
  console.error(
    "ORCHESTRATOR_TOKEN is the same actor as the call server. Every ask will time out."
  );
  process.exit(1);
}
const url = process.env.NOLAG_URL ?? "wss://broker.nolag.app/ws";
const appSlug = process.env.NOLAG_APP ?? "voice-calls";
const model = process.env.ORCHESTRATOR_MODEL ?? "anthropic/claude-sonnet-4.5";
// Opt in. See the note at the top of this file: pooling is correct for more
// than one replica, and currently loses work to members that have gone away.
const pool = process.env.ORCHESTRATOR_POOL || null;

// --- The systems this thing can actually reach -----------------------------
// Stand-ins for a booking database and a dispatch system. Replace the bodies,
// keep the shape: the point of the exercise is that these live here, behind a
// larger model, rather than inside a call that has a second to answer.

const BOOKINGS = {
  "TR-4417": {
    reference: "TR-4417",
    passenger: "Alex",
    pickup: "2026-09-02T15:40:00+10:00",
    from: "Melbourne Airport T2",
    to: "Carlton",
    vehicle: "sedan",
    status: "confirmed",
  },
};

const SLOTS = {
  "2026-09-02": ["13:15", "13:45", "15:40", "16:20"],
};

/**
 * References arrive spoken, so punctuation is gone by the time they get here:
 * "T R dash four four one seven" transcribes as "TR4417" about as often as
 * "TR-4417". Matching strictly means a real booking reports as missing, and
 * the agent then tells the customer their booking does not exist.
 */
const findBooking = (reference) => {
  const key = String(reference ?? "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
  return Object.values(BOOKINGS).find(
    (booking) => booking.reference.replace(/[^A-Z0-9]/g, "") === key
  );
};

const TOOLS = {
  look_up_booking: {
    describe: {
      name: "look_up_booking",
      description: "Fetch a booking by its reference.",
      parameters: {
        type: "object",
        properties: { reference: { type: "string" } },
        required: ["reference"],
      },
    },
    run: ({ reference }) => findBooking(reference) ?? { error: "not found" },
  },
  find_booking_for_passenger: {
    describe: {
      name: "find_booking_for_passenger",
      description:
        "Find a passenger's current booking by name. Prefer this over a " +
        "reference: references are spelled out loud and mistranscribed often.",
      parameters: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
      },
    },
    run: ({ name }) => {
      const wanted = String(name ?? "").trim().toLowerCase();
      const booking = Object.values(BOOKINGS).find(
        (entry) => entry.passenger.toLowerCase() === wanted
      );
      return booking ?? { error: "no booking for that passenger" };
    },
  },
  list_available_slots: {
    describe: {
      name: "list_available_slots",
      description: "Pickup times still open on a date, as YYYY-MM-DD.",
      parameters: {
        type: "object",
        properties: { date: { type: "string" } },
        required: ["date"],
      },
    },
    run: ({ date }) => ({ date, slots: SLOTS[date] ?? [] }),
  },
  move_booking: {
    describe: {
      name: "move_booking",
      description: "Move a booking to a new pickup time on the same day.",
      parameters: {
        type: "object",
        properties: { reference: { type: "string" }, time: { type: "string" } },
        required: ["reference", "time"],
      },
    },
    run: ({ reference, time }) => {
      const booking = findBooking(reference);
      if (!booking) return { error: "not found" };
      const date = booking.pickup.slice(0, 10);
      if (!(SLOTS[date] ?? []).includes(time)) return { error: "slot not available" };
      booking.pickup = `${date}T${time}:00+10:00`;
      return { moved: true, reference: booking.reference, pickup: booking.pickup };
    },
  },
};

const SYSTEM_PROMPT = `You support a phone agent for a transport company. The
agent is mid-conversation with a customer and cannot wait long, so answer the
question it asks and nothing else.

Use the tools rather than guessing. If a tool says something is unavailable,
say so plainly instead of offering an alternative you have not checked.

Reply as JSON only, with no code fence:
{"speech": "...", "detail": "..."}

"speech" is read aloud to the customer, so it must be one or two short spoken
sentences and must make sense on its own: it may be heard a turn or two after
the question was asked, so anchor it ("about that pickup, ..."). Never mention
tools, systems, references or JSON. "detail" is for the agent only and is never
spoken; keep it to the facts it might need next.`;

async function callModel(messages) {
  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages,
      tools: Object.values(TOOLS).map((tool) => ({ type: "function", function: tool.describe })),
    }),
  });
  if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
  const body = await response.json();
  const choice = body.choices?.[0]?.message;
  if (!choice) throw new Error("no reply from the model");
  return choice;
}

/**
 * Answers one question, taking as many tool round trips as it needs.
 *
 * This is the whole reason the voice side treats an answer as asynchronous:
 * two or three round trips to a large model is five to fifteen seconds, and
 * that cannot be nested inside a turn on a live phone call.
 */
async function answer(question, context) {
  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: "user",
      content: `Recent conversation:\n${context || "(none)"}\n\nThe agent asks: ${question}`,
    },
  ];

  for (let round = 0; round < 5; round++) {
    const reply = await callModel(messages);
    messages.push(reply);

    const calls = reply.tool_calls ?? [];
    if (!calls.length) return parseAnswer(reply.content);

    for (const call of calls) {
      const tool = TOOLS[call.function?.name];
      let result;
      try {
        result = tool
          ? tool.run(JSON.parse(call.function.arguments || "{}"))
          : { error: `no such tool ${call.function?.name}` };
      } catch (error) {
        result = { error: error.message };
      }
      console.log(`  tool ${call.function?.name} -> ${JSON.stringify(result)}`);
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: JSON.stringify(result),
      });
    }
  }
  throw new Error("gave up after five rounds of tool calls");
}

/** Models emit fenced JSON however firmly you ask them not to. */
function parseAnswer(content) {
  const text = String(content ?? "").trim();
  const json = text.replace(/^```(?:json)?\s*|\s*```$/g, "");
  try {
    const parsed = JSON.parse(json);
    if (typeof parsed?.speech === "string") return parsed;
  } catch {
    // Falls through: unparseable output is still usable as speech.
  }
  return { speech: text, detail: "" };
}

// --- Joining the room -------------------------------------------------------

// The room is static in the blueprint, but an app created from an earlier
// version of it will not have one, and the broker rejects rooms it has never
// been told about. Whichever process starts first creates it; the call is
// idempotent. Either process can do this, so neither has to start first.
if (process.env.NOLAG_API_KEY) {
  const provisioner = await createRoomProvisioner({
    apiKey: process.env.NOLAG_API_KEY,
    apiUrl: process.env.NOLAG_API_URL,
    appSlug,
  });
  await provisioner.ensureRoom(ORCHESTRATOR_ROOM);
}

const client = NoLag(token, { url, ...(pool ? orchestratorPoolOptions(pool) : {}) });
client.on("error", (error) => console.error("[nolag]", error?.message ?? error));
await client.connect();

const agents = new NoLagAgents({
  client,
  appName: appSlug,
  // Unique per process. Results are addressed to the dispatcher, but a shared
  // id here makes two replicas indistinguishable in presence and in logs.
  agentId: `orchestrator-${process.pid}`,
  role: "agent",
  rooms: [ORCHESTRATOR_ROOM],
  presence: {
    name: "Booking orchestrator",
    role: "agent",
    // Names only: presence carries no schemas, and the phone agent does not
    // choose between tools anyway. It asks one colleague a question.
    capabilities: [ORCHESTRATOR_CAPABILITY],
  },
});
await agents.ready();

const room = agents.room(ORCHESTRATOR_ROOM);
const handoff = new Handoff(room);

handoff.onTask([ORCHESTRATOR_CAPABILITY], async (task, respond) => {
  const { question, context, callId } = task.payload ?? {};
  const startedAt = Date.now();
  console.log(`[${callId}] ${question}`);

  try {
    const result = await answer(String(question ?? ""), String(context ?? ""));
    console.log(`[${callId}] ${Date.now() - startedAt}ms -> ${result.speech}`);
    respond("success", { speech: result.speech, detail: result.detail ?? "" });
  } catch (error) {
    console.error(`[${callId}] failed after ${Date.now() - startedAt}ms: ${error.message}`);
    // Answered rather than dropped. Silence on the voice side becomes a caller
    // holding a phone waiting for something that is never coming.
    respond("error", { speech: "" }, { code: "orchestrator_failed", message: error.message });
  }
});

console.log(`Orchestrator ${agents.agentId} ready`);
console.log(`  room       ${ORCHESTRATOR_ROOM}`);
console.log(`  capability ${ORCHESTRATOR_CAPABILITY}`);
console.log(`  model      ${model}`);
console.log(
  pool
    ? `  pool       ${pool} (load balanced, so replicas share the work)`
    : "  pool       off (single replica; set ORCHESTRATOR_POOL to share work)"
);

const shutdown = () => {
  agents.detach();
  client.disconnect();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
