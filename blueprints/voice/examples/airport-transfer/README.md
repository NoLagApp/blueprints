# Voice Agent Example

An AI agent that answers real phone calls, with NoLag as the live coordination layer.

Twilio delivers the call audio over a WebSocket. OpenRouter handles all three AI legs with a single API key: speech-to-text, the LLM reply (Ministral 8B by default, fast and cheap), and text-to-speech. NoLag turns every call into its own coordination room, so any other client, human or agent, can watch the call live and steer it while it is happening.

```
 caller ── PSTN ── Twilio ── POST /voice ───────────► server (TwiML reply)
                      │
                      └── wss://HOST/media ─────────► CallSession
                              ▲        │                 │
                              │        │ mu-law 8k       │ per utterance:
                        audio │        ▼                 │  1. OpenRouter STT
                        back  │      VAD buffers         │  2. OpenRouter LLM
                              │      an utterance        │  3. OpenRouter TTS
                              │                          ▼
                              └───────────────── NoLag room (one per call)
                                                   @nolag/agents:
                                                     Observe -> live transcript
                                                     Inbox   <- steering
                                                         ▲
                                    monitor CLI / dashboard / other agents
```

The coordination layer is the [`@nolag/agents`](https://www.npmjs.com/package/@nolag/agents) SDK rather than raw pub/sub. Each call joins its own room as an agent with a predictable id (`call-<callsid>`) and uses two of the SDK's patterns:

- **Observe** carries the live event stream out: every transcript line, per-leg latency, and call lifecycle.
- **Inbox** carries steering in: anything addressed to the call's agent id is acted on mid-conversation.

The Twilio and OpenRouter parts are plumbing any voice bot needs. The NoLag part is what makes it interesting: the phone call becomes a realtime room that the rest of your system can participate in.

## Prerequisites

- Node 18+
- A Twilio account with a phone number
- An [OpenRouter](https://openrouter.ai) API key
- A NoLag project (optional but recommended, it is the point of the example)
- [ngrok](https://ngrok.com) or any public HTTPS/WSS tunnel for local dev

## Setup

### 1. NoLag

In the [NoLag dashboard](https://app.nolag.app):

1. Create an app from the **Agents** blueprint. That gives it the topic schema this example needs (`tasks`, `results`, `state`, `events`, `inbox`, `tools`, `approval`).
2. Copy the app's real slug into `NOLAG_APP`. NoLag appends four random characters to every app slug, so asking for `voice-calls` gets you something like `voice-calls-56c2`. Room slugs are stored exactly as given, so only the app slug is affected.
3. Enable per-call rooms on the app by setting `config.autoProvisionRooms` to `true`:

   ```bash
   curl -X PATCH https://api.nolag.app/v1/apps/<appId> \
     -H "Authorization: Bearer $NOLAG_API_KEY" \
     -H "Content-Type: application/json" \
     -d '{"config":{"autoProvisionRooms":true}}'
   ```

4. Create **two** actor tokens: one for the server (`NOLAG_ACCESS_TOKEN`) and one for the monitor (`NOLAG_MONITOR_TOKEN`). They must be different actors, see the note below.
5. Create a project API key (`nlg_live_...`) for `NOLAG_API_KEY`.

Rooms are created one per call, named after the lowercased Twilio CallSid. Two platform rules drive that design, and hitting either one looks like silence rather than an error:

- **A room must exist before anyone uses it.** The broker never creates rooms implicitly; publishing to an unknown room returns `unknown_topic`. The server creates each call's room through the control plane, which is why `NOLAG_API_KEY` is required for coordination.
- **A connection only sees rooms that existed when it authenticated.** A long-lived connection cannot reach a room created later, so each call opens its own connection after its room exists. Twilio already gives one WebSocket per call, so this matches the shape of the problem.

::: warning The monitor needs its own actor
The broker does not deliver a message back to the actor that published it. If the monitor reuses the server's token it will connect happily and display nothing at all.
:::

### 2. Environment

```bash
cd blueprints/voice/examples/airport-transfer
yarn install
cp .env.example .env   # then fill it in
```

### 3. Tunnel and Twilio

Twilio has to reach this server from the public internet, both for the webhook and for the audio WebSocket, so a tunnel is required for real calls. Either of these works:

```bash
ngrok http 3000
# or, with no account needed:
cloudflared tunnel --url http://localhost:3000
```

Put the tunnel hostname (no protocol, no trailing slash) in `PUBLIC_HOST`, restart the server so the TwiML advertises the right address, then in the Twilio console point your phone number's Voice webhook at `https://<PUBLIC_HOST>/voice` (HTTP POST).

Both tunnels hand out a new hostname each run, so `PUBLIC_HOST` and the Twilio webhook have to be updated whenever you restart one.

### 4. Calling out

The agent can also place the call:

```bash
yarn call +61400000000
```

That needs `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` and `TWILIO_NUMBER` in `.env`, plus a public `PUBLIC_HOST`. Twilio dials the number and hands the answered call to the same pipeline, so everything after "hello" is identical to an inbound call. `OUTBOUND_GREETING` is spoken instead of `GREETING`, since an agent that rang you should say why.

Only call numbers you own or have consent to call, and note that Twilio trial accounts can only dial numbers you have verified in the console. The default greeting states that the caller is talking to an AI in its first sentence; keep it that way. Disclosure is a legal requirement in many places and Twilio's own AI terms require informed consent for real-time transcription.

### 5. Run

```bash
yarn start
```

Call your Twilio number. You should hear the greeting, then talk to the agent.

## Testing without a phone: the call simulator

You do not need Twilio, a phone number, or a tunnel to try the agent. With the server running, open:

```
http://localhost:3000/simulator
```

Click **Start call** and talk. The page captures your microphone, encodes it to mu-law 8 kHz in 20 ms frames, and speaks the exact Twilio Media Streams protocol (`connected`, `start`, `media`, `mark`, `clear`, `stop`) at the same `/media` WebSocket the real calls use, so the server cannot tell it apart from Twilio. Agent audio plays back through your speakers, barge-in included.

Notes:

- Use headphones, otherwise the agent hears itself through your mic.
- Open it via `localhost` (mic access requires a secure context).
- The page shows a live mic RMS meter with a marker at the server's `SPEECH_RMS` floor (500). The real threshold adapts upward to your room's noise, so in a noisy room it sits above that marker. If the agent keeps replying to nothing, raise `NOISE_MULTIPLIER`; if it never hears you, lower it.
- Simulated calls get a `SIM...` CallSid and a NoLag room like any real call, so `yarn monitor <callsid>` works the same (the page shows the exact command).
- Only `OPENROUTER_API_KEY` is required; `PUBLIC_HOST` and the NoLag vars are optional for simulator runs.

## Watching and steering a live call

The server logs the CallSid when a call starts. In another terminal:

```bash
yarn monitor CAxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

You will see the transcript stream in with per-leg latency numbers. Type a line and the agent speaks it to the caller mid-conversation. Prefix with `!` to silently inject a system instruction into the LLM context instead:

```
CALLER | what time do you close?
!we close at 5pm on weekdays and are shut on weekends
AGENT  | We close at 5 PM on weekdays and we're closed on weekends.
```

The monitor joins the call's room as a `human` agent, reads the stream through `Observe`, and steers by sending to the call agent's `Inbox`. It never talks to Twilio or OpenRouter. It only holds a NoLag connection, which is exactly what a supervisor dashboard, an escalation agent, or a CRM logger would do.

## The orchestrator: one async tool

Robin has about a second to reply, which buys a small model with no tools. That
is the right trade for conversation and the wrong one for deciding whether a
booking can be moved, so left alone she will say "I have updated that for you"
while nothing has changed.

`src/orchestrator.js` is the other half: a separate process with a larger model,
real tools, and as long as it needs. Run it alongside the server.

```bash
npm run orchestrator   # in one terminal
npm start              # in another
```

Then ask something she cannot know:

```
CALLER | Hi Robin, it's Alex. My flight landed early, can you move my pickup?
AGENT  | Let me check that for you, one moment.          <- the wait, made audible
AGENT  | Still checking on that.
AGENT  | Yes, I can move your airport pickup earlier. You're currently booked
         for three forty pm, and I have one fifteen pm or one forty-five pm.
```

Three things are worth noticing in that exchange.

**She has exactly one tool.** Not twenty. A small model handed twenty tools has
to choose between them, and choosing badly is where small models fail. Handed
one, its only judgement is "do I need help, and how do I phrase it". Which of
the orchestrator's four tools to reach for is decided by the orchestrator, which
is big enough to decide well.

**The asking is asynchronous, and that is the feature.** Two tool calls against a
large model took 7.8 seconds in that run. Nothing survives being nested inside a
turn on a live phone call. So if the answer does not arrive within
`ORCHESTRATOR_GRACE_MS`, the turn ends, Robin says she is looking into it, and
the answer is spoken whenever it lands, in a gap. Answers that come back fast
enough are folded into the reply and the caller never learns anything was asked.

**The answer waits for a gap.** It is never spliced into whatever is playing, and
never spoken over the caller, because there is one audio buffer to the far end.
If the floor never frees it is dropped rather than said late.

### Each process needs its own actor token

Both of the following present as an ask that simply times out, with everything
else looking healthy:

- The broker never delivers a message back to the actor that published a
  message. An orchestrator sharing a token with the call server is the same
  actor, so it never sees a task at all.
- Two live connections on one actor token stop being acknowledged on both
  (observed on dev, 2026-08-30). Calls open a connection each, so the server's
  link to the orchestrator room needs `VOICE_LINK_TOKEN` of its own.

```bash
curl -X POST "$NOLAG_API_URL/actors" \
  -H "Authorization: Bearer $NOLAG_API_KEY" -H 'Content-Type: application/json' \
  -d '{"name":"orchestrator","actorType":"service"}'
```

### Replacing the tools

`TOOLS` in `src/orchestrator.js` is an in-memory booking store. Replace the
bodies and keep the shape. One of them is worth copying as-is: references are
spelled out loud and mistranscribed constantly ("TR-4417" arrives as "TR4417" or
"PR4417"), so looking a customer up by name beats looking them up by reference.

## Model choices

Everything is env-configurable:

| Env var | Default | Notes |
|---|---|---|
| `LLM_MODEL` | `mistralai/ministral-8b-2512` | Fast and cheap, good voice latency. Try `mistralai/ministral-3b-2512` for cheaper, `z-ai/glm-4.6` for smarter. |
| `STT_MODEL` | `openai/gpt-4o-mini-transcribe` | Any model on the [OpenRouter STT list](https://openrouter.ai/collections/speech-to-text-models). |
| `TTS_MODEL` | `deepgram/aura-2` | Must support `response_format: "pcm"` (Mistral's voxtral TTS is mp3-only and will not work). Chosen for time-to-first-byte, not price: it starts returning audio in well under a second, while `hexgrad/kokoro-82m` (cheaper, voice `af_heart`) renders the whole clip before sending anything and `google/gemini-3.1-flash-tts-preview` (voice `Kore`) is slower again. |
| `TTS_VOICE` | `aura-2-thalia-en` | Voices are model-specific; check the model's page on OpenRouter. |
| `TTS_PCM_RATE` | `24000` | Sample rate of the raw PCM your TTS model returns. Kokoro, Aura and Gemini TTS all use 24000. |

## How it works, briefly

- **Webhook is HTTP, audio is WebSocket.** Twilio's incoming-call event can only arrive as an HTTP request. The TwiML response hands the call to `<Connect><Stream>`, which opens the bidirectional Media Streams WebSocket (G.711 mu-law, 8 kHz, 20 ms frames, base64 in JSON).
- **Utterance detection** (`src/vad.js`) is an RMS energy gate with a 700 ms silence hangover. It measures the background level continuously and requires speech to exceed it by `NOISE_MULTIPLIER`, so it adapts to the room instead of relying on one hardcoded number. The bar is raised further while the agent is speaking, so a cough does not cut it off mid-sentence.
- **Noise rejection.** Two things stop background noise becoming conversation. `STT_LANGUAGE` pins transcription to one language, because an unconstrained model hands back confident nonsense in a random language when given noise. Then transcripts that are a single character, or a stock filler phrase carried on weak audio, are discarded before reaching the LLM.
- **Barge-in**: if the caller speaks while the agent is talking, the session sends Twilio a `clear` event to flush buffered audio and aborts any in-flight OpenRouter requests. Two details make the difference between this working and quietly never firing. It is judged on sustained loud speech rather than on "an utterance just started", because an utterance is usually already open by the time the agent speaks and the start transition never comes again. And the noise floor is frozen while the agent talks, since its own voice leaking back through the caller's speakers would otherwise raise the floor, raise the threshold, and make interrupting harder the longer it spoke.
- **Filler speech** (`src/fillers.js`) covers the wait. Once the caller's words are transcribed, the answer is still a language model call plus a speech synthesis call away, so if it has not started within `FILLER_DELAY_MS` the agent says something like "let me have a look" and the answer follows straight after. The clips are rendered once at startup and cached as mu-law, because synthesising one on demand would add exactly the delay it is meant to hide. Fillers are scheduled only after a transcript survives the noise check, so background noise never triggers one.
- **Call screeners and voicemail** (`src/screening.js`). A lot of mobiles now answer with an assistant that asks who is calling and relays it. Left alone, the model treats that robot as the client: it greets it by name and starts confirming booking details to whatever picked up. Those turns are recognised by pattern and answered from a script instead, so a screener is told who is calling and why and nothing more, a request to hold is met with silence, and voicemail gets a self-contained message followed by a hang-up. Pattern matching rather than an extra model call, because it costs nothing, cannot hallucinate, and these systems are highly formulaic.
- **Ending the call.** When the caller says goodbye, the agent says goodbye and hangs up rather than answering once more and leaving them to hang up on it. The farewell patterns are written to ignore "by the way" and "go over that again", which are the obvious traps.
- **Recording** (`src/recorder.js`). Each call writes `<callsid>-caller.wav`, `<callsid>-agent.wav`, a `.jsonl` event log and a readable `.txt` transcript into `recordings/`. Audio is streamed to disk, so a long call costs no more memory than a short one, and the WAV header is patched on close once the length is known. The two tracks are kept time-aligned by padding the agent track with silence up to the caller's clock; the agent track can run slightly ahead, since audio is written when it is sent rather than when it is heard. Set `RECORD_CALLS=false` to disable. Recordings contain personal data and usually need the consent of everyone on the call.
- **Turn-taking** is serialised per call, and the last 24 messages of history are kept as LLM context. A turn can have several clips of audio in flight (a filler, then the answer), so the agent counts outstanding playback marks rather than treating any single mark as "done speaking".
- **Audio conversion** (`src/audio.js`) is hand-rolled G.711 plus a linear-interpolation resampler. Fine for telephone audio, not for hi-fi.

## Latency expectations

What matters is not how long a turn takes but how long the caller waits in silence. Measured against the defaults, the agent starts speaking about 1.5 to 1.9 seconds after the caller stops, and roughly 700ms of that is the VAD's silence hangover:

```
turn 4409ms (stt 724ms, llm 809ms, speaking at 1536ms after llm start, 2 clips)
```

Every turn emits those numbers as a `call.turn-complete` event, so the monitor shows you where the time goes on a real call.

Three things get it there, and the order of their importance is not obvious:

1. **Audio is forwarded as it is synthesised.** This is by far the biggest win, and it is really a model choice: Aura returns its first bytes in under a second, where other models render the entire clip before sending anything and the caller hears nothing for about three seconds regardless of what the code does.
2. **The reply is streamed and speaking starts on the first finished sentence**, so synthesis overlaps the model still writing.
3. **Filler speech covers whatever is left.**

One measurement worth keeping in mind if you tune this further: synthesis latency is dominated by fixed per-request overhead, not by how much text you send. Ninety characters and a hundred and eighty characters take about the same time. That is why the code speaks the first sentence and then sends the entire remainder as one request rather than one request per sentence, and why splitting a reply into many small clips makes things slower, not faster.

The remaining costs are the 700ms hangover before transcription even starts, and non-streaming STT. Moving to a streaming transcription provider with proper endpointing is the next real gain.

## Costs and terms

Every leg goes through OpenRouter under your key, and call audio transits Twilio plus the STT/TTS model vendors. If you deploy anything like this for real, you are responsible for caller disclosure and consent (Twilio's AI terms require informed consent for real-time transcription). Announce the AI in the greeting, as the default one does.
