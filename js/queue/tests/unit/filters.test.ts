import { describe, it, expect, beforeEach } from 'vitest';
import { NoLagQueue } from '../../src/NoLagQueue';
import { makeFakeClient, FakeNoLagClient } from '../helpers/fakeNoLagClient';

/**
 * Filter API contract for @nolag/queue.
 *
 * Filters are capability routing: a worker subscribes with the job types it
 * can run, and the broker offers it nothing else. Filters compose with load
 * balancing — the server shares each filtered sub-topic across the group, so
 * one matching worker claims each job.
 *
 * Every lifecycle event for a job carries the filter the job was added with,
 * so claims, progress, completion and failure track the job itself.
 */

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

const PREFIX = 'queue-app/images';

async function connected(role: 'worker' | 'producer' = 'producer') {
  const client = makeFakeClient();
  const queue = new NoLagQueue({
    client: client as never,
    appName: 'queue-app',
    role,
  } as never);
  client.fireConnect('actor-1');
  await flush();
  return { client, queue };
}

describe('@nolag/queue filters', () => {
  let client: FakeNoLagClient;
  let queue: NoLagQueue;

  beforeEach(async () => {
    ({ client, queue } = await connected());
  });

  it('subscribes unfiltered by default', () => {
    queue.joinQueue('images');

    const sub = client.sent.find(
      (s) => s.op === 'subscribe' && s.topic === `${PREFIX}/jobs`,
    );
    expect(sub!.options).toBeUndefined();
  });

  it('subscribes jobs and progress with join-time filters', () => {
    queue.joinQueue('images', { filters: ['gpu'] });

    expect(client.topicFilters.get(`${PREFIX}/jobs`)).toEqual(['gpu']);
    expect(client.topicFilters.get(`${PREFIX}/_progress`)).toEqual(['gpu']);
  });

  it('combines filters with load balancing for a worker', async () => {
    const worker = await connected('worker');
    worker.queue.joinQueue('images', { filters: ['gpu'] });

    const sub = worker.client.sent.find(
      (s) => s.op === 'subscribe' && s.topic === `${PREFIX}/jobs`,
    );
    expect(sub!.options).toMatchObject({ loadBalance: true, filters: ['gpu'] });
  });

  it('still load balances when no filters are given', async () => {
    const worker = await connected('worker');
    worker.queue.joinQueue('images');

    const sub = worker.client.sent.find(
      (s) => s.op === 'subscribe' && s.topic === `${PREFIX}/jobs`,
    );
    expect(sub!.options).toMatchObject({ loadBalance: true });
    expect((sub!.options as Record<string, unknown>).filters).toBeUndefined();
  });

  it('setFilters replaces the set on jobs and progress', () => {
    const room = queue.joinQueue('images');
    client.sent.length = 0;

    room.setFilters(['gpu', 'render']);

    const calls = client.sent.filter((s) => s.op === 'setFilters');
    expect(calls.map((c) => c.topic).sort()).toEqual([
      `${PREFIX}/_progress`,
      `${PREFIX}/jobs`,
    ]);
    expect(room.filters).toEqual(['gpu', 'render']);
  });

  it('setFilters([]) reverts to the wildcard subscription', () => {
    const room = queue.joinQueue('images', { filters: ['gpu'] });

    room.setFilters([]);

    expect(room.filters).toEqual([]);
    expect(client.topicFilters.has(`${PREFIX}/jobs`)).toBe(false);
  });

  it('addFilters and removeFilters adjust the set', () => {
    const room = queue.joinQueue('images', { filters: ['gpu'] });

    room.addFilters(['render']);
    expect(room.filters).toEqual(['gpu', 'render']);

    room.removeFilters(['gpu']);
    expect(room.filters).toEqual(['render']);
  });

  it('addJob routes with the given filter', () => {
    const room = queue.joinQueue('images');
    client.sent.length = 0;

    room.addJob({ type: 'resize', filter: 'gpu' });

    const emit = client.sent.find((s) => s.op === 'emit');
    expect(emit!.topic).toBe(`${PREFIX}/jobs`);
    expect(emit!.options).toMatchObject({ filter: 'gpu' });
  });

  it('records the filter on the job', () => {
    const room = queue.joinQueue('images');

    const job = room.addJob({ type: 'resize', filter: 'gpu' });

    expect(job.filter).toBe('gpu');
  });

  it('a claim inherits the job filter', () => {
    const room = queue.joinQueue('images');
    const job = room.addJob({ type: 'resize', filter: 'gpu' });
    client.sent.length = 0;

    room.claimJob(job.id);

    const emit = client.sent.find((s) => s.op === 'emit');
    expect(emit!.options).toMatchObject({ filter: 'gpu' });
  });

  it('progress inherits the job filter', () => {
    const room = queue.joinQueue('images');
    const job = room.addJob({ type: 'resize', filter: 'gpu' });
    room.claimJob(job.id);
    client.sent.length = 0;

    room.reportProgress(job.id, 50);

    const emit = client.sent.find((s) => s.op === 'emit' && s.topic === `${PREFIX}/_progress`);
    expect(emit!.options).toMatchObject({ filter: 'gpu' });
  });

  it('completion inherits the job filter', () => {
    const room = queue.joinQueue('images');
    const job = room.addJob({ type: 'resize', filter: 'gpu' });
    room.claimJob(job.id);
    client.sent.length = 0;

    room.completeJob(job.id, { ok: true });

    const emit = client.sent.find((s) => s.op === 'emit');
    expect(emit!.options).toMatchObject({ filter: 'gpu' });
  });

  it('failure inherits the job filter', () => {
    const room = queue.joinQueue('images');
    const job = room.addJob({ type: 'resize', filter: 'gpu' });
    room.claimJob(job.id);
    client.sent.length = 0;

    room.failJob(job.id, 'boom');

    const emits = client.sent.filter((s) => s.op === 'emit');
    expect(emits.length).toBeGreaterThan(0);
    for (const e of emits) {
      expect(e.options).toMatchObject({ filter: 'gpu' });
    }
  });

  it('lifecycle events for an unfiltered job stay unfiltered', () => {
    const room = queue.joinQueue('images');
    const job = room.addJob({ type: 'resize' });
    client.sent.length = 0;

    room.claimJob(job.id);

    const options = client.sent.find((s) => s.op === 'emit')!.options as Record<string, unknown>;
    expect(options.filter).toBeUndefined();
  });

  it('splits an inherited AND composite back into its parts', () => {
    const room = queue.joinQueue('images');
    const job = room.addJob({ type: 'resize', filters: ['gpu', 'eu-west'] });
    client.sent.length = 0;

    room.claimJob(job.id);

    const emit = client.sent.find((s) => s.op === 'emit');
    expect(emit!.options).toMatchObject({ filters: ['eu-west', 'gpu'] });
  });

  it('server-side filters are separate from the local getJobs(filter) query', () => {
    const room = queue.joinQueue('images', { filters: ['gpu'] });
    room.addJob({ type: 'resize', filter: 'gpu' });
    room.addJob({ type: 'encode', filter: 'gpu' });

    // getJobs filters the local cache by field; it does not touch the
    // subscription, which stays exactly as set.
    expect(room.getJobs({ type: 'resize' })).toHaveLength(1);
    expect(room.filters).toEqual(['gpu']);
  });

  it('re-points filters when re-joining an open queue', () => {
    queue.joinQueue('images', { filters: ['gpu'] });

    const room = queue.joinQueue('images', { filters: ['cpu'] });

    expect(room.filters).toEqual(['cpu']);
  });
});
