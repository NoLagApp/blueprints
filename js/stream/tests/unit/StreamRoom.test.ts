import { describe, it, expect, vi, beforeEach } from 'vitest';
import { StreamRoom } from '../../src/StreamRoom';
import type { StreamViewer, ResolvedStreamOptions, StreamPresenceData } from '../../src/types';
import type { MessageMeta } from '@nolag/js-sdk';

function createMockRoomContext() {
  const handlers = new Map<string, Function>();
  const ctx: any = {
    subscribe: vi.fn(), unsubscribe: vi.fn(), emit: vi.fn(),
    on: vi.fn((topic: string, handler: Function) => { handlers.set(topic, handler); return ctx; }),
    off: vi.fn((topic: string, _handler?: Function) => { handlers.delete(topic); return ctx; }),
    setPresence: vi.fn(), fetchPresence: vi.fn(() => Promise.resolve([])),
    _fire(topic: string, data: unknown, meta: MessageMeta) { handlers.get(topic)?.(data, meta); },
  };
  return ctx;
}

function createLocalViewer(): StreamViewer {
  return { viewerId: 'local-v', actorTokenId: 'local-actor', username: 'Host', role: 'host', joinedAt: Date.now(), isLocal: true };
}

function createOptions(): ResolvedStreamOptions {
  return { username: 'Host', role: 'host', appName: 'stream', maxCommentCache: 500, reactionWindow: 3000, debug: false, streams: [] };
}

describe('StreamRoom', () => {
  let room: StreamRoom;
  let ctx: ReturnType<typeof createMockRoomContext>;

  beforeEach(() => {
    ctx = createMockRoomContext();
    room = new StreamRoom('live-1', ctx, createLocalViewer(), createOptions(), () => {}, () => true);
  });

  it('should subscribe to all topics', () => {
    room._subscribe();
    expect(ctx.subscribe).toHaveBeenCalledWith('comments');
    expect(ctx.subscribe).toHaveBeenCalledWith('_reactions');
    expect(ctx.subscribe).toHaveBeenCalledWith('polls');
  });

  it('should emit comment on incoming', () => {
    room._subscribe();
    const handler = vi.fn();
    room.on('comment', handler);
    ctx._fire('comments', { id: 'c1', viewerId: 'v2', username: 'Bob', text: 'Hi!', timestamp: 1000 }, { isReplay: false });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('should send comment', () => {
    room._subscribe();
    const comment = room.sendComment('Hello!');
    expect(ctx.emit).toHaveBeenCalledWith('comments', expect.objectContaining({ text: 'Hello!' }), { echo: false });
    expect(comment.status).toBe('sent');
  });

  it('should handle presence join/leave', () => {
    room._subscribe();
    const joinHandler = vi.fn();
    const leaveHandler = vi.fn();
    room.on('viewerJoined', joinHandler);
    room.on('viewerLeft', leaveHandler);

    room._handlePresenceJoin('actor-2', { viewerId: 'v2', username: 'Bob', role: 'viewer' } as StreamPresenceData);
    expect(joinHandler).toHaveBeenCalled();

    room._handlePresenceLeave('actor-2');
    expect(leaveHandler).toHaveBeenCalled();
  });

  it('should cleanup (unsubscribes and handler-specific off when connected)', () => {
    room._subscribe();
    room._cleanup();
    expect(ctx.unsubscribe).toHaveBeenCalledWith('comments');
    expect(ctx.unsubscribe).toHaveBeenCalledWith('_reactions');
    expect(ctx.unsubscribe).toHaveBeenCalledWith('polls');
    // handler-specific removal: off called with the topic AND a handler ref,
    // never a bare off(topic)
    expect(ctx.off).toHaveBeenCalledWith('comments', expect.any(Function));
    expect(ctx.off).toHaveBeenCalledWith('_reactions', expect.any(Function));
    expect(ctx.off).toHaveBeenCalledWith('polls', expect.any(Function));
  });

  it('skips server unsubscribes on cleanup when disconnected but still removes handlers', () => {
    const offlineRoom = new StreamRoom('live-1', ctx, createLocalViewer(), createOptions(), () => {}, () => false);
    offlineRoom._subscribe();
    offlineRoom._cleanup();
    expect(ctx.unsubscribe).not.toHaveBeenCalled();
    expect(ctx.off).toHaveBeenCalledWith('comments', expect.any(Function));
  });
});
