import { describe, it, expect } from 'vitest';
import { PeerManager } from '../../src/PeerManager';
import type { SignalPresenceData } from '../../src/types';

const LOCAL_ACTOR = 'local-actor-123';

function makePresence(overrides: Partial<SignalPresenceData> = {}): SignalPresenceData {
  return {
    peerId: 'peer-' + Math.random().toString(36).slice(2, 6),
    ...overrides,
  };
}

describe('PeerManager', () => {
  it('should add a remote peer from presence data', () => {
    const pm = new PeerManager(LOCAL_ACTOR);
    const presence = makePresence({ peerId: 'p1' });

    const peer = pm.addFromPresence('actor-1', presence);

    expect(peer).not.toBeNull();
    expect(peer!.peerId).toBe('p1');
    expect(peer!.actorTokenId).toBe('actor-1');
    expect(peer!.isLocal).toBe(false);
    expect(peer!.connectionState).toBe('new');
  });

  it('should return null for the local actor (self)', () => {
    const pm = new PeerManager(LOCAL_ACTOR);
    const presence = makePresence({ peerId: 'local-peer' });

    const peer = pm.addFromPresence(LOCAL_ACTOR, presence);
    expect(peer).toBeNull();
  });

  it('should update an existing peer when called again', () => {
    const pm = new PeerManager(LOCAL_ACTOR);

    pm.addFromPresence('actor-1', makePresence({ peerId: 'p1', metadata: { name: 'Alice' } }));
    pm.addFromPresence('actor-1', makePresence({ peerId: 'p1', metadata: { name: 'Alice Updated' } }));

    const peer = pm.getPeer('p1');
    expect(peer?.metadata?.name).toBe('Alice Updated');
    expect(pm.getAll().length).toBe(1);
  });

  it('should remove a peer by actorTokenId', () => {
    const pm = new PeerManager(LOCAL_ACTOR);
    pm.addFromPresence('actor-1', makePresence({ peerId: 'p1' }));

    const removed = pm.removeByActorId('actor-1');
    expect(removed).not.toBeNull();
    expect(removed!.peerId).toBe('p1');
    expect(pm.getAll().length).toBe(0);
    expect(pm.getPeer('p1')).toBeUndefined();
  });

  it('should return null when removing self', () => {
    const pm = new PeerManager(LOCAL_ACTOR);
    const removed = pm.removeByActorId(LOCAL_ACTOR);
    expect(removed).toBeNull();
  });

  it('should return null when removing unknown actor', () => {
    const pm = new PeerManager(LOCAL_ACTOR);
    const removed = pm.removeByActorId('unknown');
    expect(removed).toBeNull();
  });

  it('should get peer by peerId', () => {
    const pm = new PeerManager(LOCAL_ACTOR);
    pm.addFromPresence('actor-1', makePresence({ peerId: 'p1' }));

    expect(pm.getPeer('p1')?.actorTokenId).toBe('actor-1');
    expect(pm.getPeer('nonexistent')).toBeUndefined();
  });

  it('should get peer by actorTokenId', () => {
    const pm = new PeerManager(LOCAL_ACTOR);
    pm.addFromPresence('actor-1', makePresence({ peerId: 'p1' }));

    expect(pm.getPeerByActorId('actor-1')?.peerId).toBe('p1');
    expect(pm.getPeerByActorId('nonexistent')).toBeUndefined();
  });

  it('should return all remote peers', () => {
    const pm = new PeerManager(LOCAL_ACTOR);
    pm.addFromPresence('actor-1', makePresence({ peerId: 'p1' }));
    pm.addFromPresence('actor-2', makePresence({ peerId: 'p2' }));

    const all = pm.getAll();
    expect(all.length).toBe(2);
    expect(all.map(p => p.peerId).sort()).toEqual(['p1', 'p2']);
  });

  it('should clear all peers', () => {
    const pm = new PeerManager(LOCAL_ACTOR);
    pm.addFromPresence('actor-1', makePresence({ peerId: 'p1' }));
    pm.addFromPresence('actor-2', makePresence({ peerId: 'p2' }));

    pm.clear();
    expect(pm.getAll().length).toBe(0);
    expect(pm.peers.size).toBe(0);
  });

  it('should expose peers map', () => {
    const pm = new PeerManager(LOCAL_ACTOR);
    pm.addFromPresence('actor-1', makePresence({ peerId: 'p1' }));

    expect(pm.peers).toBeInstanceOf(Map);
    expect(pm.peers.size).toBe(1);
    expect(pm.peers.get('p1')?.actorTokenId).toBe('actor-1');
  });

  it('should store custom metadata', () => {
    const pm = new PeerManager(LOCAL_ACTOR);
    pm.addFromPresence('actor-1', makePresence({ peerId: 'p1', metadata: { role: 'host' } }));

    expect(pm.getPeer('p1')?.metadata?.role).toBe('host');
  });

  it('should preserve joinedAt when provided', () => {
    const pm = new PeerManager(LOCAL_ACTOR);
    const joinedAt = 1234567890;
    pm.addFromPresence('actor-1', makePresence({ peerId: 'p1' }), joinedAt);

    expect(pm.getPeer('p1')?.joinedAt).toBe(joinedAt);
  });
});
