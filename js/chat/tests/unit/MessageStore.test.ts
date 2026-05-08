import { describe, it, expect } from 'vitest';
import { MessageStore } from '../../src/MessageStore';
import type { ChatMessage } from '../../src/types';

function makeMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: Math.random().toString(36).slice(2),
    userId: 'user1',
    username: 'Alice',
    text: 'Hello',
    timestamp: Date.now(),
    status: 'delivered',
    isReplay: false,
    ...overrides,
  };
}

describe('MessageStore', () => {
  it('should add messages and return them in order', () => {
    const store = new MessageStore(100);

    const m1 = makeMessage({ id: '1', timestamp: 1000 });
    const m2 = makeMessage({ id: '2', timestamp: 2000 });

    expect(store.add(m1)).toBe(true);
    expect(store.add(m2)).toBe(true);
    expect(store.size).toBe(2);

    const all = store.getAll();
    expect(all[0].id).toBe('1');
    expect(all[1].id).toBe('2');
  });

  it('should deduplicate by id', () => {
    const store = new MessageStore(100);

    const m1 = makeMessage({ id: 'dup' });
    expect(store.add(m1)).toBe(true);
    expect(store.add(m1)).toBe(false);
    expect(store.size).toBe(1);
  });

  it('should sort by timestamp when out-of-order messages arrive', () => {
    const store = new MessageStore(100);

    store.add(makeMessage({ id: '3', timestamp: 3000 }));
    store.add(makeMessage({ id: '1', timestamp: 1000 }));
    store.add(makeMessage({ id: '2', timestamp: 2000 }));

    const all = store.getAll();
    expect(all.map(m => m.id)).toEqual(['1', '2', '3']);
  });

  it('should enforce max size', () => {
    const store = new MessageStore(3);

    store.add(makeMessage({ id: '1', timestamp: 1000 }));
    store.add(makeMessage({ id: '2', timestamp: 2000 }));
    store.add(makeMessage({ id: '3', timestamp: 3000 }));
    store.add(makeMessage({ id: '4', timestamp: 4000 }));

    expect(store.size).toBe(3);
    const all = store.getAll();
    expect(all.map(m => m.id)).toEqual(['2', '3', '4']);
    expect(store.has('1')).toBe(false);
    expect(store.has('2')).toBe(true);
  });

  it('should check if a message exists with has()', () => {
    const store = new MessageStore(100);
    store.add(makeMessage({ id: 'test' }));

    expect(store.has('test')).toBe(true);
    expect(store.has('nope')).toBe(false);
  });

  it('should clear all messages', () => {
    const store = new MessageStore(100);
    store.add(makeMessage({ id: '1' }));
    store.add(makeMessage({ id: '2' }));

    store.clear();
    expect(store.size).toBe(0);
    expect(store.getAll()).toEqual([]);
    expect(store.has('1')).toBe(false);
  });

  it('should return a copy from getAll()', () => {
    const store = new MessageStore(100);
    store.add(makeMessage({ id: '1' }));

    const all1 = store.getAll();
    const all2 = store.getAll();
    expect(all1).not.toBe(all2);
    expect(all1).toEqual(all2);
  });
});
