import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FeedChannel } from '../../src/FeedChannel';
import type { FeedUser, ResolvedFeedOptions } from '../../src/types';
import type { MessageMeta } from '@nolag/js-sdk';

function createMockRoomContext() {
  const handlers = new Map<string, Function>();
  const ctx: any = {
    subscribe: vi.fn(), unsubscribe: vi.fn(), emit: vi.fn(),
    on: vi.fn((t: string, h: Function) => { handlers.set(t, h); return ctx; }),
    off: vi.fn((t: string) => { handlers.delete(t); return ctx; }),
    setPresence: vi.fn(), fetchPresence: vi.fn(() => Promise.resolve([])),
    _fire(t: string, d: unknown, m: MessageMeta) { handlers.get(t)?.(d, m); },
  };
  return ctx;
}

describe('FeedChannel', () => {
  let ch: FeedChannel;
  let ctx: ReturnType<typeof createMockRoomContext>;

  beforeEach(() => {
    ctx = createMockRoomContext();
    const user: FeedUser = { userId: 'u1', actorTokenId: 'a1', username: 'Alice', joinedAt: Date.now(), isLocal: true };
    const opts: ResolvedFeedOptions = { username: 'Alice', appName: 'feed', maxPostCache: 200, maxCommentCache: 100, debug: false, reconnect: true, channels: [] };
    ch = new FeedChannel('main', ctx, user, opts, () => {});
  });

  it('should subscribe to all topics', () => {
    ch._subscribe();
    expect(ctx.subscribe).toHaveBeenCalledWith('posts');
    expect(ctx.subscribe).toHaveBeenCalledWith('reactions');
    expect(ctx.subscribe).toHaveBeenCalledWith('comments');
  });

  it('should create and send a post', () => {
    ch._subscribe();
    const post = ch.createPost({ content: 'Hello!' });
    expect(post.content).toBe('Hello!');
    expect(ctx.emit).toHaveBeenCalledWith('posts', expect.objectContaining({ content: 'Hello!' }), { echo: false });
  });

  it('should receive incoming posts', () => {
    ch._subscribe();
    const handler = vi.fn();
    ch.on('postCreated', handler);
    ctx._fire('posts', { id: 'p1', userId: 'u2', username: 'Bob', content: 'Hi', timestamp: 1000 }, { isReplay: false });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('should like/unlike posts', () => {
    ch._subscribe();
    ch.createPost({ content: 'test' });
    const likeHandler = vi.fn();
    ch.on('postLiked', likeHandler);
    ch.likePost('nonexistent'); // just exercises the path
    expect(likeHandler).toHaveBeenCalled();
  });

  it('should cleanup', () => {
    ch._subscribe();
    ch._cleanup();
    expect(ctx.unsubscribe).toHaveBeenCalledWith('posts');
  });
});
