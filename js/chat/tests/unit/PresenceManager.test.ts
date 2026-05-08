import { describe, it, expect } from 'vitest';
import { PresenceManager } from '../../src/PresenceManager';
import type { ChatPresenceData } from '../../src/types';

const LOCAL_ACTOR = 'local-actor-123';

function makePresence(overrides: Partial<ChatPresenceData> = {}): ChatPresenceData {
  return {
    userId: 'user-' + Math.random().toString(36).slice(2, 6),
    username: 'TestUser',
    status: 'online',
    ...overrides,
  };
}

describe('PresenceManager', () => {
  it('should add a remote user from presence data', () => {
    const pm = new PresenceManager(LOCAL_ACTOR);
    const presence = makePresence({ userId: 'u1', username: 'Alice' });

    const user = pm.addFromPresence('actor-1', presence);

    expect(user).not.toBeNull();
    expect(user!.userId).toBe('u1');
    expect(user!.username).toBe('Alice');
    expect(user!.actorTokenId).toBe('actor-1');
    expect(user!.isLocal).toBe(false);
  });

  it('should return null for the local actor (self)', () => {
    const pm = new PresenceManager(LOCAL_ACTOR);
    const presence = makePresence({ userId: 'local-user' });

    const user = pm.addFromPresence(LOCAL_ACTOR, presence);
    expect(user).toBeNull();
  });

  it('should update an existing user when called again', () => {
    const pm = new PresenceManager(LOCAL_ACTOR);

    pm.addFromPresence('actor-1', makePresence({ userId: 'u1', username: 'Alice' }));
    pm.addFromPresence('actor-1', makePresence({ userId: 'u1', username: 'Alice Updated' }));

    const user = pm.getUser('u1');
    expect(user?.username).toBe('Alice Updated');
    expect(pm.getAll().length).toBe(1);
  });

  it('should remove a user by actorTokenId', () => {
    const pm = new PresenceManager(LOCAL_ACTOR);
    pm.addFromPresence('actor-1', makePresence({ userId: 'u1', username: 'Alice' }));

    const removed = pm.removeByActorId('actor-1');
    expect(removed).not.toBeNull();
    expect(removed!.userId).toBe('u1');
    expect(pm.getAll().length).toBe(0);
    expect(pm.getUser('u1')).toBeUndefined();
  });

  it('should return null when removing self', () => {
    const pm = new PresenceManager(LOCAL_ACTOR);
    const removed = pm.removeByActorId(LOCAL_ACTOR);
    expect(removed).toBeNull();
  });

  it('should return null when removing unknown actor', () => {
    const pm = new PresenceManager(LOCAL_ACTOR);
    const removed = pm.removeByActorId('unknown');
    expect(removed).toBeNull();
  });

  it('should get user by userId', () => {
    const pm = new PresenceManager(LOCAL_ACTOR);
    pm.addFromPresence('actor-1', makePresence({ userId: 'u1', username: 'Alice' }));

    expect(pm.getUser('u1')?.username).toBe('Alice');
    expect(pm.getUser('nonexistent')).toBeUndefined();
  });

  it('should get user by actorTokenId', () => {
    const pm = new PresenceManager(LOCAL_ACTOR);
    pm.addFromPresence('actor-1', makePresence({ userId: 'u1', username: 'Alice' }));

    expect(pm.getUserByActorId('actor-1')?.username).toBe('Alice');
    expect(pm.getUserByActorId('nonexistent')).toBeUndefined();
  });

  it('should return all remote users', () => {
    const pm = new PresenceManager(LOCAL_ACTOR);
    pm.addFromPresence('actor-1', makePresence({ userId: 'u1' }));
    pm.addFromPresence('actor-2', makePresence({ userId: 'u2' }));

    const all = pm.getAll();
    expect(all.length).toBe(2);
    expect(all.map(u => u.userId).sort()).toEqual(['u1', 'u2']);
  });

  it('should clear all users', () => {
    const pm = new PresenceManager(LOCAL_ACTOR);
    pm.addFromPresence('actor-1', makePresence({ userId: 'u1' }));
    pm.addFromPresence('actor-2', makePresence({ userId: 'u2' }));

    pm.clear();
    expect(pm.getAll().length).toBe(0);
    expect(pm.users.size).toBe(0);
  });

  it('should expose users map', () => {
    const pm = new PresenceManager(LOCAL_ACTOR);
    pm.addFromPresence('actor-1', makePresence({ userId: 'u1' }));

    expect(pm.users).toBeInstanceOf(Map);
    expect(pm.users.size).toBe(1);
    expect(pm.users.get('u1')?.actorTokenId).toBe('actor-1');
  });
});
