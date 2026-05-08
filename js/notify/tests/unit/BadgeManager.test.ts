import { describe, it, expect } from 'vitest';
import { BadgeManager } from '../../src/BadgeManager';

describe('BadgeManager', () => {
  it('should track per-channel counts', () => {
    const mgr = new BadgeManager();
    mgr.update('alerts', 3);
    mgr.update('updates', 2);
    expect(mgr.get('alerts')).toBe(3);
    expect(mgr.get('updates')).toBe(2);
  });

  it('should return total and byChannel', () => {
    const mgr = new BadgeManager();
    mgr.update('alerts', 3);
    mgr.update('updates', 2);
    const counts = mgr.getAll();
    expect(counts.total).toBe(5);
    expect(counts.byChannel).toEqual({ alerts: 3, updates: 2 });
  });

  it('should return 0 for unknown channels', () => {
    const mgr = new BadgeManager();
    expect(mgr.get('unknown')).toBe(0);
  });

  it('should clear all counts', () => {
    const mgr = new BadgeManager();
    mgr.update('alerts', 5);
    mgr.clear();
    expect(mgr.getAll().total).toBe(0);
  });
});
