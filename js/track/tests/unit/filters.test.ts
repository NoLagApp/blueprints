import { describe, it, expect, beforeEach } from 'vitest';
import { NoLagTrack } from '../../src/NoLagTrack';
import { makeFakeClient, FakeNoLagClient } from '../helpers/fakeNoLagClient';

/**
 * Filter API contract for @nolag/track.
 *
 * The locations topic is already managed: every update is published tagged
 * with its geo-grid cell, and geofences subscribe to the cells they overlap.
 * So user filters are UNIONED with the geofence cells rather than replacing
 * them — calling setFilters must never silently switch geofencing off.
 */

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

const PREFIX = 'track-app/fleet';

const GEOFENCE = {
  id: 'gf-1',
  name: 'depot',
  shape: 'circle' as const,
  center: { lat: 51.5074, lng: -0.1278 },
  radiusMeters: 100,
};

async function connected() {
  const client = makeFakeClient();
  const track = new NoLagTrack({
    client: client as never,
    appName: 'track-app',
    assetId: 'asset-1',
  } as never);
  client.fireConnect('actor-1');
  await flush();
  return { client, track };
}

describe('@nolag/track filters', () => {
  let client: FakeNoLagClient;
  let track: NoLagTrack;

  beforeEach(async () => {
    ({ client, track } = await connected());
  });

  it('subscribes unfiltered with no geofences and no filters', () => {
    track.joinZone('fleet');

    const sub = client.sent.find(
      (s) => s.op === 'subscribe' && s.topic === `${PREFIX}/locations`,
    );
    expect(sub!.options).toBeUndefined();
  });

  it('subscribes locations with join-time filters', () => {
    track.joinZone('fleet', { filters: ['fleet-a'] });

    expect(client.topicFilters.get(`${PREFIX}/locations`)).toEqual(['fleet-a']);
  });

  it('reports only the user-set values, not the geofence cells', () => {
    const zone = track.joinZone('fleet', { filters: ['fleet-a'] });
    zone.addGeofence(GEOFENCE);

    expect(zone.filters).toEqual(['fleet-a']);
  });

  it('unions user filters with geofence cells rather than replacing them', () => {
    const zone = track.joinZone('fleet', { filters: ['fleet-a'] });

    zone.addGeofence(GEOFENCE);

    const applied = client.topicFilters.get(`${PREFIX}/locations`) as string[];
    expect(applied).toContain('fleet-a');
    // Cell keys look like "g:51.50:-0.12"; at least one must be present.
    expect(applied.some((v) => v.startsWith('g:'))).toBe(true);
  });

  it('adding a geofence does not drop existing user filters', () => {
    const zone = track.joinZone('fleet', { filters: ['fleet-a'] });
    zone.addGeofence(GEOFENCE);

    const applied = client.topicFilters.get(`${PREFIX}/locations`) as string[];
    expect(applied).toContain('fleet-a');
  });

  it('setting filters does not drop the geofence cells', () => {
    const zone = track.joinZone('fleet');
    zone.addGeofence(GEOFENCE);

    zone.setFilters(['fleet-b']);

    const applied = client.topicFilters.get(`${PREFIX}/locations`) as string[];
    expect(applied).toContain('fleet-b');
    expect(applied.some((v) => v.startsWith('g:'))).toBe(true);
  });

  it('removing the last geofence leaves the user filters in place', () => {
    const zone = track.joinZone('fleet', { filters: ['fleet-a'] });
    zone.addGeofence(GEOFENCE);

    zone.removeGeofence('gf-1');

    expect(client.topicFilters.get(`${PREFIX}/locations`)).toEqual(['fleet-a']);
  });

  it('clearing user filters with no geofences restores the wildcard', () => {
    const zone = track.joinZone('fleet', { filters: ['fleet-a'] });

    zone.setFilters([]);

    expect(zone.filters).toEqual([]);
    expect(client.topicFilters.has(`${PREFIX}/locations`)).toBe(false);
  });

  it('addFilters and removeFilters adjust only the user set', () => {
    const zone = track.joinZone('fleet', { filters: ['fleet-a'] });

    zone.addFilters(['fleet-b']);
    expect(zone.filters).toEqual(['fleet-a', 'fleet-b']);

    zone.removeFilters(['fleet-a']);
    expect(zone.filters).toEqual(['fleet-b']);
  });

  it('sendLocation tags with the grid cell by default', () => {
    const zone = track.joinZone('fleet');
    client.sent.length = 0;

    zone.sendLocation({ lat: 51.5074, lng: -0.1278 });

    const emit = client.sent.find((s) => s.op === 'emit');
    const filter = (emit!.options as { filter?: string }).filter;
    expect(filter).toMatch(/^g:/);
  });

  it('an explicit filter replaces the grid-cell tag', () => {
    const zone = track.joinZone('fleet');
    client.sent.length = 0;

    zone.sendLocation({ lat: 51.5074, lng: -0.1278 }, undefined, { filter: 'fleet-a' });

    const emit = client.sent.find((s) => s.op === 'emit');
    expect(emit!.options).toMatchObject({ filter: 'fleet-a' });
  });

  it('an explicit AND composite also replaces the grid-cell tag', () => {
    const zone = track.joinZone('fleet');
    client.sent.length = 0;

    zone.sendLocation({ lat: 51.5074, lng: -0.1278 }, undefined, {
      filters: ['fleet-a', 'eu'],
    });

    const emit = client.sent.find((s) => s.op === 'emit');
    expect(emit!.options).toMatchObject({ filters: ['fleet-a', 'eu'] });
    expect((emit!.options as { filter?: string }).filter).toBeUndefined();
  });

  it('re-points filters when re-joining an open zone', () => {
    track.joinZone('fleet', { filters: ['fleet-a'] });

    const zone = track.joinZone('fleet');

    // Re-joining without filters leaves the existing set untouched.
    expect(zone.filters).toEqual(['fleet-a']);
  });
});
