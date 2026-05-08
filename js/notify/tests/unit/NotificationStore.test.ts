import { describe, it, expect } from 'vitest';
import { NotificationStore } from '../../src/NotificationStore';
import type { Notification } from '../../src/types';

function makeNotification(overrides: Partial<Notification> = {}): Notification {
  return {
    id: Math.random().toString(36).slice(2),
    channel: 'alerts',
    title: 'Test',
    timestamp: Date.now(),
    read: false,
    isReplay: false,
    ...overrides,
  };
}

describe('NotificationStore', () => {
  it('should add notifications and return them in order', () => {
    const store = new NotificationStore(100);
    store.add(makeNotification({ id: '1', timestamp: 1000 }));
    store.add(makeNotification({ id: '2', timestamp: 2000 }));
    expect(store.size).toBe(2);
    expect(store.getAll().map(n => n.id)).toEqual(['1', '2']);
  });

  it('should deduplicate by id', () => {
    const store = new NotificationStore(100);
    const n = makeNotification({ id: 'dup' });
    expect(store.add(n)).toBe(true);
    expect(store.add(n)).toBe(false);
    expect(store.size).toBe(1);
  });

  it('should sort by timestamp when out-of-order', () => {
    const store = new NotificationStore(100);
    store.add(makeNotification({ id: '3', timestamp: 3000 }));
    store.add(makeNotification({ id: '1', timestamp: 1000 }));
    expect(store.getAll().map(n => n.id)).toEqual(['1', '3']);
  });

  it('should enforce max size', () => {
    const store = new NotificationStore(2);
    store.add(makeNotification({ id: '1', timestamp: 1000 }));
    store.add(makeNotification({ id: '2', timestamp: 2000 }));
    store.add(makeNotification({ id: '3', timestamp: 3000 }));
    expect(store.size).toBe(2);
    expect(store.has('1')).toBe(false);
  });

  it('should track read/unread', () => {
    const store = new NotificationStore(100);
    store.add(makeNotification({ id: '1' }));
    store.add(makeNotification({ id: '2' }));
    expect(store.unreadCount).toBe(2);
    store.markRead('1');
    expect(store.unreadCount).toBe(1);
    expect(store.getUnread().length).toBe(1);
  });

  it('should mark all read', () => {
    const store = new NotificationStore(100);
    store.add(makeNotification({ id: '1' }));
    store.add(makeNotification({ id: '2' }));
    store.markAllRead();
    expect(store.unreadCount).toBe(0);
  });

  it('should clear all', () => {
    const store = new NotificationStore(100);
    store.add(makeNotification({ id: '1' }));
    store.clear();
    expect(store.size).toBe(0);
  });
});
