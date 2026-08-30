# @nolag/voice

A live phone call, as a NoLag room.

While a call is happening it publishes its transcript and timings into a room of
its own, and accepts steering from anything else in that room. A supervisor can
watch a conversation as it unfolds and type a line the agent speaks to the
caller, seconds later, without touching the telephony or the models.

```bash
npm install @nolag/js-sdk @nolag/agents @nolag/voice
```

This package is small on purpose. The real-time audio work belongs to
[`@nolag/voice-engine`](https://www.npmjs.com/package/@nolag/voice-engine); this
is only the part that makes a call something other software can join.

## Why a call needs a room

A voice agent on its own is a fast talker with no knowledge and no hands. The
model answering the phone has roughly a second to reply, which means it is small
and cheap, which means it is the wrong thing to decide whether a booking can be
moved. It also has no tools, so it will happily say "I have updated that for
you" while nothing has changed anywhere.

The work that matters runs on a different clock. Looking a customer up, changing
a record, waiting for a human to approve a refund: five to thirty seconds,
sometimes minutes. None of that fits inside a one second budget, so it cannot
live inside the call. It has to be something the call talks to.

That is what the room is for:

```
                                      ┌── orchestrator      knowledge, tools,
                                      │   (seconds)         database, approvals
  caller ──audio── voice agent ── room ┼── human supervisor  watches, steers, approves
                   (about 1s)         │
                                      └── dashboards        transcript, latency, logging
```

The voice agent keeps the conversation alive while something more capable does
the actual work, and the engine's filler speech ("let me check that for you")
is exactly the cover for that wait.

Everything you need for the orchestrator side is already in
[`@nolag/agents`](https://www.npmjs.com/package/@nolag/agents), on the same
room: `Handoff` to dispatch work by capability, `Tools` to invoke something
running in your own systems, `Approve` to gate an action on a human, and
`Blackboard` for shared state. This package puts the call in that room; those
patterns are how it reaches out from it.

Two things worth building in from the start. Use presence to check a capability
exists before promising it, so the agent stops claiming to have done things
nothing can do. And keep the models split: fast and cheap in the conversation,
strong and slow in the orchestrator, which is both better and cheaper than one
model trying to be both.

## Publishing a call

A call publishes itself. `publishCall` returns an object shaped exactly like the
engine's session observer, so it can be handed straight over and the call
streams itself into the room.

```ts
import { NoLag } from "@nolag/js-sdk";
import { NoLagAgents } from "@nolag/agents";
import { NoLagVoice, createRoomProvisioner, callRoomSlug } from "@nolag/voice";
import { VoiceSession } from "@nolag/voice-engine";

const provisioner = await createRoomProvisioner({
  apiKey: process.env.NOLAG_API_KEY,   // project key, nlg_live_...
  appSlug: process.env.NOLAG_APP,      // the real slug, random suffix included
});

async function onCall(transport, callId, providers, systemPrompt) {
  const roomSlug = callRoomSlug(callId);

  // The room has to exist before the connection that will use it authenticates.
  await provisioner.ensureRoom(roomSlug);

  const client = NoLag(process.env.NOLAG_ACCESS_TOKEN, { url: process.env.NOLAG_URL });
  await client.connect();

  // Your application owns the agents instance and its version. Several wrappers
  // can share one, and upgrading @nolag/agents is a change in a single place.
  const agents = new NoLagAgents({
    client,
    appName: process.env.NOLAG_APP,
    agentId: `call-${roomSlug}`,
    role: "agent",
    rooms: [roomSlug],
  });
  await agents.ready();

  const voice = new NoLagVoice({ agents });

  let session;
  const publisher = voice.publishCall(callId, {
    onSay: (text) => session.say(text),           // speak this to the caller now
    onInstruct: (text) => session.instruct(text), // silent guidance for the model
  });

  session = new VoiceSession({ transport, providers, systemPrompt, observer: publisher });

  return () => {
    agents.detach();      // you created the instance, so you release it
    client.disconnect();
  };
}
```

Recording and logging are observers too, so fan out to several rather than
choosing between them.

## Watching and steering

Anything with room access can do this, including a browser dashboard.

```ts
const watcher = voice.watchCall(callId, {
  onTranscript: (line) => {
    // { role: "caller" | "agent", text, kind?, sttMs?, llmMs?, at }
    // kind is "greeting", "reply", "filler", "scripted" or "injected"
    render(line.role, line.text);
  },
  onEvent: (event) => {
    // { event, at, ...detail }
    // call-started, call-ended, screening-detected, barge-in, turn-complete, error
    if (event.event === "turn-complete") showLatency(event.totalMs, event.firstAudioMs);
  },
});

watcher.say("Let them know we can hold the car until 2pm.");
watcher.instruct("Only discuss today's booking.");
```

`say` is spoken to the caller immediately and remembered as something the agent
said. `instruct` is never spoken: it is guidance the model sees from its next
turn onward, which is what you want for "stop offering refunds" or "keep it
brief".

## API

### `new NoLagVoice({ agents })`

Takes an already-constructed, connected `NoLagAgents`. It never builds one, so
your application owns the instance, its identity, its rooms and its lifetime.

| Member | Returns | |
|---|---|---|
| `publishCall(callId, handlers?)` | `CallPublisher` | Publishes the call and accepts steering. |
| `watchCall(callId, handlers?)` | `CallWatcher` | Streams the call and can steer it. |
| `agentsInstance` | `NoLagAgents` | The injected wrapper, if you need the rest of it. |

`publishCall` handlers are `{ onSay, onInstruct }`. `watchCall` handlers are
`{ onTranscript, onEvent }`. Neither handle has a `detach()`: you detach the
agents instance you created.

`CallPublisher` implements `onCallStarted`, `onCallEnded`, `onCallerSpeech`,
`onAgentSpeech`, `onScreening`, `onBargeIn`, `onTurnComplete` and `onError`,
which is exactly the engine's observer shape.

### `createRoomProvisioner({ apiKey, appSlug, apiUrl? })`

Creates a call's room through the control plane. Returns `{ appId, ensureRoom }`,
where `ensureRoom(slug)` is idempotent and safe to call for a room that already
exists. `apiUrl` defaults to production; override it for other environments.

It fails loudly and specifically, because each failure is a setup mistake that
otherwise presents as silence: an app slug that does not exist (it lists the
ones that do, since the usual cause is a slug copied without its random suffix),
an app with `autoProvisionRooms` disabled, and an app whose schema is missing
topics.

### Helpers

`callRoomSlug(callId)` lowercases a call id into a room slug. `callAgentId(callId)`
derives the call's agent id, which is what makes steering possible with no prior
handshake: a supervisor can address a call knowing only its id, because both
sides derive the same name. `VOICE_TOPICS` is the topic list a call's room needs.

## Setting up the app

Create the app from the Voice or Agents blueprint. Either gives the topics this
uses: `events` carries the stream out, `inbox` carries steering in, and `tasks`,
`results`, `state`, `tools` and `approval` are there for when the call needs to
reach the rest of your system.

Then enable per-call rooms:

```bash
curl -X PATCH https://api.nolag.app/v1/apps/<appId> \
  -H "Authorization: Bearer $NOLAG_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"config":{"autoProvisionRooms":true}}'
```

Create **two** actor tokens, one for the call and one for anything watching.

## Three rules that fail silently

All three present as nothing happening rather than as an error, which is why
they are worth reading before you have to debug them.

**A room must exist before anyone touches it.** The broker never creates rooms
implicitly, so a call's room is created through the control plane first. That is
what `ensureRoom` is for, and why `NOLAG_API_KEY` is needed at all.

**A connection only sees rooms that existed when it authenticated.** A
long-lived connection cannot reach a room created later, so each call opens its
own connection after `ensureRoom` resolves. That costs nothing in practice:
telephony already gives one socket per call.

**A watcher needs its own actor token.** The broker never delivers a message
back to the actor that published it, so a dashboard sharing the call's token
connects perfectly happily and then displays nothing at all.

## Licence

MIT
