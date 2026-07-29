/**
 * E2E: the @nolag/chat wrapper on an INJECTED core client, against a real
 * broker, authenticated with browser client tokens (HS256 JWTs).
 *
 * Proves the headline of the v1.0.0 refactor: the app owns one core client,
 * wrappers attach/detach on it, and multiple wrappers (distinct apps) share
 * ONE socket.
 *
 * Prerequisites (env, e.g. .env.test):
 *   NOLAG_API_KEY      Project API key — creates the test actor
 *   NOLAG_SIGNING_KEY  Signing key (sk_live_<kid>.<secret>) in the SAME project
 *   NOLAG_CHAT_APP     Chat app slug (default terracast-chat-4728)
 *   NOLAG_NOTIFY_APP   A second app slug for the shared-socket test
 *   NOLAG_TEST_URL     Broker WS URL (default wss://broker.nolag.app/ws)
 *
 * Run: npx vitest run --config vitest.e2e.config.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHmac } from 'crypto';
// The core client comes from the peer SDK, exactly as an app would import it.
import { NoLag, NoLagApi } from '@nolag/js-sdk';
import type { NoLagSocket } from '@nolag/js-sdk';
import { NoLagChat } from '../../src/index';

const TEST_URL = process.env.NOLAG_TEST_URL || 'wss://broker.nolag.app/ws';
const API_KEY = process.env.NOLAG_API_KEY;
const SIGNING_KEY = process.env.NOLAG_SIGNING_KEY;
const CHAT_APP = process.env.NOLAG_CHAT_APP || 'terracast-chat-4728';
const NOTIFY_APP = process.env.NOLAG_NOTIFY_APP || 'terracast-notifications-dcf5';

const haveCreds = !!API_KEY && !!SIGNING_KEY;

function base64url(input: string): string {
  return Buffer.from(input).toString('base64url');
}
function signJwt(claims: Record<string, unknown>, signingKey: string): string {
  const [kid, secret] = signingKey.split('.');
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT', kid }));
  const payload = base64url(JSON.stringify(claims));
  const data = `${header}.${payload}`;
  const sig = createHmac('sha256', secret).update(data).digest('base64url');
  return `${data}.${sig}`;
}
const nowSec = () => Math.floor(Date.now() / 1000);

describe.skipIf(!haveCreds)('chat wrapper on injected client (E2E)', () => {
  let api: InstanceType<typeof NoLagApi>;
  let actorKeyId: string;
  let actorTokenId: string;

  const mint = (): string =>
    signJwt({ sub: actorKeyId, iat: nowSec(), exp: nowSec() + 900 }, SIGNING_KEY!);

  const newClient = (): NoLagSocket =>
    NoLag(() => mint(), { url: TEST_URL, reconnect: false }) as NoLagSocket;

  beforeAll(async () => {
    api = new NoLagApi(API_KEY!);
    const actor = await api.actors.create({
      name: `e2e-chat-injected-${Date.now()}`,
      actorType: 'user',
    });
    actorKeyId = actor.keyId;
    actorTokenId = actor.actorTokenId;
  }, 30000);

  afterAll(async () => {
    if (actorKeyId) {
      await api.request('DELETE', `/actors/${actorKeyId}`).catch(() => {});
    }
  });

  it('attaches to an app-owned client, ready() resolves, detach() keeps the socket', async () => {
    const client = newClient();
    const chat = new NoLagChat({ client, appName: CHAT_APP, username: 'E2E Alice' });

    await client.connect(); // the app owns the connection
    await chat.ready(); // wrapper setup complete

    expect(client.connected).toBe(true);
    expect(chat.localUser?.actorTokenId).toBe(actorTokenId);

    // detach releases the wrapper but must NOT close the socket
    chat.detach();
    expect(client.connected).toBe(true);

    client.disconnect();
  });

  it('runs two wrappers (distinct apps) on ONE socket; detaching one leaves the other live', async () => {
    const client = newClient();
    const chatA = new NoLagChat({ client, appName: CHAT_APP, username: 'A' });
    const chatB = new NoLagChat({ client, appName: NOTIFY_APP, username: 'B' });

    await client.connect();
    await Promise.all([chatA.ready(), chatB.ready()]);
    expect(client.connected).toBe(true);

    // Join a room on each — both ride the same socket.
    const roomA = chatA.joinRoom('e2e-room');
    chatB.joinRoom('e2e-room');
    expect(roomA).toBeTruthy();

    // Detach A; the shared socket and B stay up.
    chatA.detach();
    expect(client.connected).toBe(true);
    expect(chatB.connected).toBe(true);

    // B can still act on the live connection.
    chatB.joinRoom('e2e-room-2');

    chatB.detach();
    client.disconnect();
  });

  it('reconnect-free token refresh: the wrapper survives an in-band reauth', async () => {
    const client = newClient();
    const chat = new NoLagChat({ client, appName: CHAT_APP, username: 'Refresher' });
    const disconnects: unknown[] = [];
    chat.on('disconnected', (r: unknown) => disconnects.push(r));

    await client.connect();
    await chat.ready();

    // Refresh credentials over the live socket — the wrapper should not see a
    // disconnect (its handlers and rooms stay attached to the same client).
    const ok = await (client as unknown as {
      _sendReauth(t: string): Promise<boolean>;
    })._sendReauth(mint());
    expect(ok).toBe(true);
    expect(client.connected).toBe(true);
    expect(disconnects).toEqual([]);

    chat.detach();
    client.disconnect();
  });
});
