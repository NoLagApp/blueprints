import { describe, it, expect } from 'vitest';
import { WidgetManager } from '../../src/WidgetManager';
import type { WidgetUpdate } from '../../src/types';

describe('WidgetManager', () => {
  it('should update and get widgets', () => {
    const mgr = new WidgetManager();
    const w: WidgetUpdate = { id: '1', widgetId: 'w1', type: 'gauge', data: { value: 42 }, timestamp: Date.now(), isReplay: false };
    mgr.update(w);
    expect(mgr.get('w1')).toEqual(w);
  });

  it('should overwrite on update', () => {
    const mgr = new WidgetManager();
    mgr.update({ id: '1', widgetId: 'w1', type: 'gauge', data: { value: 1 }, timestamp: 1, isReplay: false });
    mgr.update({ id: '2', widgetId: 'w1', type: 'gauge', data: { value: 2 }, timestamp: 2, isReplay: false });
    expect(mgr.get('w1')?.data.value).toBe(2);
  });

  it('should return all widgets', () => {
    const mgr = new WidgetManager();
    mgr.update({ id: '1', widgetId: 'w1', type: 'gauge', data: {}, timestamp: 1, isReplay: false });
    mgr.update({ id: '2', widgetId: 'w2', type: 'counter', data: {}, timestamp: 2, isReplay: false });
    expect(mgr.getAll().length).toBe(2);
  });

  it('should clear', () => {
    const mgr = new WidgetManager();
    mgr.update({ id: '1', widgetId: 'w1', type: 'text', data: {}, timestamp: 1, isReplay: false });
    mgr.clear();
    expect(mgr.getAll().length).toBe(0);
  });
});
