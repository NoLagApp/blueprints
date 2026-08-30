/**
 * Robin, a booking assistant for a fictional transport company.
 *
 * She rings a customer whose flight moved, tells them, and offers to bring
 * their airport pickup forward. Everything real-time belongs to
 * @nolag/voice-engine; everything coordination belongs to @nolag/voice. What
 * is left here is configuration and wiring, which is the point of the split.
 *
 *   POST /voice   telephony webhook, answers with TwiML
 *   WS   /media   the call audio, both directions
 *   GET  /simulator  a browser pretending to be a phone
 *
 * `npm run call -- +61...` places an outbound call.
 * `npm run monitor <callid>` watches and steers one over NoLag.
 */

import "dotenv/config";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { WebSocketServer } from "ws";
import { NoLag } from "@nolag/js-sdk";
import { NoLagAgents } from "@nolag/agents";
import {
  OpenRouterLanguageModel,
  OpenRouterSpeechToText,
  OpenRouterTextToSpeech,
  TwilioMediaStreamTransport,
  VoiceSession,
  createFillerBank,
} from "@nolag/voice-engine";
// Recording touches the filesystem, so it is a separate entry point: an agent
// running in a function should not carry it.
import { createRecorder } from "@nolag/voice-engine/recorder";
import {
  NoLagVoice,
  callRoomSlug,
  createRoomProvisioner,
  orchestratedModel,
  ORCHESTRATOR_ROOM,
} from "@nolag/voice";

const port = Number(process.env.PORT ?? 3000);
const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function required(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required env var ${name} (see .env.example)`);
    process.exit(1);
  }
  return value;
}

const apiKey = required("OPENROUTER_API_KEY");
const openRouter = (model) => ({ apiKey, model });

const providers = {
  stt: new OpenRouterSpeechToText(
    openRouter(process.env.STT_MODEL ?? "openai/gpt-4o-mini-transcribe")
  ),
  llm: new OpenRouterLanguageModel(
    openRouter(process.env.LLM_MODEL ?? "mistralai/ministral-8b-2512")
  ),
  tts: new OpenRouterTextToSpeech({
    ...openRouter(process.env.TTS_MODEL ?? "deepgram/aura-2"),
    voice: process.env.TTS_VOICE ?? "aura-2-thalia-en",
    sampleRate: Number(process.env.TTS_PCM_RATE ?? 24000),
  }),
};

const config = {
  publicHost: process.env.PUBLIC_HOST ?? `localhost:${port}`,
  systemPrompt: process.env.SYSTEM_PROMPT ?? "You are a friendly phone assistant.",
  lines: {
    greeting: process.env.GREETING ?? "",
    outboundGreeting: process.env.OUTBOUND_GREETING ?? process.env.GREETING ?? "",
    identify: process.env.IDENTIFY_MESSAGE ?? "",
    voicemail: process.env.VOICEMAIL_MESSAGE ?? "",
    farewell: process.env.FAREWELL_MESSAGE ?? "Thanks for your time. Goodbye.",
  },
  detector: {
    speechRms: Number(process.env.SPEECH_RMS ?? 500),
    noiseMultiplier: Number(process.env.NOISE_MULTIPLIER ?? 3),
    silenceHangMs: Number(process.env.SILENCE_HANG_MS ?? 700),
    bargeInFrames: Math.max(1, Math.round(Number(process.env.BARGE_IN_MS ?? 100) / 20)),
    bargeInMultiplier: Number(process.env.BARGE_IN_MULTIPLIER ?? 1.5),
  },
  language: process.env.STT_LANGUAGE ?? "en",
  waitForHello: (process.env.WAIT_FOR_HELLO ?? "true") !== "false",
  fillerDelayMs: Number(process.env.FILLER_DELAY_MS ?? 500),
  recordDir:
    process.env.RECORD_CALLS === "false"
      ? null
      : path.resolve(process.env.RECORD_DIR ?? path.join(rootDir, "recordings")),
};

// Rendered in the background so the server takes calls straight away; a call
// that starts before they are ready simply runs without fillers.
let fillers = null;
const fillerPhrases = process.env.FILLER_PHRASES
  ? process.env.FILLER_PHRASES.split("|").map((phrase) => phrase.trim())
  : undefined;
createFillerBank(providers.tts, fillerPhrases)
  .then((bank) => {
    fillers = bank;
    console.log(`  fillers  ${bank ? `${bank.size} clips ready` : "none rendered"}`);
  })
  .catch((err) => console.warn(`[filler] ${err.message}`));

// --- NoLag coordination (optional; the call works without it) ---------------
const nolag = {
  token: process.env.NOLAG_ACCESS_TOKEN,
  url: process.env.NOLAG_URL ?? "wss://broker.nolag.app/ws",
  appSlug: process.env.NOLAG_APP ?? "voice-calls",
  apiKey: process.env.NOLAG_API_KEY,
  apiUrl: process.env.NOLAG_API_URL,
};

let provisioner = null;
if (nolag.token && nolag.apiKey) {
  provisioner = await createRoomProvisioner({
    apiKey: nolag.apiKey,
    apiUrl: nolag.apiUrl,
    appSlug: nolag.appSlug,
  }).catch((err) => {
    console.warn(`[nolag] coordination disabled: ${err.message}`);
    return null;
  });
  if (provisioner) console.log(`[nolag] coordination ready for app ${nolag.appSlug}`);
} else {
  console.warn("[nolag] NOLAG_ACCESS_TOKEN or NOLAG_API_KEY missing, coordination disabled");
}

/**
 * One long-lived connection to the orchestrator room, shared by every call.
 *
 * Opened at startup rather than per call for two reasons. The room is static,
 * so it already existed when this connection authenticated, which is the rule
 * that forces a per-call connection for per-call rooms. And presence needs a
 * moment to settle: asking who is out there in the same tick as joining reports
 * an empty room, and the first caller of the day would be told nobody can help.
 *
 * Deliberately NOT load balanced. This process joins the room to dispatch, and
 * the Agents SDK subscribes every joined room to `tasks` whether or not
 * anything handles them, so putting a voice server in the orchestrator pool
 * would hand it tasks it silently drops.
 */
let orchestrator = null;
if (nolag.token && (process.env.ORCHESTRATOR ?? "true") !== "false") {
  try {
    // Static in the blueprint, but an app created from an earlier version of it
    // will not have the room, and the broker rejects rooms it has never been
    // told about. Idempotent, so it costs nothing when it is already there.
    await provisioner?.ensureRoom(ORCHESTRATOR_ROOM);

    // A workaround for a broker bug, not a design rule.
    //
    // Measured on dev on 2026-08-30: once a second connection authenticates as
    // the same actor, publishes stop being acknowledged on BOTH connections
    // ("was not acknowledged within 10000ms") and are never delivered. The
    // survivor does not recover when the other disconnects; the actor only
    // works again once all of its connections have gone.
    //
    // Sharing a token across connections is supposed to be fine, and load
    // balancing is built on it: the load-balance group defaults to the actor
    // token id, so a pool sharing one token is the documented way to share
    // work. Until this is fixed, the link takes a token of its own, because
    // calls open a connection each and would otherwise break it on the second
    // concurrent call.
    const linkToken = process.env.VOICE_LINK_TOKEN ?? nolag.token;
    if (linkToken === nolag.token) {
      console.warn(
        "[orchestrator] VOICE_LINK_TOKEN is unset, so this link shares an actor " +
          "with the per-call connections. Asks will stop being delivered as soon " +
          "as a call opens its own connection."
      );
    }
    const client = NoLag(linkToken, { url: nolag.url });
    client.on("error", (err) => console.error("[orchestrator]", err?.message ?? err));
    await client.connect();

    const agents = new NoLagAgents({
      client,
      appName: nolag.appSlug,
      // Unique per process. Answers are published with a filter on this id, so
      // two servers sharing one would deliver each other's answers to the
      // wrong call, and every ask would time out despite the work being done.
      agentId: `voice-${process.env.HOSTNAME ?? "host"}-${process.pid}`,
      role: "agent",
      rooms: [ORCHESTRATOR_ROOM],
    });
    await agents.ready();

    orchestrator = new NoLagVoice({ agents }).orchestrator();
    const capabilities = await orchestrator.ready();
    console.log(
      capabilities.length
        ? `[orchestrator] ${capabilities.join(", ")} available in ${ORCHESTRATOR_ROOM}`
        : `[orchestrator] nobody in ${ORCHESTRATOR_ROOM} yet, calls will run unaided`
    );
  } catch (err) {
    console.warn(`[orchestrator] disabled: ${err.message}`);
    orchestrator = null;
  }
}

/**
 * A call's room has to exist before this connection authenticates, so each
 * call gets its own connection opened straight after the room is created.
 */
async function joinCallRoom(callId, handlers) {
  if (!provisioner) return null;
  const roomSlug = callRoomSlug(callId);
  await provisioner.ensureRoom(roomSlug);

  const client = NoLag(nolag.token, { url: nolag.url });
  client.on("error", (err) => console.error("[nolag]", err?.message ?? err));
  await client.connect();

  // The application owns the agents instance and its version; @nolag/voice is
  // handed one rather than reaching for its own.
  const agents = new NoLagAgents({
    client,
    appName: nolag.appSlug,
    agentId: `call-${roomSlug}`,
    role: "agent",
    rooms: [roomSlug],
  });
  await agents.ready();

  const voice = new NoLagVoice({ agents });
  const publisher = voice.publishCall(callId, handlers);
  return {
    publisher,
    close: () => {
      agents.detach();
      client.disconnect();
    },
  };
}

/**
 * Fans a call's events out to several observers: the console, the recorder,
 * and the NoLag room. Targets can be added after the call starts, because the
 * room takes a moment to join, and one failing observer must not take the call
 * down with it.
 */
class Fanout {
  constructor() {
    this.targets = [];
  }
  add(target) {
    if (target) this.targets.push(target);
  }
  emit(method, ...args) {
    for (const target of this.targets) {
      try {
        target[method]?.(...args);
      } catch (err) {
        console.error(`[observer] ${method}: ${err.message}`);
      }
    }
  }
  onCallStarted(info) {
    this.emit("onCallStarted", info);
  }
  onCallEnded(reason) {
    this.emit("onCallEnded", reason);
  }
  onCallerAudio(frame) {
    this.emit("onCallerAudio", frame);
  }
  onAgentAudio(samples) {
    this.emit("onAgentAudio", samples);
  }
  onCallerSpeech(text, meta) {
    this.emit("onCallerSpeech", text, meta);
  }
  onAgentSpeech(text, meta) {
    this.emit("onAgentSpeech", text, meta);
  }
  onScreening(kind, turn) {
    this.emit("onScreening", kind, turn);
  }
  onBargeIn() {
    this.emit("onBargeIn");
  }
  onTurnComplete(metrics) {
    this.emit("onTurnComplete", metrics);
  }
  onError(error) {
    this.emit("onError", error);
  }
}

// --- HTTP + media -----------------------------------------------------------
const app = express();
app.use(express.urlencoded({ extended: false }));
app.get("/health", (_req, res) => res.json({ ok: true }));

const escapeXml = (value) =>
  String(value).replace(/[<>&'"]/g, (c) =>
    ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c]
  );

app.post("/voice", (req, res) => {
  // On an outbound call the person we are talking to is the To number; on an
  // inbound one it is the From number. src/call.js flags which.
  const outbound = req.query.outbound === "1";
  const peer = escapeXml((outbound ? req.body?.To : req.body?.From) ?? "unknown");
  console.log(`[webhook] ${outbound ? "outbound to" : "inbound from"} ${peer}`);
  res.type("text/xml").send(
    `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="wss://${config.publicHost}/media">
      <Parameter name="peer" value="${peer}" />
      <Parameter name="outbound" value="${outbound ? "1" : "0"}" />
    </Stream>
  </Connect>
</Response>`
  );
});

// The simulator page ships with the engine, so it stays in step with the
// protocol the engine speaks rather than drifting in an example.
app.get("/simulator", (_req, res) =>
  res.sendFile(fileURLToPath(import.meta.resolve("@nolag/voice-engine/simulator.html")))
);

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/media" });

wss.on("connection", (socket) => {
  const transport = new TwilioMediaStreamTransport({ socket });
  const fanout = new Fanout();
  let room = null;

  // The model is swapped for an orchestrator-aware wrapper once the call id is
  // known, and the wrapper needs the session, which does not exist yet. Read
  // through a getter rather than untangling that: the session reads `llm` on
  // every turn, and no turn can happen before the call has started.
  const callProviders = {
    stt: providers.stt,
    tts: providers.tts,
    llm: providers.llm,
  };

  // Note the session owns the transport's handlers, so everything the server
  // wants to know about the call comes through the observer instead. Setting
  // another transport.onStart here would quietly replace the session's own and
  // the call would never be greeted.
  const session = new VoiceSession({
    transport,
    providers: callProviders,
    systemPrompt: config.systemPrompt,
    lines: config.lines,
    detector: config.detector,
    language: config.language,
    waitForHello: config.waitForHello,
    fillerDelayMs: config.fillerDelayMs,
    // Read late: the bank finishes rendering after the server starts listening.
    get fillers() {
      return fillers;
    },
    observer: fanout,
  });

  fanout.add({
    onCallStarted(info) {
      console.log(`[call ${info.callId}] ${info.outbound ? "dialled" : "from"} ${info.peer}`);
      fanout.add(logObserver(info.callId));

      // Robin can now ask a colleague. Turns that do not need one are
      // untouched, including the streaming that starts speech on the first
      // finished sentence.
      if (orchestrator) {
        callProviders.llm = orchestratedModel({
          model: providers.llm,
          bridge: orchestrator,
          floor: session,
          callId: info.callId,
          graceMs: Number(process.env.ORCHESTRATOR_GRACE_MS ?? 1200),
          lines: {
            acknowledge: "Let me check that for you, one moment.",
            stall: [
              "Still checking on that.",
              "The system is a bit slow today, bear with me.",
            ],
          },
          onAsk: (event) =>
            console.log(
              `[call ${info.callId}] asked (${event.outcome} after ${event.waitedMs}ms): ${event.question}`
            ),
        });
      }

      if (config.recordDir) {
        const recorder = createRecorder({ dir: config.recordDir, callId: info.callId });
        console.log(`[call ${info.callId}] recording to ${recorder.base}.*`);
        fanout.add(recorder);
      }

      joinCallRoom(info.callId, {
        onSay: (text) => session.say(text),
        onInstruct: (text) => session.instruct(text),
      })
        .then((joined) => {
          if (!joined) return;
          room = joined;
          // Joining the room takes a moment, so replay the event it missed.
          joined.publisher.onCallStarted(info);
          fanout.add(joined.publisher);
        })
        .catch((err) => console.error(`[nolag] ${info.callId}: ${err.message}`));
    },
  });

  socket.on("close", () => {
    session.close("socket closed");
    room?.close();
  });
});

function logObserver(callId) {
  return {
    onCallerSpeech: (text) => console.log(`[call ${callId}] caller: ${text}`),
    onAgentSpeech: (text, meta) =>
      console.log(`[call ${callId}] ${meta.kind === "filler" ? "filler" : "agent"}: ${text}`),
    onScreening: (kind) => console.log(`[call ${callId}] screener: ${kind}`),
    onBargeIn: () => console.log(`[call ${callId}] barge-in`),
    onTurnComplete: (m) =>
      console.log(
        `[call ${callId}] turn ${m.totalMs}ms (stt ${m.sttMs}ms, llm ${m.llmMs}ms, ` +
          `speaking at ${m.firstAudioMs ?? "never"}ms after llm start, ${m.clips} clips)`
      ),
    onCallEnded: (reason) => console.log(`[call ${callId}] ended: ${reason}`),
    onError: (err) => console.error(`[call ${callId}] error: ${err.message}`),
  };
}

server.listen(port, () => {
  console.log(`Robin listening on :${port}`);
  console.log(`  webhook   POST https://${config.publicHost}/voice`);
  console.log(`  media     wss://${config.publicHost}/media`);
  console.log(`  simulator http://localhost:${port}/simulator`);
  console.log(`  models    stt=${process.env.STT_MODEL} llm=${process.env.LLM_MODEL} tts=${process.env.TTS_MODEL}`);
});
