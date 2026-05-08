import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SignalRoom } from '../../src/SignalRoom';
import type { Peer, ResolvedSignalOptions, SignalPresenceData } from '../../src/types';
import type { RoomContext, MessageHandler } from '@nolag/js-sdk';

// Mock RoomContext
function createMockRoomContext(): RoomContext & {
  _handlers: Map<string, MessageHandler>;
  _fireMessage: (topic: string, data: unknown) => void;
} {
  const handlers = new Map<string, MessageHandler>();
  const ctx: any = {
    prefix: 'signal/call-room',
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
    _fireMessage(topic: string, data: unknown) {
      const h = handlers.get(topic);
      if (h) h(data, {});
    },
  };
  return ctx;
}

function createLocalPeer(): Peer {
  return {
    peerId: 'local-peer-id',
    actorTokenId: 'local-actor',
    connectionState: 'new',
    joinedAt: Date.now(),
    isLocal: true,
  };
}

function createOptions(): ResolvedSignalOptions {
  return {
    appName: 'signal',
    debug: false,
    reconnect: true,
  };
}

const noop = () => {};

describe('SignalRoom', () => {
  let room: SignalRoom;
  let ctx: ReturnType<typeof createMockRoomContext>;

  beforeEach(() => {
    ctx = createMockRoomContext();
    room = new SignalRoom('call-room', ctx, createLocalPeer(), createOptions(), noop);
  });

  describe('_subscribe', () => {
    it('should subscribe to the signaling topic', () => {
      room._subscribe();
      expect(ctx.subscribe).toHaveBeenCalledWith('signaling');
    });

    it('should listen for signaling messages', () => {
      room._subscribe();
      expect(ctx.on).toHaveBeenCalledWith('signaling', expect.any(Function));
    });
  });

  describe('sendOffer', () => {
    it('should emit offer to room context with echo: false', () => {
      room._subscribe();
      const offer: RTCSessionDescriptionInit = { type: 'offer', sdp: 'v=0...' };
      room.sendOffer('remote-peer', offer);

      expect(ctx.emit).toHaveBeenCalledWith(
        'signaling',
        expect.objectContaining({
          type: 'offer',
          fromPeerId: 'local-peer-id',
          toPeerId: 'remote-peer',
          payload: offer,
        }),
        { echo: false },
      );
    });
  });

  describe('sendAnswer', () => {
    it('should emit answer to room context with echo: false', () => {
      room._subscribe();
      const answer: RTCSessionDescriptionInit = { type: 'answer', sdp: 'v=0...' };
      room.sendAnswer('remote-peer', answer);

      expect(ctx.emit).toHaveBeenCalledWith(
        'signaling',
        expect.objectContaining({
          type: 'answer',
          fromPeerId: 'local-peer-id',
          toPeerId: 'remote-peer',
          payload: answer,
        }),
        { echo: false },
      );
    });
  });

  describe('sendIceCandidate', () => {
    it('should emit ice-candidate to room context with echo: false', () => {
      room._subscribe();
      const candidate: RTCIceCandidateInit = { candidate: 'candidate:...', sdpMid: '0' };
      room.sendIceCandidate('remote-peer', candidate);

      expect(ctx.emit).toHaveBeenCalledWith(
        'signaling',
        expect.objectContaining({
          type: 'ice-candidate',
          fromPeerId: 'local-peer-id',
          toPeerId: 'remote-peer',
          payload: candidate,
        }),
        { echo: false },
      );
    });
  });

  describe('sendBye', () => {
    it('should emit bye to room context with echo: false', () => {
      room._subscribe();
      room.sendBye('remote-peer');

      expect(ctx.emit).toHaveBeenCalledWith(
        'signaling',
        expect.objectContaining({
          type: 'bye',
          fromPeerId: 'local-peer-id',
          toPeerId: 'remote-peer',
          payload: {},
        }),
        { echo: false },
      );
    });
  });

  describe('signal (generic)', () => {
    it('should emit renegotiate signal', () => {
      room._subscribe();
      room.signal('remote-peer', 'renegotiate', { reason: 'codec-change' });

      expect(ctx.emit).toHaveBeenCalledWith(
        'signaling',
        expect.objectContaining({
          type: 'renegotiate',
          fromPeerId: 'local-peer-id',
          toPeerId: 'remote-peer',
          payload: { reason: 'codec-change' },
        }),
        { echo: false },
      );
    });

    it('should include a unique id and timestamp', () => {
      room._subscribe();
      room.signal('remote-peer', 'offer', { type: 'offer', sdp: '' });

      const call = ctx.emit.mock.calls[0];
      const msg = call[1];
      expect(msg.id).toBeDefined();
      expect(typeof msg.id).toBe('string');
      expect(msg.timestamp).toBeDefined();
      expect(typeof msg.timestamp).toBe('number');
    });
  });

  describe('incoming signal messages', () => {
    it('should emit "signal" event for messages targeted at local peer', () => {
      room._subscribe();
      const handler = vi.fn();
      room.on('signal', handler);

      ctx._fireMessage('signaling', {
        id: 'sig-1',
        type: 'offer',
        fromPeerId: 'remote-peer',
        toPeerId: 'local-peer-id',
        payload: { type: 'offer', sdp: 'v=0...' },
        timestamp: Date.now(),
      });

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'sig-1',
          type: 'offer',
          fromPeerId: 'remote-peer',
          toPeerId: 'local-peer-id',
        }),
      );
    });

    it('should not emit "signal" for messages targeted at other peers', () => {
      room._subscribe();
      const handler = vi.fn();
      room.on('signal', handler);

      ctx._fireMessage('signaling', {
        id: 'sig-2',
        type: 'offer',
        fromPeerId: 'peer-a',
        toPeerId: 'peer-b', // not local-peer-id
        payload: {},
        timestamp: Date.now(),
      });

      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe('presence events', () => {
    it('should emit peerJoined on _handlePresenceJoin', () => {
      room._subscribe();
      const handler = vi.fn();
      room.on('peerJoined', handler);

      room._handlePresenceJoin('actor-remote', { peerId: 'p-remote' });

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          peerId: 'p-remote',
          actorTokenId: 'actor-remote',
          isLocal: false,
        }),
      );
    });

    it('should emit peerLeft on _handlePresenceLeave', () => {
      room._subscribe();
      const joinHandler = vi.fn();
      const leaveHandler = vi.fn();
      room.on('peerJoined', joinHandler);
      room.on('peerLeft', leaveHandler);

      room._handlePresenceJoin('actor-remote', { peerId: 'p-remote' });
      room._handlePresenceLeave('actor-remote');

      expect(leaveHandler).toHaveBeenCalledWith(
        expect.objectContaining({ peerId: 'p-remote' }),
      );
    });

    it('should not emit for self', () => {
      room._subscribe();
      const handler = vi.fn();
      room.on('peerJoined', handler);

      room._handlePresenceJoin('local-actor', { peerId: 'local-peer-id' });

      expect(handler).not.toHaveBeenCalled();
    });

    it('should not emit peerLeft for unknown actor', () => {
      room._subscribe();
      const handler = vi.fn();
      room.on('peerLeft', handler);

      room._handlePresenceLeave('unknown-actor');

      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe('getPeers', () => {
    it('should return all remote peers', () => {
      room._subscribe();

      room._handlePresenceJoin('actor-1', { peerId: 'p1' });
      room._handlePresenceJoin('actor-2', { peerId: 'p2' });

      expect(room.getPeers().length).toBe(2);
    });

    it('should return empty initially', () => {
      room._subscribe();
      expect(room.getPeers().length).toBe(0);
    });
  });

  describe('_cleanup', () => {
    it('should unsubscribe from signaling topic', () => {
      room._subscribe();
      room._cleanup();

      expect(ctx.unsubscribe).toHaveBeenCalledWith('signaling');
      expect(ctx.off).toHaveBeenCalledWith('signaling');
    });

    it('should remove all event listeners', () => {
      room._subscribe();
      room.on('signal', vi.fn());
      room._cleanup();

      expect(room.listenerCount('signal')).toBe(0);
    });
  });
});
