/**
 * Watch a live call and steer it, over NoLag alone.
 *
 *   npm run monitor <callid>
 *
 * Everything typed is spoken to the caller by the agent. A line starting with
 * "!" instead becomes silent guidance the model sees from its next turn on.
 *
 * This process never touches telephony or any AI vendor. It holds a NoLag
 * connection and nothing else, which is the whole point: anything with access
 * to the room can do this, including a dashboard or another agent.
 */

import "dotenv/config";
import readline from "node:readline";
import { NoLag } from "@nolag/js-sdk";
import { NoLagAgents } from "@nolag/agents";
import { NoLagVoice, callRoomSlug, createRoomProvisioner } from "@nolag/voice";

const callId = process.argv[2];
if (!callId) {
  console.error("Usage: npm run monitor <callid>");
  process.exit(1);
}

// A different actor from the one the call publishes as. The broker never
// delivers a message back to the actor that sent it, so sharing the server's
// token connects successfully and then shows nothing at all.
const token = process.env.NOLAG_MONITOR_TOKEN;
if (!token) {
  console.error(
    "Set NOLAG_MONITOR_TOKEN to a SECOND actor token (see .env.example).\n" +
      "Reusing the server's actor will connect fine and display nothing."
  );
  process.exit(1);
}

const appSlug = process.env.NOLAG_APP ?? "voice-calls";
const roomSlug = callRoomSlug(callId);

// The room already exists if the call is live; ensuring it lets you attach
// before the phone even rings.
if (process.env.NOLAG_API_KEY) {
  const provisioner = await createRoomProvisioner({
    apiKey: process.env.NOLAG_API_KEY,
    apiUrl: process.env.NOLAG_API_URL,
    appSlug,
  });
  await provisioner.ensureRoom(roomSlug);
}

const client = NoLag(token, { url: process.env.NOLAG_URL ?? "wss://broker.nolag.app/ws" });
client.on("error", (err) => console.error("[nolag]", err?.message ?? err));
await client.connect();

// The application owns the agents instance; @nolag/voice is handed one.
const agents = new NoLagAgents({
  client,
  appName: appSlug,
  agentId: `supervisor-${process.pid}`,
  role: "human",
  rooms: [roomSlug],
});
await agents.ready();

const voice = new NoLagVoice({ agents });

const watcher = voice.watchCall(callId, {
  onTranscript(line) {
    const tag = line.role === "caller" ? "CALLER" : line.kind === "filler" ? "FILLER" : "AGENT ";
    const timing = line.sttMs ? ` (stt ${line.sttMs}ms)` : line.llmMs ? ` (llm ${line.llmMs}ms)` : "";
    console.log(`${tag} | ${line.text}${timing}`);
  },
  onEvent(event) {
    const { event: name, at, ...detail } = event;
    console.log(`STATUS | ${name} ${Object.keys(detail).length ? JSON.stringify(detail) : ""}`);
  },
});

console.log(`Watching call "${roomSlug}". Type to speak through the agent, "!" for instructions.\n`);

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const text = line.trim();
  if (!text) return;
  if (text.startsWith("!")) {
    watcher.instruct(text.slice(1).trim());
    console.log("       | instruction sent");
  } else {
    watcher.say(text);
    console.log("       | say sent");
  }
});

process.on("SIGINT", () => {
  agents.detach();
  client.disconnect();
  process.exit(0);
});
