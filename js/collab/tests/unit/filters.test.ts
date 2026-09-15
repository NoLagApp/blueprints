import { describe, it, expect, beforeEach } from 'vitest';
import { NoLagCollab } from '../../src/NoLagCollab';
import { makeFakeClient, FakeNoLagClient } from '../helpers/fakeNoLagClient';

/**
 * Filter API contract for @nolag/collab. Filters scope the `operations`
 * topic — useful for a large document where a client only edits one path.
 * Cursors stay unfiltered: awareness is ephemeral and document-wide.
 */

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

const PREFIX = 'collab-app/doc-1';

async function connected() {
  const client = makeFakeClient();
  const collab = new NoLagCollab({
    client: client as never,
    username: 'Alice',
    appName: 'collab-app',
  });
  client.fireConnect('actor-1');
  await flush();
  return { client, collab };
}

describe('@nolag/collab filters', () => {
  let client: FakeNoLagClient;
  let collab: NoLagCollab;

  beforeEach(async () => {
    ({ client, collab } = await connected());
  });

  it('subscribes unfiltered by default', () => {
    collab.joinDocument('doc-1');

    const sub = client.sent.find(
      (s) => s.op === 'subscribe' && s.topic === `${PREFIX}/operations`,
    );
    expect(sub!.options).toBeUndefined();
  });

  it('subscribes operations with join-time filters', () => {
    collab.joinDocument('doc-1', { filters: ['src/index.ts'] });

    expect(client.topicFilters.get(`${PREFIX}/operations`)).toEqual(['src/index.ts']);
  });

  it('leaves cursors unfiltered', () => {
    collab.joinDocument('doc-1', { filters: ['src/index.ts'] });

    const cursors = client.sent.find(
      (s) => s.op === 'subscribe' && s.topic === `${PREFIX}/_cursors`,
    );
    expect(cursors!.options).toBeUndefined();
  });

  it('setFilters replaces the set', () => {
    const doc = collab.joinDocument('doc-1');

    doc.setFilters(['src/app.ts']);

    expect(doc.filters).toEqual(['src/app.ts']);
    expect(client.topicFilters.get(`${PREFIX}/operations`)).toEqual(['src/app.ts']);
  });

  it('setFilters([]) reverts to the wildcard subscription', () => {
    const doc = collab.joinDocument('doc-1', { filters: ['a'] });

    doc.setFilters([]);

    expect(doc.filters).toEqual([]);
    expect(client.topicFilters.has(`${PREFIX}/operations`)).toBe(false);
  });

  it('addFilters and removeFilters adjust the set', () => {
    const doc = collab.joinDocument('doc-1', { filters: ['a'] });

    doc.addFilters(['b']);
    expect(doc.filters).toEqual(['a', 'b']);

    doc.removeFilters(['a']);
    expect(doc.filters).toEqual(['b']);
  });

  it('preserves AND groups across OR-term edits', () => {
    const doc = collab.joinDocument('doc-1', { filters: [['a', 'v2']] });

    doc.addFilters(['b']);
    expect(doc.filters).toEqual(['b', ['a', 'v2']]);

    doc.removeFilters(['b']);
    expect(doc.filters).toEqual([['a', 'v2']]);
  });

  it('sendOperation routes with the given filter', () => {
    const doc = collab.joinDocument('doc-1');
    client.sent.length = 0;

    doc.sendOperation('insert', { content: 'x', filter: 'src/index.ts' });

    const emit = client.sent.find((s) => s.op === 'emit');
    expect(emit!.topic).toBe(`${PREFIX}/operations`);
    expect(emit!.options).toMatchObject({ filter: 'src/index.ts' });
  });

  it('sendOperation supports an AND composite filter', () => {
    const doc = collab.joinDocument('doc-1');
    client.sent.length = 0;

    doc.sendOperation('insert', { content: 'x', filters: ['src', 'v2'] });

    const emit = client.sent.find((s) => s.op === 'emit');
    expect(emit!.options).toMatchObject({ filters: ['src', 'v2'] });
  });

  it('an unfiltered operation carries no filter fields', () => {
    const doc = collab.joinDocument('doc-1');
    client.sent.length = 0;

    doc.sendOperation('insert', { content: 'x' });

    const options = client.sent.find((s) => s.op === 'emit')!.options as Record<string, unknown>;
    expect(options.filter).toBeUndefined();
    expect(options.filters).toBeUndefined();
  });

  it('re-points filters when re-joining an open document', () => {
    collab.joinDocument('doc-1', { filters: ['a'] });

    const doc = collab.joinDocument('doc-1', { filters: ['b'] });

    expect(doc.filters).toEqual(['b']);
  });
});
