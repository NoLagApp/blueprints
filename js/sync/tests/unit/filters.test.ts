import { describe, it, expect, beforeEach } from 'vitest';
import { NoLagSync } from '../../src/NoLagSync';
import { makeFakeClient, FakeNoLagClient } from '../helpers/fakeNoLagClient';

/**
 * Filter API contract for @nolag/sync.
 *
 * Filters partition a collection: a client syncs one tenant or region rather
 * than everything. A document's create carries its filter in the payload, so
 * every peer learns the partition and routes its own updates and deletes to
 * the same audience.
 */

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

const PREFIX = 'sync-app/todos';

async function connected(userId = 'user-1') {
  const client = makeFakeClient();
  const sync = new NoLagSync({
    client: client as never,
    appName: 'sync-app',
    userId,
  } as never);
  client.fireConnect('actor-1');
  await flush();
  return { client, sync };
}

describe('@nolag/sync filters', () => {
  let client: FakeNoLagClient;
  let sync: NoLagSync;

  beforeEach(async () => {
    ({ client, sync } = await connected());
  });

  it('subscribes unfiltered by default', () => {
    sync.joinCollection('todos');

    const sub = client.sent.find(
      (s) => s.op === 'subscribe' && s.topic === `${PREFIX}/changes`,
    );
    expect(sub!.options).toBeUndefined();
  });

  it('subscribes changes with join-time filters', () => {
    sync.joinCollection('todos', { filters: ['tenant-a'] });

    expect(client.topicFilters.get(`${PREFIX}/changes`)).toEqual(['tenant-a']);
  });

  it('setFilters replaces the set', () => {
    const room = sync.joinCollection('todos');

    room.setFilters(['tenant-b']);

    expect(room.filters).toEqual(['tenant-b']);
    expect(client.topicFilters.get(`${PREFIX}/changes`)).toEqual(['tenant-b']);
  });

  it('setFilters([]) reverts to the wildcard subscription', () => {
    const room = sync.joinCollection('todos', { filters: ['tenant-a'] });

    room.setFilters([]);

    expect(room.filters).toEqual([]);
    expect(client.topicFilters.has(`${PREFIX}/changes`)).toBe(false);
  });

  it('addFilters and removeFilters adjust the set', () => {
    const room = sync.joinCollection('todos', { filters: ['tenant-a'] });

    room.addFilters(['tenant-b']);
    expect(room.filters).toEqual(['tenant-a', 'tenant-b']);

    room.removeFilters(['tenant-a']);
    expect(room.filters).toEqual(['tenant-b']);
  });

  it('createDocument routes with the given filter', () => {
    const room = sync.joinCollection('todos');
    client.sent.length = 0;

    room.createDocument('doc-1', { text: 'hi' }, { filter: 'tenant-a' });

    const emit = client.sent.find((s) => s.op === 'emit');
    expect(emit!.topic).toBe(`${PREFIX}/changes`);
    expect(emit!.options).toMatchObject({ filter: 'tenant-a' });
  });

  it('carries the filter in the change payload', () => {
    const room = sync.joinCollection('todos');
    client.sent.length = 0;

    room.createDocument('doc-1', { text: 'hi' }, { filter: 'tenant-a' });

    const emit = client.sent.find((s) => s.op === 'emit');
    expect(emit!.data).toMatchObject({ filter: 'tenant-a' });
  });

  it('an update inherits the filter of its document', () => {
    const room = sync.joinCollection('todos');
    room.createDocument('doc-1', { text: 'hi' }, { filter: 'tenant-a' });
    client.sent.length = 0;

    room.updateDocument('doc-1', { text: 'edited' });

    const emit = client.sent.find((s) => s.op === 'emit');
    expect(emit!.options).toMatchObject({ filter: 'tenant-a' });
  });

  it('a delete inherits the filter of its document', () => {
    const room = sync.joinCollection('todos');
    room.createDocument('doc-1', { text: 'hi' }, { filter: 'tenant-a' });
    client.sent.length = 0;

    room.deleteDocument('doc-1');

    const emit = client.sent.find((s) => s.op === 'emit');
    expect(emit!.options).toMatchObject({ filter: 'tenant-a' });
  });

  it('changes to an unfiltered document stay unfiltered', () => {
    const room = sync.joinCollection('todos');
    room.createDocument('doc-1', { text: 'hi' });
    client.sent.length = 0;

    room.updateDocument('doc-1', { text: 'edited' });

    const options = client.sent.find((s) => s.op === 'emit')!.options as Record<string, unknown>;
    expect(options.filter).toBeUndefined();
  });

  it('splits an inherited AND composite back into its parts', () => {
    const room = sync.joinCollection('todos');
    room.createDocument('doc-1', { text: 'hi' }, { filters: ['tenant-a', 'eu'] });
    client.sent.length = 0;

    room.updateDocument('doc-1', { text: 'edited' });

    const emit = client.sent.find((s) => s.op === 'emit');
    expect(emit!.options).toMatchObject({ filters: ['eu', 'tenant-a'] });
  });

  it('learns a remote document partition from its create', () => {
    const room = sync.joinCollection('todos');
    client.fireMessage(`${PREFIX}/changes`, {
      id: 'c1',
      documentId: 'remote-1',
      type: 'create',
      fields: { text: 'from bob' },
      version: 1,
      updatedBy: 'user-2',
      timestamp: Date.now(),
      optimistic: false,
      filter: 'tenant-a',
      isReplay: false,
    }, { isReplay: false });
    client.sent.length = 0;

    room.updateDocument('remote-1', { text: 'edited by me' });

    const emit = client.sent.find((s) => s.op === 'emit');
    expect(emit!.options).toMatchObject({ filter: 'tenant-a' });
  });

  it('re-points filters when re-joining an open collection', () => {
    sync.joinCollection('todos', { filters: ['tenant-a'] });

    const room = sync.joinCollection('todos', { filters: ['tenant-b'] });

    expect(room.filters).toEqual(['tenant-b']);
  });
});
