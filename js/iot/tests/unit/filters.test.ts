import { describe, it, expect, beforeEach } from 'vitest';
import { NoLagIoT } from '../../src/NoLagIoT';
import { makeFakeClient, FakeNoLagClient } from '../helpers/fakeNoLagClient';

/**
 * Filter API contract for @nolag/iot.
 *
 * Filters cover telemetry only. Commands and command acks already route by
 * deviceId internally — that is what makes a command reach one device and its
 * ack reach the controller that sent it — so the public filter API must not
 * be able to repoint them.
 */

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

const PREFIX = 'iot-app/factory';

async function connected(role: 'device' | 'controller' = 'controller') {
  const client = makeFakeClient();
  const iot = new NoLagIoT({
    client: client as never,
    appName: 'iot-app',
    deviceId: 'dev-1',
    role,
  } as never);
  client.fireConnect('actor-1');
  await flush();
  return { client, iot };
}

describe('@nolag/iot filters', () => {
  let client: FakeNoLagClient;
  let iot: NoLagIoT;

  beforeEach(async () => {
    ({ client, iot } = await connected());
  });

  it('subscribes telemetry unfiltered by default', () => {
    iot.joinGroup('factory');

    const sub = client.sent.find(
      (s) => s.op === 'subscribe' && s.topic === `${PREFIX}/telemetry`,
    );
    expect(sub!.options).toBeUndefined();
  });

  it('subscribes telemetry with join-time filters', () => {
    iot.joinGroup('factory', { filters: ['site-a'] });

    expect(client.topicFilters.get(`${PREFIX}/telemetry`)).toEqual(['site-a']);
  });

  it('leaves the command ack filter keyed to this controller', () => {
    iot.joinGroup('factory', { filters: ['site-a'] });

    // The ack subscription must stay on the controller's own deviceId.
    expect(client.topicFilters.get(`${PREFIX}/_cmd_ack`)).toEqual(['dev-1']);
  });

  it('leaves the command filter keyed to the device id', async () => {
    const device = await connected('device');
    device.iot.joinGroup('factory', { filters: ['site-a'] });

    expect(device.client.topicFilters.get(`${PREFIX}/commands`)).toEqual(['dev-1']);
  });

  it('setFilters only touches telemetry', () => {
    const group = iot.joinGroup('factory');
    client.sent.length = 0;

    group.setFilters(['site-b']);

    const calls = client.sent.filter((s) => s.op === 'setFilters');
    expect(calls).toHaveLength(1);
    expect(calls[0].topic).toBe(`${PREFIX}/telemetry`);
    expect(group.filters).toEqual(['site-b']);
  });

  it('setFilters does not disturb the ack routing', () => {
    const group = iot.joinGroup('factory');

    group.setFilters(['site-b']);

    expect(client.topicFilters.get(`${PREFIX}/_cmd_ack`)).toEqual(['dev-1']);
  });

  it('setFilters([]) reverts telemetry to the wildcard subscription', () => {
    const group = iot.joinGroup('factory', { filters: ['site-a'] });

    group.setFilters([]);

    expect(group.filters).toEqual([]);
    expect(client.topicFilters.has(`${PREFIX}/telemetry`)).toBe(false);
  });

  it('addFilters and removeFilters adjust the set', () => {
    const group = iot.joinGroup('factory', { filters: ['site-a'] });

    group.addFilters(['site-b']);
    expect(group.filters).toEqual(['site-a', 'site-b']);

    group.removeFilters(['site-a']);
    expect(group.filters).toEqual(['site-b']);
  });

  it('sendTelemetry routes with the given filter', () => {
    const group = iot.joinGroup('factory');
    client.sent.length = 0;

    group.sendTelemetry('temp', 21, { filter: 'site-a' });

    const emit = client.sent.find((s) => s.op === 'emit');
    expect(emit!.topic).toBe(`${PREFIX}/telemetry`);
    expect(emit!.options).toMatchObject({ filter: 'site-a' });
  });

  it('sendTelemetry supports an AND composite filter', () => {
    const group = iot.joinGroup('factory');
    client.sent.length = 0;

    group.sendTelemetry('temp', 21, { filters: ['site-a', 'critical'] });

    const emit = client.sent.find((s) => s.op === 'emit');
    expect(emit!.options).toMatchObject({ filters: ['site-a', 'critical'] });
  });

  it('unfiltered telemetry carries no filter fields', () => {
    const group = iot.joinGroup('factory');
    client.sent.length = 0;

    group.sendTelemetry('temp', 21);

    const options = client.sent.find((s) => s.op === 'emit')!.options as Record<string, unknown>;
    expect(options.filter).toBeUndefined();
    expect(options.filters).toBeUndefined();
  });

  it('a command still targets the device, not the telemetry filter', () => {
    const group = iot.joinGroup('factory', { filters: ['site-a'] });
    client.sent.length = 0;

    group.sendCommand('dev-9', 'reboot');

    const emit = client.sent.find(
      (s) => s.op === 'emit' && s.topic === `${PREFIX}/commands`,
    );
    expect(emit!.options).toMatchObject({ filter: 'dev-9' });
  });

  it('re-points filters when re-joining an open group', () => {
    iot.joinGroup('factory', { filters: ['site-a'] });

    const group = iot.joinGroup('factory', { filters: ['site-b'] });

    expect(group.filters).toEqual(['site-b']);
  });
});
