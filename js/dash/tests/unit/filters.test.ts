import { describe, it, expect, beforeEach } from 'vitest';
import { NoLagDash } from '../../src/NoLagDash';
import { makeFakeClient, FakeNoLagClient } from '../helpers/fakeNoLagClient';

/**
 * Filter API contract for @nolag/dash.
 *
 * dash shipped filters before the uniform API existed, so both surfaces are
 * live: the domain-named `setMetricFilters` trio now delegates to the uniform
 * one scoped to `metrics`, and the legacy `joinPanel({ metricFilters })` keeps
 * its original semantics — including the `__none__` placeholder that makes an
 * empty array mean "receive nothing" rather than "receive everything".
 */

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

const PREFIX = 'dash-app/overview';

async function connected() {
  const client = makeFakeClient();
  const dash = new NoLagDash({ client: client as never, appName: 'dash-app' } as never);
  client.fireConnect('actor-1');
  await flush();
  return { client, dash };
}

describe('@nolag/dash filters', () => {
  let client: FakeNoLagClient;
  let dash: NoLagDash;

  beforeEach(async () => {
    ({ client, dash } = await connected());
  });

  it('subscribes unfiltered by default', () => {
    dash.joinPanel('overview');

    const sub = client.sent.find(
      (s) => s.op === 'subscribe' && s.topic === `${PREFIX}/metrics`,
    );
    expect(sub!.options).toBeUndefined();
  });

  it('applies uniform join-time filters to metrics and widgets', () => {
    dash.joinPanel('overview', { filters: ['cpu'] });

    expect(client.topicFilters.get(`${PREFIX}/metrics`)).toEqual(['cpu']);
    expect(client.topicFilters.get(`${PREFIX}/widgets`)).toEqual(['cpu']);
  });

  it('reports filters per topic', () => {
    const panel = dash.joinPanel('overview', { filters: ['cpu'] });

    expect(panel.filters).toEqual({ metrics: ['cpu'], widgets: ['cpu'] });
  });

  it('setFilters replaces the set on both topics', () => {
    const panel = dash.joinPanel('overview');
    client.sent.length = 0;

    panel.setFilters(['mem']);

    const calls = client.sent.filter((s) => s.op === 'setFilters');
    expect(calls.map((c) => c.topic).sort()).toEqual([
      `${PREFIX}/metrics`,
      `${PREFIX}/widgets`,
    ]);
  });

  it('scopes a call to one topic with { topic }', () => {
    const panel = dash.joinPanel('overview');
    client.sent.length = 0;

    panel.setFilters(['mem'], { topic: 'metrics' });

    const calls = client.sent.filter((s) => s.op === 'setFilters');
    expect(calls).toHaveLength(1);
    expect(calls[0].topic).toBe(`${PREFIX}/metrics`);
    expect(panel.filters.widgets).toEqual([]);
  });

  it('addFilters and removeFilters adjust the set', () => {
    const panel = dash.joinPanel('overview', { filters: ['cpu'] });

    panel.addFilters(['mem']);
    expect(panel.filters.metrics).toEqual(['cpu', 'mem']);

    panel.removeFilters(['cpu']);
    expect(panel.filters.metrics).toEqual(['mem']);
  });

  it('publishMetric routes with the given filter', () => {
    const panel = dash.joinPanel('overview');
    client.sent.length = 0;

    panel.publishMetric('load', 1, { filter: 'cpu' });

    const emit = client.sent.find((s) => s.op === 'emit');
    expect(emit!.topic).toBe(`${PREFIX}/metrics`);
    expect(emit!.options).toMatchObject({ filter: 'cpu' });
  });

  it('publishMetric supports an AND composite filter', () => {
    const panel = dash.joinPanel('overview');
    client.sent.length = 0;

    panel.publishMetric('load', 1, { filters: ['cpu', 'prod'] });

    const emit = client.sent.find((s) => s.op === 'emit');
    expect(emit!.options).toMatchObject({ filters: ['cpu', 'prod'] });
  });

  it('publishWidget accepts a filter', () => {
    const panel = dash.joinPanel('overview');
    client.sent.length = 0;

    panel.publishWidget('w1', 'gauge' as never, { v: 1 }, 'Label', { filter: 'cpu' });

    const emit = client.sent.find((s) => s.op === 'emit');
    expect(emit!.topic).toBe(`${PREFIX}/widgets`);
    expect(emit!.options).toMatchObject({ filter: 'cpu' });
  });

  // ---- Legacy surface, kept working ----

  it('setMetricFilters targets only the metrics topic', () => {
    const panel = dash.joinPanel('overview');
    client.sent.length = 0;

    panel.setMetricFilters(['cpu']);

    const calls = client.sent.filter((s) => s.op === 'setFilters');
    expect(calls).toHaveLength(1);
    expect(calls[0].topic).toBe(`${PREFIX}/metrics`);
    expect(panel.filters.metrics).toEqual(['cpu']);
    expect(panel.filters.widgets).toEqual([]);
  });

  it('addMetricFilters and removeMetricFilters stay metrics-only', () => {
    const panel = dash.joinPanel('overview');
    panel.setMetricFilters(['cpu']);

    panel.addMetricFilters(['mem']);
    expect(panel.filters.metrics).toEqual(['cpu', 'mem']);
    expect(panel.filters.widgets).toEqual([]);

    panel.removeMetricFilters(['cpu']);
    expect(panel.filters.metrics).toEqual(['mem']);
  });

  it('joinPanel({ metricFilters }) filters metrics but not widgets', () => {
    dash.joinPanel('overview', { metricFilters: ['cpu'] });

    expect(client.topicFilters.get(`${PREFIX}/metrics`)).toEqual(['cpu']);
    expect(client.topicFilters.has(`${PREFIX}/widgets`)).toBe(false);
  });

  it('joinPanel({ metricFilters: [] }) still means "receive nothing"', () => {
    // The placeholder predates the uniform API. It is kept so existing panels
    // do not start flooding, and is the one place an empty array is not a
    // wildcard.
    const panel = dash.joinPanel('overview', { metricFilters: [] });

    expect(client.topicFilters.get(`${PREFIX}/metrics`)).toEqual(['__none__']);
    expect(panel.filters.metrics).toEqual(['__none__']);
  });

  it('adding to the no-match placeholder keeps the subscription filtered', () => {
    const panel = dash.joinPanel('overview', { metricFilters: [] });

    panel.addMetricFilters(['cpu']);

    expect(panel.filters.metrics).toEqual(['__none__', 'cpu']);
  });

  it('uniform setFilters([]) is a wildcard, unlike the legacy join option', () => {
    const panel = dash.joinPanel('overview', { filters: ['cpu'] });

    panel.setFilters([]);

    expect(panel.filters.metrics).toEqual([]);
    expect(client.topicFilters.has(`${PREFIX}/metrics`)).toBe(false);
  });

  it('re-points filters when re-joining an open panel', () => {
    dash.joinPanel('overview', { filters: ['cpu'] });

    const panel = dash.joinPanel('overview', { filters: ['mem'] });

    expect(panel.filters.metrics).toEqual(['mem']);
  });
});
