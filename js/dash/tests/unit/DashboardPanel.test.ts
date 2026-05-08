import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DashboardPanel } from '../../src/DashboardPanel';
import type { ResolvedDashOptions } from '../../src/types';
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

describe('DashboardPanel', () => {
  let panel: DashboardPanel;
  let ctx: ReturnType<typeof createMockRoomContext>;

  beforeEach(() => {
    ctx = createMockRoomContext();
    const opts: ResolvedDashOptions = { appName: 'dash', maxMetricPoints: 1000, aggregationWindow: 60000, debug: false, reconnect: true, panels: [] };
    panel = new DashboardPanel('overview', ctx, 'v1', 'local-actor', opts, () => {});
  });

  it('should subscribe to metrics and widgets', () => {
    panel._subscribe();
    expect(ctx.subscribe).toHaveBeenCalledWith('metrics');
    expect(ctx.subscribe).toHaveBeenCalledWith('widgets');
  });

  it('should publish metric', () => {
    panel._subscribe();
    const point = panel.publishMetric('cpu', 75);
    expect(point.value).toBe(75);
    expect(ctx.emit).toHaveBeenCalledWith('metrics', expect.objectContaining({ streamId: 'cpu', value: 75 }), { echo: false });
  });

  it('should emit metric on incoming', () => {
    panel._subscribe();
    const handler = vi.fn();
    panel.on('metric', handler);
    ctx._fire('metrics', { id: 'm1', streamId: 'cpu', value: 80, timestamp: 1000 }, { isReplay: false });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('should cleanup', () => {
    panel._subscribe();
    panel._cleanup();
    expect(ctx.unsubscribe).toHaveBeenCalledWith('metrics');
    expect(ctx.unsubscribe).toHaveBeenCalledWith('widgets');
  });
});
