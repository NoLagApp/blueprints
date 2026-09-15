import { describe, it, expect, beforeEach } from 'vitest';
import { NoLagFeed } from '../../src/NoLagFeed';
import { makeFakeClient, FakeNoLagClient } from '../helpers/fakeNoLagClient';

/**
 * Filter API contract for @nolag/feed.
 *
 * Posts, reactions and comments are filtered as one set by default: filtering
 * posts alone would still deliver likes and comments for posts the client
 * cannot see. Reactions and comments also inherit the filter of the post they
 * belong to, so they never reach a wider audience than the post did.
 */

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

const PREFIX = 'feed-app/general';
const CONTENT = ['posts', 'reactions', 'comments'];

async function connected() {
  const client = makeFakeClient();
  const feed = new NoLagFeed({
    client: client as never,
    username: 'Alice',
    appName: 'feed-app',
  });
  client.fireConnect('actor-1');
  await flush();
  return { client, feed };
}

describe('@nolag/feed filters', () => {
  let client: FakeNoLagClient;
  let feed: NoLagFeed;

  beforeEach(async () => {
    ({ client, feed } = await connected());
  });

  it('subscribes all three content topics unfiltered by default', () => {
    feed.joinChannel('general');

    for (const topic of CONTENT) {
      const sub = client.sent.find(
        (s) => s.op === 'subscribe' && s.topic === `${PREFIX}/${topic}`,
      );
      expect(sub, topic).toBeDefined();
      expect(sub!.options, topic).toBeUndefined();
    }
  });

  it('applies join-time filters to all three content topics', () => {
    feed.joinChannel('general', { filters: ['sports'] });

    for (const topic of CONTENT) {
      expect(client.topicFilters.get(`${PREFIX}/${topic}`), topic).toEqual(['sports']);
    }
  });

  it('reports filters per topic', () => {
    const channel = feed.joinChannel('general', { filters: ['sports'] });

    expect(channel.filters).toEqual({
      posts: ['sports'],
      reactions: ['sports'],
      comments: ['sports'],
    });
  });

  it('setFilters replaces the set on all three topics', () => {
    const channel = feed.joinChannel('general');
    client.sent.length = 0;

    channel.setFilters(['news']);

    const calls = client.sent.filter((s) => s.op === 'setFilters');
    expect(calls.map((c) => c.topic).sort()).toEqual(
      CONTENT.map((t) => `${PREFIX}/${t}`).sort(),
    );
    expect(channel.filters.posts).toEqual(['news']);
  });

  it('scopes a call to one topic with { topic }', () => {
    const channel = feed.joinChannel('general');
    client.sent.length = 0;

    channel.setFilters(['news'], { topic: 'posts' });

    const calls = client.sent.filter((s) => s.op === 'setFilters');
    expect(calls).toHaveLength(1);
    expect(calls[0].topic).toBe(`${PREFIX}/posts`);
    expect(channel.filters.posts).toEqual(['news']);
    expect(channel.filters.comments).toEqual([]);
  });

  it('setFilters([]) reverts to the wildcard subscription', () => {
    const channel = feed.joinChannel('general', { filters: ['sports'] });

    channel.setFilters([]);

    expect(channel.filters.posts).toEqual([]);
    expect(client.topicFilters.has(`${PREFIX}/posts`)).toBe(false);
  });

  it('addFilters and removeFilters adjust the set', () => {
    const channel = feed.joinChannel('general', { filters: ['sports'] });

    channel.addFilters(['news']);
    expect(channel.filters.posts).toEqual(['sports', 'news']);

    channel.removeFilters(['sports']);
    expect(channel.filters.posts).toEqual(['news']);
  });

  it('createPost routes with the given filter', () => {
    const channel = feed.joinChannel('general');
    client.sent.length = 0;

    channel.createPost({ content: 'hello', filter: 'sports' });

    const emit = client.sent.find((s) => s.op === 'emit');
    expect(emit!.topic).toBe(`${PREFIX}/posts`);
    expect(emit!.options).toMatchObject({ filter: 'sports' });
  });

  it('records the filter on the returned post', () => {
    const channel = feed.joinChannel('general');

    const post = channel.createPost({ content: 'hello', filter: 'sports' });

    expect(post.filter).toBe('sports');
  });

  it('records an AND composite as the server would key it', () => {
    const channel = feed.joinChannel('general');

    // Server lowercases, sorts and joins AND groups with '|'.
    const post = channel.createPost({ content: 'hi', filters: ['Live', 'sports'] });

    expect(post.filter).toBe('live|sports');
  });

  it('a like inherits the filter of the post it targets', () => {
    const channel = feed.joinChannel('general');
    const post = channel.createPost({ content: 'hello', filter: 'sports' });
    client.sent.length = 0;

    channel.likePost(post.id);

    const emit = client.sent.find((s) => s.op === 'emit');
    expect(emit!.topic).toBe(`${PREFIX}/reactions`);
    expect(emit!.options).toMatchObject({ filter: 'sports' });
  });

  it('an unlike inherits the filter too', () => {
    const channel = feed.joinChannel('general');
    const post = channel.createPost({ content: 'hello', filter: 'sports' });
    channel.likePost(post.id);
    client.sent.length = 0;

    channel.unlikePost(post.id);

    const emit = client.sent.find((s) => s.op === 'emit');
    expect(emit!.options).toMatchObject({ filter: 'sports' });
  });

  it('a comment inherits the filter of its post', () => {
    const channel = feed.joinChannel('general');
    const post = channel.createPost({ content: 'hello', filter: 'sports' });
    client.sent.length = 0;

    channel.addComment(post.id, 'nice');

    const emit = client.sent.find((s) => s.op === 'emit');
    expect(emit!.topic).toBe(`${PREFIX}/comments`);
    expect(emit!.options).toMatchObject({ filter: 'sports' });
  });

  it('splits an inherited AND composite back into its parts', () => {
    const channel = feed.joinChannel('general');
    const post = channel.createPost({ content: 'hi', filters: ['live', 'sports'] });
    client.sent.length = 0;

    channel.likePost(post.id);

    // '|' is not legal inside a single filter value, so the composite has to
    // be republished as an AND group rather than one string.
    const emit = client.sent.find((s) => s.op === 'emit');
    expect(emit!.options).toMatchObject({ filters: ['live', 'sports'] });
  });

  it('a reaction to an unfiltered post stays unfiltered', () => {
    const channel = feed.joinChannel('general');
    const post = channel.createPost({ content: 'hello' });
    client.sent.length = 0;

    channel.likePost(post.id);

    const options = client.sent.find((s) => s.op === 'emit')!.options as Record<string, unknown>;
    expect(options.filter).toBeUndefined();
    expect(options.filters).toBeUndefined();
  });

  it('a reaction to an unknown post falls back to unfiltered', () => {
    const channel = feed.joinChannel('general');
    client.sent.length = 0;

    channel.addComment('never-seen', 'orphan');

    const options = client.sent.find((s) => s.op === 'emit')!.options as Record<string, unknown>;
    expect(options.filter).toBeUndefined();
  });

  it('learns a remote post filter from message metadata', () => {
    const channel = feed.joinChannel('general');
    client.fireMessage(`${PREFIX}/posts`, {
      id: 'remote-1',
      userId: 'bob',
      username: 'Bob',
      content: 'from bob',
      timestamp: Date.now(),
    }, { isReplay: false, filter: 'sports' });
    client.sent.length = 0;

    channel.likePost('remote-1');

    const emit = client.sent.find((s) => s.op === 'emit');
    expect(emit!.options).toMatchObject({ filter: 'sports' });
  });

  it('re-points filters when re-joining an open channel', () => {
    feed.joinChannel('general', { filters: ['sports'] });

    const channel = feed.joinChannel('general', { filters: ['news'] });

    expect(channel.filters.posts).toEqual(['news']);
  });
});
