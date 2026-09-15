import { describe, it, expect, beforeEach } from 'vitest';
import { NoLagChat } from '../../src/NoLagChat';
import { makeFakeClient, FakeNoLagClient } from '../helpers/fakeNoLagClient';

/**
 * Filter API contract for @nolag/chat.
 *
 * Filters are server-side routing: each value is an MQTT sub-topic, so a
 * filtered subscriber only receives publishes tagged with a matching value.
 * chat treats `messages` and `_stream` as one logical channel — a filtered
 * stream must reach exactly the audience its final message does.
 */

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

const PREFIX = 'chat-app/general';

function makeChat(client: FakeNoLagClient) {
  return new NoLagChat({ client: client as never, username: 'Alice', appName: 'chat-app' });
}

async function connectedChat() {
  const client = makeFakeClient();
  const chat = makeChat(client);
  client.fireConnect('actor-1');
  await flush();
  return { client, chat };
}

describe('@nolag/chat filters', () => {
  let client: FakeNoLagClient;
  let chat: NoLagChat;

  beforeEach(async () => {
    ({ client, chat } = await connectedChat());
  });

  it('subscribes unfiltered by default', async () => {
    chat.joinRoom('general');

    const subs = client.sent.filter((s) => s.op === 'subscribe');
    const messages = subs.find((s) => s.topic === `${PREFIX}/messages`);
    expect(messages).toBeDefined();
    expect(messages!.options).toBeUndefined();
    expect(client.topicFilters.has(`${PREFIX}/messages`)).toBe(false);
  });

  it('subscribes messages and _stream with join-time filters', async () => {
    chat.joinRoom('general', { filters: ['alice'] });

    expect(client.topicFilters.get(`${PREFIX}/messages`)).toEqual(['alice']);
    expect(client.topicFilters.get(`${PREFIX}/_stream`)).toEqual(['alice']);
  });

  it('leaves typing unfiltered — it is ephemeral and room-wide', async () => {
    chat.joinRoom('general', { filters: ['alice'] });

    const typing = client.sent.find(
      (s) => s.op === 'subscribe' && s.topic === `${PREFIX}/_typing`,
    );
    expect(typing!.options).toBeUndefined();
  });

  it('exposes the active filter set', async () => {
    const room = chat.joinRoom('general', { filters: ['alice', 'bob'] });
    expect(room.filters).toEqual(['alice', 'bob']);
  });

  it('setFilters replaces the set on both content topics', async () => {
    const room = chat.joinRoom('general');
    client.sent.length = 0;

    room.setFilters(['carol']);

    const calls = client.sent.filter((s) => s.op === 'setFilters');
    expect(calls.map((c) => c.topic).sort()).toEqual([
      `${PREFIX}/_stream`,
      `${PREFIX}/messages`,
    ]);
    expect(calls[0].filters).toEqual(['carol']);
    expect(room.filters).toEqual(['carol']);
  });

  it('setFilters([]) reverts to the wildcard subscription', async () => {
    const room = chat.joinRoom('general', { filters: ['alice'] });

    room.setFilters([]);

    expect(room.filters).toEqual([]);
    expect(client.topicFilters.has(`${PREFIX}/messages`)).toBe(false);
  });

  it('addFilters merges without dropping existing values', async () => {
    const room = chat.joinRoom('general', { filters: ['alice'] });

    room.addFilters(['bob']);

    expect(room.filters).toEqual(['alice', 'bob']);
    expect(client.topicFilters.get(`${PREFIX}/messages`)).toEqual(['alice', 'bob']);
  });

  it('addFilters does not duplicate a value already present', async () => {
    const room = chat.joinRoom('general', { filters: ['alice'] });

    room.addFilters(['alice']);

    expect(room.filters).toEqual(['alice']);
  });

  it('removeFilters drops only the named values', async () => {
    const room = chat.joinRoom('general', { filters: ['alice', 'bob'] });

    room.removeFilters(['alice']);

    expect(room.filters).toEqual(['bob']);
  });

  it('removing the last value restores the wildcard', async () => {
    const room = chat.joinRoom('general', { filters: ['alice'] });

    room.removeFilters(['alice']);

    expect(room.filters).toEqual([]);
    expect(client.topicFilters.has(`${PREFIX}/messages`)).toBe(false);
  });

  it('preserves AND groups when adding and removing OR terms', async () => {
    const room = chat.joinRoom('general', { filters: [['alice', 'admin']] });

    room.addFilters(['bob']);
    expect(room.filters).toEqual(['bob', ['alice', 'admin']]);

    room.removeFilters(['bob']);
    expect(room.filters).toEqual([['alice', 'admin']]);
  });

  it('sendMessage routes with the given filter', async () => {
    const room = chat.joinRoom('general');
    client.sent.length = 0;

    room.sendMessage('hi', { filter: 'alice' });

    const emit = client.sent.find((s) => s.op === 'emit');
    expect(emit!.topic).toBe(`${PREFIX}/messages`);
    expect(emit!.options).toMatchObject({ filter: 'alice' });
  });

  it('sendMessage supports an AND composite filter', async () => {
    const room = chat.joinRoom('general');
    client.sent.length = 0;

    room.sendMessage('hi', { filters: ['alice', 'admin'] });

    const emit = client.sent.find((s) => s.op === 'emit');
    expect(emit!.options).toMatchObject({ filters: ['alice', 'admin'] });
  });

  it('filter wins over filters when both are supplied', async () => {
    const room = chat.joinRoom('general');
    client.sent.length = 0;

    room.sendMessage('hi', { filter: 'alice', filters: ['bob', 'admin'] });

    const emit = client.sent.find((s) => s.op === 'emit');
    expect(emit!.options).toMatchObject({ filter: 'alice' });
    expect((emit!.options as Record<string, unknown>).filters).toBeUndefined();
  });

  it('an unfiltered send carries no filter fields', async () => {
    const room = chat.joinRoom('general');
    client.sent.length = 0;

    room.sendMessage('hi');

    const emit = client.sent.find((s) => s.op === 'emit');
    const options = emit!.options as Record<string, unknown>;
    expect(options.filter).toBeUndefined();
    expect(options.filters).toBeUndefined();
  });

  it('a streamed message tags its deltas and its final message alike', async () => {
    const room = chat.joinRoom('general');
    client.sent.length = 0;

    const stream = room.startStream({ filter: 'alice' });
    stream.append('tok');
    stream.complete();

    const emits = client.sent.filter((s) => s.op === 'emit');
    const stream_ = emits.filter((e) => e.topic === `${PREFIX}/_stream`);
    const final = emits.filter((e) => e.topic === `${PREFIX}/messages`);

    expect(stream_.length).toBeGreaterThan(0);
    expect(final.length).toBe(1);
    for (const e of [...stream_, ...final]) {
      expect(e.options).toMatchObject({ filter: 'alice' });
    }
  });

  it('re-points filters when joining a room that is already subscribed', async () => {
    chat.joinRoom('general', { filters: ['alice'] });

    const room = chat.joinRoom('general', { filters: ['bob'] });

    expect(room.filters).toEqual(['bob']);
    expect(client.topicFilters.get(`${PREFIX}/messages`)).toEqual(['bob']);
  });

  it('does not clobber existing filters when re-joining without any', async () => {
    chat.joinRoom('general', { filters: ['alice'] });

    const room = chat.joinRoom('general');

    expect(room.filters).toEqual(['alice']);
  });

  it('hands back a copy, so callers cannot mutate the live set', async () => {
    const room = chat.joinRoom('general', { filters: ['alice'] });

    room.filters.push('mallory');

    expect(room.filters).toEqual(['alice']);
  });
});
