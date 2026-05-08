import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NotifyChannel } from '../../src/NotifyChannel';
import type { ResolvedNotifyOptions } from '../../src/types';
import type { RoomContext, MessageMeta } from '@nolag/js-sdk';

type MessageHandler = (data: unknown, meta: MessageMeta) => void;

function createMockRoomContext() {
  const handlers = new Map<string, MessageHandler>();
  const ctx: any = {
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
    emit: vi.fn(),
    on: vi.fn((topic: string, handler: MessageHandler) => { handlers.set(topic, handler); return ctx; }),
    off: vi.fn((topic: string) => { handlers.delete(topic); return ctx; }),
    setPresence: vi.fn(),
    fetchPresence: vi.fn(() => Promise.resolve([])),
    _handlers: handlers,
    _fire(topic: string, data: unknown, meta: MessageMeta) { handlers.get(topic)?.(data, meta); },
  };
  return ctx;
}

function createOptions(): ResolvedNotifyOptions {
  return { appName: 'notify', maxNotificationCache: 500, debug: false, reconnect: true, channels: [] };
}

describe('NotifyChannel', () => {
  let channel: NotifyChannel;
  let ctx: ReturnType<typeof createMockRoomContext>;

  beforeEach(() => {
    ctx = createMockRoomContext();
    channel = new NotifyChannel('alerts', ctx, createOptions(), () => {});
  });

  it('should subscribe to notifications and _read topics', () => {
    channel._subscribe();
    expect(ctx.subscribe).toHaveBeenCalledWith('notifications');
    expect(ctx.subscribe).toHaveBeenCalledWith('_read');
  });

  it('should emit notification event on incoming', () => {
    channel._subscribe();
    const handler = vi.fn();
    channel.on('notification', handler);
    ctx._fire('notifications', { id: 'n1', title: 'Hello', timestamp: 1000 }, { isReplay: false });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0].title).toBe('Hello');
  });

  it('should deduplicate notifications', () => {
    channel._subscribe();
    const handler = vi.fn();
    channel.on('notification', handler);
    ctx._fire('notifications', { id: 'n1', title: 'Hello', timestamp: 1000 }, { isReplay: false });
    ctx._fire('notifications', { id: 'n1', title: 'Hello', timestamp: 1000 }, { isReplay: false });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('should send notification via room context', () => {
    channel._subscribe();
    channel.send('Test Title', { body: 'Test body' });
    expect(ctx.emit).toHaveBeenCalledWith('notifications', expect.objectContaining({ title: 'Test Title', body: 'Test body' }));
  });

  it('should mark read and emit event', () => {
    channel._subscribe();
    ctx._fire('notifications', { id: 'n1', title: 'Hello', timestamp: 1000 }, { isReplay: false });
    const handler = vi.fn();
    channel.on('read', handler);
    channel.markRead('n1');
    expect(handler).toHaveBeenCalledWith('n1');
    expect(channel.unreadCount).toBe(0);
  });

  it('should cleanup properly', () => {
    channel._subscribe();
    channel._cleanup();
    expect(ctx.unsubscribe).toHaveBeenCalledWith('notifications');
    expect(ctx.unsubscribe).toHaveBeenCalledWith('_read');
  });
});
