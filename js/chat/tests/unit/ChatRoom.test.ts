import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ChatRoom } from '../../src/ChatRoom';
import type { ChatUser, ResolvedChatOptions, ChatPresenceData } from '../../src/types';
import type { RoomContext, MessageHandler, MessageMeta } from '@nolag/js-sdk';

// Mock RoomContext
function createMockRoomContext(): RoomContext & {
  _handlers: Map<string, MessageHandler>;
  _fireMessage: (topic: string, data: unknown, meta: MessageMeta) => void;
} {
  const handlers = new Map<string, MessageHandler>();
  const ctx: any = {
    prefix: 'chat/general',
    _handlers: handlers,
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
    emit: vi.fn(),
    on: vi.fn((topic: string, handler: MessageHandler) => {
      handlers.set(topic, handler);
      return ctx;
    }),
    off: vi.fn((topic: string) => {
      handlers.delete(topic);
      return ctx;
    }),
    setPresence: vi.fn(),
    getPresence: vi.fn(() => ({})),
    fetchPresence: vi.fn(() => Promise.resolve([])),
    _fireMessage(topic: string, data: unknown, meta: MessageMeta) {
      const h = handlers.get(topic);
      if (h) h(data, meta);
    },
  };
  return ctx;
}

function createLocalUser(): ChatUser {
  return {
    userId: 'local-uid',
    actorTokenId: 'local-actor',
    username: 'LocalUser',
    avatar: 'https://example.com/avatar.png',
    status: 'online',
    joinedAt: Date.now(),
    isLocal: true,
  };
}

function createOptions(): ResolvedChatOptions {
  return {
    username: 'LocalUser',
    avatar: 'https://example.com/avatar.png',
    appName: 'chat',
    typingTimeout: 3000,
    maxMessageCache: 500,
    debug: false,
    reconnect: true,
  };
}

const noop = () => {};

describe('ChatRoom', () => {
  let room: ChatRoom;
  let ctx: ReturnType<typeof createMockRoomContext>;

  beforeEach(() => {
    ctx = createMockRoomContext();
    room = new ChatRoom('general', ctx, createLocalUser(), createOptions(), noop);
  });

  describe('_subscribe', () => {
    it('should subscribe to messages and _typing topics', () => {
      room._subscribe();

      expect(ctx.subscribe).toHaveBeenCalledWith('messages');
      expect(ctx.subscribe).toHaveBeenCalledWith('_typing');
    });

    it('should listen for messages', () => {
      room._subscribe();
      expect(ctx.on).toHaveBeenCalledWith('messages', expect.any(Function));
    });

    it('should listen for typing', () => {
      room._subscribe();
      expect(ctx.on).toHaveBeenCalledWith('_typing', expect.any(Function));
    });
  });

  describe('_activate', () => {
    it('should set room presence', () => {
      room._subscribe();
      room._activate();

      expect(ctx.setPresence).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'local-uid',
          username: 'LocalUser',
          status: 'online',
        }),
      );
    });
  });

  describe('incoming messages', () => {
    it('should emit "message" for incoming messages', () => {
      room._subscribe();
      const handler = vi.fn();
      room.on('message', handler);

      ctx._fireMessage('messages', {
        id: 'msg-1',
        userId: 'remote-uid',
        username: 'RemoteUser',
        text: 'Hello!',
        timestamp: 1000,
      }, { isReplay: false });

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'msg-1',
          userId: 'remote-uid',
          text: 'Hello!',
          isReplay: false,
          status: 'delivered',
        }),
      );
    });

    it('should deduplicate messages by id', () => {
      room._subscribe();
      const handler = vi.fn();
      room.on('message', handler);

      const msg = {
        id: 'msg-1',
        userId: 'remote-uid',
        username: 'RemoteUser',
        text: 'Hello!',
        timestamp: 1000,
      };

      ctx._fireMessage('messages', msg, { isReplay: false });
      ctx._fireMessage('messages', msg, { isReplay: false });

      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('should mark replayed messages', () => {
      room._subscribe();
      const handler = vi.fn();
      room.on('message', handler);

      ctx._fireMessage('messages', {
        id: 'msg-replay',
        userId: 'remote-uid',
        username: 'RemoteUser',
        text: 'Old message',
        timestamp: 500,
      }, { isReplay: true });

      expect(handler.mock.calls[0][0].isReplay).toBe(true);
    });
  });

  describe('sendMessage', () => {
    it('should emit to room context with echo: false', () => {
      room._subscribe();
      const msg = room.sendMessage('Hello!');

      expect(ctx.emit).toHaveBeenCalledWith(
        'messages',
        expect.objectContaining({
          userId: 'local-uid',
          username: 'LocalUser',
          text: 'Hello!',
        }),
        { echo: false },
      );
      expect(msg.status).toBe('sent');
      expect(msg.isReplay).toBe(false);
    });

    it('should emit "messageSent" event', () => {
      room._subscribe();
      const handler = vi.fn();
      room.on('messageSent', handler);

      room.sendMessage('Test');

      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('should add message to local store', () => {
      room._subscribe();
      room.sendMessage('One');
      room.sendMessage('Two');

      expect(room.getMessages().length).toBe(2);
    });
  });

  describe('typing', () => {
    it('should emit typing signals via room context', () => {
      vi.useFakeTimers();
      room._subscribe();

      room.startTyping();

      expect(ctx.emit).toHaveBeenCalledWith(
        '_typing',
        { userId: 'local-uid', typing: true },
        { echo: false },
      );

      vi.useRealTimers();
    });

    it('should emit "typing" event for remote typing', () => {
      room._subscribe();
      const handler = vi.fn();
      room.on('typing', handler);

      // Simulate remote typing
      ctx._fireMessage('_typing', { userId: 'remote-uid', typing: true }, {});

      expect(handler).toHaveBeenCalledWith({ users: [] }); // empty because remote-uid not in presence
    });
  });

  describe('presence events', () => {
    it('should emit userJoined on _handlePresenceJoin', () => {
      room._subscribe();
      const handler = vi.fn();
      room.on('userJoined', handler);

      room._handlePresenceJoin('actor-remote', {
        userId: 'u-remote',
        username: 'RemoteUser',
        status: 'online',
      });

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'u-remote',
          username: 'RemoteUser',
        }),
      );
    });

    it('should emit userLeft on _handlePresenceLeave', () => {
      room._subscribe();
      const joinHandler = vi.fn();
      const leaveHandler = vi.fn();
      room.on('userJoined', joinHandler);
      room.on('userLeft', leaveHandler);

      room._handlePresenceJoin('actor-remote', {
        userId: 'u-remote',
        username: 'RemoteUser',
        status: 'online',
      });

      room._handlePresenceLeave('actor-remote');

      expect(leaveHandler).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'u-remote' }),
      );
    });

    it('should not emit for self', () => {
      room._subscribe();
      const handler = vi.fn();
      room.on('userJoined', handler);

      room._handlePresenceJoin('local-actor', {
        userId: 'local-uid',
        username: 'LocalUser',
        status: 'online',
      });

      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe('getUsers', () => {
    it('should return all remote users', () => {
      room._subscribe();

      room._handlePresenceJoin('actor-1', {
        userId: 'u1',
        username: 'Alice',
        status: 'online',
      });
      room._handlePresenceJoin('actor-2', {
        userId: 'u2',
        username: 'Bob',
        status: 'online',
      });

      expect(room.getUsers().length).toBe(2);
    });
  });

  describe('_cleanup', () => {
    it('should unsubscribe and remove all listeners', () => {
      room._subscribe();
      room._cleanup();

      expect(ctx.unsubscribe).toHaveBeenCalledWith('messages');
      expect(ctx.unsubscribe).toHaveBeenCalledWith('_typing');
      expect(ctx.off).toHaveBeenCalledWith('messages');
      expect(ctx.off).toHaveBeenCalledWith('_typing');
    });
  });
});
