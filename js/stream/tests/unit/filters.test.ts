import { describe, it, expect, beforeEach } from 'vitest';
import { NoLagStream } from '../../src/NoLagStream';
import { makeFakeClient, FakeNoLagClient } from '../helpers/fakeNoLagClient';

/**
 * Filter API contract for @nolag/stream.
 *
 * Filters cover comments and polls — a language segment, a ticket tier, a
 * moderator channel. Reactions stay stream-wide: they are ephemeral emoji
 * bursts with no per-audience meaning.
 *
 * A poll's votes and its close event inherit the poll's filter so the whole
 * poll stays with one audience.
 */

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

const PREFIX = 'stream-app/friday-show';

async function connected() {
  const client = makeFakeClient();
  const stream = new NoLagStream({
    client: client as never,
    username: 'Alice',
    appName: 'stream-app',
  } as never);
  client.fireConnect('actor-1');
  await flush();
  return { client, stream };
}

describe('@nolag/stream filters', () => {
  let client: FakeNoLagClient;
  let stream: NoLagStream;

  beforeEach(async () => {
    ({ client, stream } = await connected());
  });

  it('subscribes unfiltered by default', () => {
    stream.joinStream('friday-show');

    const sub = client.sent.find(
      (s) => s.op === 'subscribe' && s.topic === `${PREFIX}/comments`,
    );
    expect(sub!.options).toBeUndefined();
  });

  it('applies join-time filters to comments and polls', () => {
    stream.joinStream('friday-show', { filters: ['es'] });

    expect(client.topicFilters.get(`${PREFIX}/comments`)).toEqual(['es']);
    expect(client.topicFilters.get(`${PREFIX}/polls`)).toEqual(['es']);
  });

  it('leaves reactions unfiltered', () => {
    stream.joinStream('friday-show', { filters: ['es'] });

    const reactions = client.sent.find(
      (s) => s.op === 'subscribe' && s.topic === `${PREFIX}/_reactions`,
    );
    expect(reactions!.options).toBeUndefined();
  });

  it('reports filters per topic', () => {
    const room = stream.joinStream('friday-show', { filters: ['es'] });

    expect(room.filters).toEqual({ comments: ['es'], polls: ['es'] });
  });

  it('setFilters replaces the set on both content topics', () => {
    const room = stream.joinStream('friday-show');
    client.sent.length = 0;

    room.setFilters(['fr']);

    const calls = client.sent.filter((s) => s.op === 'setFilters');
    expect(calls.map((c) => c.topic).sort()).toEqual([
      `${PREFIX}/comments`,
      `${PREFIX}/polls`,
    ]);
  });

  it('scopes a call to one topic with { topic }', () => {
    const room = stream.joinStream('friday-show');
    client.sent.length = 0;

    room.setFilters(['fr'], { topic: 'comments' });

    const calls = client.sent.filter((s) => s.op === 'setFilters');
    expect(calls).toHaveLength(1);
    expect(calls[0].topic).toBe(`${PREFIX}/comments`);
    expect(room.filters.polls).toEqual([]);
  });

  it('setFilters([]) reverts to the wildcard subscription', () => {
    const room = stream.joinStream('friday-show', { filters: ['es'] });

    room.setFilters([]);

    expect(room.filters.comments).toEqual([]);
    expect(client.topicFilters.has(`${PREFIX}/comments`)).toBe(false);
  });

  it('addFilters and removeFilters adjust the set', () => {
    const room = stream.joinStream('friday-show', { filters: ['es'] });

    room.addFilters(['fr']);
    expect(room.filters.comments).toEqual(['es', 'fr']);

    room.removeFilters(['es']);
    expect(room.filters.comments).toEqual(['fr']);
  });

  it('sendComment routes with the given filter', () => {
    const room = stream.joinStream('friday-show');
    client.sent.length = 0;

    room.sendComment('hola', { filter: 'es' });

    const emit = client.sent.find((s) => s.op === 'emit');
    expect(emit!.topic).toBe(`${PREFIX}/comments`);
    expect(emit!.options).toMatchObject({ filter: 'es' });
  });

  it('createPoll routes with the given filter', () => {
    const room = stream.joinStream('friday-show');
    client.sent.length = 0;

    room.createPoll({ question: 'Which?', options: ['a', 'b'], filter: 'es' });

    const emit = client.sent.find((s) => s.op === 'emit');
    expect(emit!.topic).toBe(`${PREFIX}/polls`);
    expect(emit!.options).toMatchObject({ filter: 'es' });
  });

  it('a vote inherits the poll filter', () => {
    const room = stream.joinStream('friday-show');
    const poll = room.createPoll({ question: 'Which?', options: ['a', 'b'], filter: 'es' });
    client.sent.length = 0;

    room.votePoll(poll.id, 0);

    const emit = client.sent.find((s) => s.op === 'emit');
    expect(emit!.options).toMatchObject({ filter: 'es' });
  });

  it('closing a poll inherits its filter', () => {
    const room = stream.joinStream('friday-show');
    const poll = room.createPoll({ question: 'Which?', options: ['a', 'b'], filter: 'es' });
    client.sent.length = 0;

    room.closePoll(poll.id);

    const emit = client.sent.find((s) => s.op === 'emit');
    expect(emit!.options).toMatchObject({ filter: 'es' });
  });

  it('votes on an unfiltered poll stay unfiltered', () => {
    const room = stream.joinStream('friday-show');
    const poll = room.createPoll({ question: 'Which?', options: ['a', 'b'] });
    client.sent.length = 0;

    room.votePoll(poll.id, 0);

    const options = client.sent.find((s) => s.op === 'emit')!.options as Record<string, unknown>;
    expect(options.filter).toBeUndefined();
  });

  it('learns a remote poll filter from message metadata', () => {
    const room = stream.joinStream('friday-show');
    client.fireMessage(`${PREFIX}/polls`, {
      id: 'poll-remote',
      question: 'Remote?',
      options: [
        { text: 'a', votes: 0 },
        { text: 'b', votes: 0 },
      ],
      createdBy: 'someone',
      closed: false,
    }, { isReplay: false, filter: 'es' });
    client.sent.length = 0;

    room.votePoll('poll-remote', 0);

    const emit = client.sent.find((s) => s.op === 'emit');
    expect(emit!.options).toMatchObject({ filter: 'es' });
  });

  it('re-points filters when re-joining an open stream', () => {
    stream.joinStream('friday-show', { filters: ['es'] });

    const room = stream.joinStream('friday-show', { filters: ['fr'] });

    expect(room.filters.comments).toEqual(['fr']);
  });
});
