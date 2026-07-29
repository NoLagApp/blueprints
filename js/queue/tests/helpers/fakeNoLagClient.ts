/**
 * Canonical fake NoLag core client for wrapper SDK tests.
 *
 * CANONICAL COPY LIVES IN @nolag/chat (tests/helpers/fakeNoLagClient.ts).
 * Other wrapper packages carry byte-identical copies — keep them in sync.
 *
 * Mirrors the sharing-relevant semantics of the real client exactly:
 * - Set-based additive handlers; off(event, handler) removes one handler;
 *   off(event) with NO handler removes ALL (so tests can DETECT the
 *   forbidden bare-off usage by watching other consumers' handler counts).
 * - subscribe/unsubscribe are recorded; unsubscribe while disconnected
 *   invokes the callback with an error and does not throw.
 * - setApp(app).setRoom(room)/.setLobby(id) return faithful context fakes
 *   that prefix topics the way the real contexts do.
 * - Test drivers: fireConnect/fireDisconnect/fireReconnect/fireMessage/
 *   fireLobby/firePresence, plus handlerCount() and the sent[] record.
 */

type Handler = (...args: unknown[]) => void;

export interface FakeLobbyContext {
  lobbyId: string;
  subscribe: (cb?: (err: Error | null) => void) => Promise<Record<string, Record<string, unknown>>>;
  unsubscribe: (cb?: (err: Error | null) => void) => void;
  fetchPresence: () => Promise<Record<string, Record<string, unknown>>>;
}

export interface FakeRoomContext {
  prefix: string;
  subscribe: (topic: string) => void;
  unsubscribe: (topic: string, cb?: (err: Error | null) => void) => void;
  on: (topic: string, handler: Handler) => FakeRoomContext;
  off: (topic: string, handler?: Handler) => FakeRoomContext;
  emit: (topic: string, data: unknown, options?: unknown) => void;
  setPresence: (data: unknown) => void;
  fetchPresence: () => Promise<Array<{ actorTokenId: string; presence: unknown; joinedAt?: number }>>;
}

export class FakeNoLagClient {
  connected = false;
  actorId: string | null = null;
  actorType: string | null = null;
  projectId: string | null = null;

  /** Every subscribe/unsubscribe/emit/presence call, in order */
  sent: Array<{ op: string; topic?: string; data?: unknown }> = [];
  /** Next lobby snapshot returned by lobby.subscribe()/fetchPresence() */
  lobbySnapshot: Record<string, Record<string, unknown>> = {};

  private _handlers = new Map<string, Set<Handler>>();
  private _subscriptions = new Set<string>();

  // ============ Real-client API surface ============

  on(event: string, handler: Handler): this {
    if (!this._handlers.has(event)) this._handlers.set(event, new Set());
    this._handlers.get(event)!.add(handler);
    return this;
  }

  off(event: string, handler?: Handler): this {
    if (handler) {
      this._handlers.get(event)?.delete(handler);
    } else {
      // Mirrors the real client: bare off removes ALL handlers for the event.
      this._handlers.delete(event);
    }
    return this;
  }

  subscribe(topic: string, _options?: unknown, _cb?: unknown): void {
    this._subscriptions.add(topic);
    this.sent.push({ op: 'subscribe', topic });
  }

  unsubscribe(topic: string, cb?: (err: Error | null) => void): void {
    if (!this.connected) {
      cb?.(new Error('Not connected'));
      return;
    }
    this._subscriptions.delete(topic);
    this.sent.push({ op: 'unsubscribe', topic });
    cb?.(null);
  }

  emit(topic: string, data: unknown, _options?: unknown): void {
    this.sent.push({ op: 'emit', topic, data });
  }

  setPresence(data: unknown): void {
    this.sent.push({ op: 'setPresence', data });
  }

  setApp(appName: string) {
    const client = this;
    return {
      setRoom(roomName: string): FakeRoomContext {
        const prefix = `${appName}/${roomName}`;
        return {
          prefix,
          subscribe: (topic: string) => client.subscribe(`${prefix}/${topic}`),
          unsubscribe: (topic: string, cb?: (err: Error | null) => void) =>
            client.unsubscribe(`${prefix}/${topic}`, cb),
          on: function (topic: string, handler: Handler) {
            client.on(`${prefix}/${topic}`, handler);
            return this;
          },
          off: function (topic: string, handler?: Handler) {
            client.off(`${prefix}/${topic}`, handler);
            return this;
          },
          emit: (topic: string, data: unknown, options?: unknown) =>
            client.emit(`${prefix}/${topic}`, data, options),
          setPresence: (data: unknown) =>
            client.sent.push({ op: 'setPresence', topic: prefix, data }),
          fetchPresence: () => Promise.resolve([]),
        };
      },
      setLobby(lobbyId: string): FakeLobbyContext {
        return {
          lobbyId,
          subscribe: (cb?: (err: Error | null) => void) => {
            client.sent.push({ op: 'lobbySubscribe', topic: `${appName}:${lobbyId}` });
            cb?.(null);
            return Promise.resolve(client.lobbySnapshot);
          },
          unsubscribe: (cb?: (err: Error | null) => void) => {
            client.sent.push({ op: 'lobbyUnsubscribe', topic: `${appName}:${lobbyId}` });
            cb?.(null);
          },
          fetchPresence: () => {
            client.sent.push({ op: 'lobbyFetchPresence', topic: `${appName}:${lobbyId}` });
            return Promise.resolve(client.lobbySnapshot);
          },
        };
      },
    };
  }

  connect(): Promise<void> {
    this.fireConnect();
    return Promise.resolve();
  }

  disconnect(): void {
    this.connected = false;
    this._dispatch('disconnect', 'Client disconnect');
  }

  // ============ Test drivers ============

  /** Simulate a successful (re)auth: sets connected + actorId, fires 'connect' */
  fireConnect(actorId = 'actor-1'): void {
    this.connected = true;
    this.actorId = actorId;
    this._dispatch('connect');
  }

  fireDisconnect(reason = 'gone'): void {
    this.connected = false;
    this._dispatch('disconnect', reason);
  }

  fireReconnect(): void {
    this._dispatch('reconnect');
  }

  /** Deliver a message on a FULL topic (app/room/topic) */
  fireMessage(fullTopic: string, data: unknown, meta: unknown = {}): void {
    this._dispatch(fullTopic, data, meta);
  }

  /** Fire a lobbyPresence event: type is 'join' | 'leave' | 'update' */
  fireLobby(type: 'join' | 'leave' | 'update', event: unknown): void {
    this._dispatch(`lobbyPresence:${type}`, event);
  }

  /** Fire a room presence event: type is 'join' | 'leave' | 'update' */
  firePresence(type: 'join' | 'leave' | 'update', actorPresence: unknown): void {
    this._dispatch(`presence:${type}`, actorPresence);
  }

  fireError(err: Error): void {
    this._dispatch('error', err);
  }

  fireReplay(phase: 'start' | 'end', data: unknown): void {
    this._dispatch(`replay:${phase}`, data);
  }

  /** Number of handlers attached for an event or full topic */
  handlerCount(event: string): number {
    return this._handlers.get(event)?.size ?? 0;
  }

  /** All events that currently have at least one handler */
  handledEvents(): string[] {
    return [...this._handlers.entries()].filter(([, s]) => s.size > 0).map(([k]) => k);
  }

  /** Whether a full topic currently has a server-side subscription */
  isSubscribed(fullTopic: string): boolean {
    return this._subscriptions.has(fullTopic);
  }

  private _dispatch(event: string, ...args: unknown[]): void {
    const handlers = this._handlers.get(event);
    if (!handlers) return;
    for (const handler of [...handlers]) {
      handler(...args);
    }
  }
}

/** Convenience: a fake client typed loosely enough to inject into wrappers */
export function makeFakeClient(): FakeNoLagClient {
  return new FakeNoLagClient();
}
