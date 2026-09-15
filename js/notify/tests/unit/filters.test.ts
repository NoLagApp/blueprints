import { describe, it, expect, beforeEach } from 'vitest';
import { NoLagNotify } from '../../src/NoLagNotify';
import { makeFakeClient, FakeNoLagClient } from '../helpers/fakeNoLagClient';

/**
 * Filter API contract for @nolag/notify. This is the per-recipient delivery
 * case: subscribe with your own user id, publish with `filter: userId`, and
 * the broker addresses the notification instead of every client discarding
 * what is not theirs. Read receipts stay unfiltered — they are the local
 * user's own cross-tab sync.
 */

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

const PREFIX = 'notify-app/alerts';

async function connected() {
  const client = makeFakeClient();
  const notify = new NoLagNotify({ client: client as never, appName: 'notify-app' });
  client.fireConnect('actor-1');
  await flush();
  return { client, notify };
}

describe('@nolag/notify filters', () => {
  let client: FakeNoLagClient;
  let notify: NoLagNotify;

  beforeEach(async () => {
    ({ client, notify } = await connected());
  });

  it('subscribes unfiltered by default', () => {
    notify.subscribe('alerts');

    const sub = client.sent.find(
      (s) => s.op === 'subscribe' && s.topic === `${PREFIX}/notifications`,
    );
    expect(sub!.options).toBeUndefined();
  });

  it('subscribes notifications with join-time filters', () => {
    notify.subscribe('alerts', { filters: ['user-42'] });

    expect(client.topicFilters.get(`${PREFIX}/notifications`)).toEqual(['user-42']);
  });

  it('leaves read receipts unfiltered', () => {
    notify.subscribe('alerts', { filters: ['user-42'] });

    const read = client.sent.find(
      (s) => s.op === 'subscribe' && s.topic === `${PREFIX}/_read`,
    );
    expect(read!.options).toBeUndefined();
  });

  it('setFilters replaces the set', () => {
    const channel = notify.subscribe('alerts');

    channel.setFilters(['user-42', 'all-hands']);

    expect(channel.filters).toEqual(['user-42', 'all-hands']);
    expect(client.topicFilters.get(`${PREFIX}/notifications`)).toEqual([
      'user-42',
      'all-hands',
    ]);
  });

  it('setFilters([]) reverts to the wildcard subscription', () => {
    const channel = notify.subscribe('alerts', { filters: ['user-42'] });

    channel.setFilters([]);

    expect(channel.filters).toEqual([]);
    expect(client.topicFilters.has(`${PREFIX}/notifications`)).toBe(false);
  });

  it('addFilters and removeFilters adjust the set', () => {
    const channel = notify.subscribe('alerts', { filters: ['user-42'] });

    channel.addFilters(['all-hands']);
    expect(channel.filters).toEqual(['user-42', 'all-hands']);

    channel.removeFilters(['user-42']);
    expect(channel.filters).toEqual(['all-hands']);
  });

  it('preserves AND groups across OR-term edits', () => {
    const channel = notify.subscribe('alerts', { filters: [['eu', 'admin']] });

    channel.addFilters(['user-42']);
    expect(channel.filters).toEqual(['user-42', ['eu', 'admin']]);
  });

  it('send routes with the given filter', () => {
    const channel = notify.subscribe('alerts');
    client.sent.length = 0;

    channel.send('Deploy done', { filter: 'user-42' });

    const emit = client.sent.find((s) => s.op === 'emit');
    expect(emit!.topic).toBe(`${PREFIX}/notifications`);
    expect(emit!.options).toMatchObject({ filter: 'user-42' });
  });

  it('send supports an AND composite filter', () => {
    const channel = notify.subscribe('alerts');
    client.sent.length = 0;

    channel.send('Deploy done', { filters: ['eu', 'admin'] });

    const emit = client.sent.find((s) => s.op === 'emit');
    expect(emit!.options).toMatchObject({ filters: ['eu', 'admin'] });
  });

  it('an unfiltered send passes no options at all', () => {
    const channel = notify.subscribe('alerts');
    client.sent.length = 0;

    channel.send('Deploy done');

    const emit = client.sent.find((s) => s.op === 'emit');
    expect(emit!.options).toBeUndefined();
  });

  it('re-points filters when re-subscribing an open channel', () => {
    notify.subscribe('alerts', { filters: ['user-42'] });

    const channel = notify.subscribe('alerts', { filters: ['user-7'] });

    expect(channel.filters).toEqual(['user-7']);
  });
});
