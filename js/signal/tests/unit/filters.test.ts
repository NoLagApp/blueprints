import { describe, it, expect, beforeEach } from 'vitest';
import { NoLagSignal } from '../../src/NoLagSignal';
import { makeFakeClient, FakeNoLagClient } from '../helpers/fakeNoLagClient';

/**
 * Filter API contract for @nolag/signal.
 *
 * Signaling defaults to a room broadcast with peers discarding what is not
 * addressed to them. Filters move that addressing to the server: each peer
 * filters on its own peerId and sends with `filter: toPeerId`.
 *
 * This is exclusive rather than additive — a filtered peer no longer receives
 * the unfiltered broadcasts other peers send — so it is opt-in and the whole
 * room has to adopt it together.
 */

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

const PREFIX = 'signal-app/call-1';

async function connected() {
  const client = makeFakeClient();
  const signal = new NoLagSignal({ client: client as never, appName: 'signal-app' } as never);
  client.fireConnect('actor-1');
  await flush();
  return { client, signal };
}

describe('@nolag/signal filters', () => {
  let client: FakeNoLagClient;
  let signal: NoLagSignal;

  beforeEach(async () => {
    ({ client, signal } = await connected());
  });

  it('subscribes unfiltered by default, preserving broadcast signaling', () => {
    signal.joinRoom('call-1');

    const sub = client.sent.find(
      (s) => s.op === 'subscribe' && s.topic === `${PREFIX}/signaling`,
    );
    expect(sub!.options).toBeUndefined();
  });

  it('subscribes signaling with join-time filters', () => {
    signal.joinRoom('call-1', { filters: ['peer-a'] });

    expect(client.topicFilters.get(`${PREFIX}/signaling`)).toEqual(['peer-a']);
  });

  it('exposes the local peer id to filter on', () => {
    const room = signal.joinRoom('call-1');

    expect(typeof room.localPeerId).toBe('string');
    expect(room.localPeerId.length).toBeGreaterThan(0);
  });

  it('setFilters replaces the set', () => {
    const room = signal.joinRoom('call-1');

    room.setFilters([room.localPeerId]);

    expect(room.filters).toEqual([room.localPeerId]);
    expect(client.topicFilters.get(`${PREFIX}/signaling`)).toEqual([room.localPeerId]);
  });

  it('setFilters([]) returns the peer to room broadcast', () => {
    const room = signal.joinRoom('call-1', { filters: ['peer-a'] });

    room.setFilters([]);

    expect(room.filters).toEqual([]);
    expect(client.topicFilters.has(`${PREFIX}/signaling`)).toBe(false);
  });

  it('addFilters and removeFilters adjust the set', () => {
    const room = signal.joinRoom('call-1', { filters: ['peer-a'] });

    room.addFilters(['peer-b']);
    expect(room.filters).toEqual(['peer-a', 'peer-b']);

    room.removeFilters(['peer-a']);
    expect(room.filters).toEqual(['peer-b']);
  });

  it('signal broadcasts unfiltered by default', () => {
    const room = signal.joinRoom('call-1');
    client.sent.length = 0;

    room.signal('peer-b', 'offer', { sdp: 'x' });

    const emit = client.sent.find((s) => s.op === 'emit');
    expect(emit!.topic).toBe(`${PREFIX}/signaling`);
    expect((emit!.options as Record<string, unknown>).filter).toBeUndefined();
  });

  it('signal routes directly when given a filter', () => {
    const room = signal.joinRoom('call-1');
    client.sent.length = 0;

    room.signal('peer-b', 'offer', { sdp: 'x' }, { filter: 'peer-b' });

    const emit = client.sent.find((s) => s.op === 'emit');
    expect(emit!.options).toMatchObject({ filter: 'peer-b' });
  });

  it('sendOffer forwards its filter through to the publish', () => {
    const room = signal.joinRoom('call-1');
    client.sent.length = 0;

    room.sendOffer('peer-b', { type: 'offer', sdp: 'x' } as never, { filter: 'peer-b' });

    const emit = client.sent.find((s) => s.op === 'emit');
    expect(emit!.options).toMatchObject({ filter: 'peer-b' });
  });

  it('sendAnswer, sendIceCandidate and sendBye all accept a filter', () => {
    const room = signal.joinRoom('call-1');

    for (const send of [
      () => room.sendAnswer('peer-b', { type: 'answer', sdp: 'x' } as never, { filter: 'peer-b' }),
      () => room.sendIceCandidate('peer-b', { candidate: 'c' } as never, { filter: 'peer-b' }),
      () => room.sendBye('peer-b', { filter: 'peer-b' }),
    ]) {
      client.sent.length = 0;
      send();
      const emit = client.sent.find((s) => s.op === 'emit');
      expect(emit!.options).toMatchObject({ filter: 'peer-b' });
    }
  });

  it('re-points filters when re-joining an open room', () => {
    signal.joinRoom('call-1', { filters: ['peer-a'] });

    const room = signal.joinRoom('call-1', { filters: ['peer-b'] });

    expect(room.filters).toEqual(['peer-b']);
  });
});
