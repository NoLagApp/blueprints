import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from '../../src/EventEmitter';

interface TestEvents {
  message: [text: string];
  count: [n: number];
  multi: [a: string, b: number];
  empty: [];
}

class TestEmitter extends EventEmitter<TestEvents> {
  // Expose emit for testing
  public fire<K extends keyof TestEvents>(event: K, ...args: TestEvents[K]): void {
    this.emit(event, ...args);
  }
}

describe('EventEmitter', () => {
  it('should register and fire handlers', () => {
    const emitter = new TestEmitter();
    const handler = vi.fn();

    emitter.on('message', handler);
    emitter.fire('message', 'hello');

    expect(handler).toHaveBeenCalledWith('hello');
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('should support multiple handlers for the same event', () => {
    const emitter = new TestEmitter();
    const h1 = vi.fn();
    const h2 = vi.fn();

    emitter.on('message', h1);
    emitter.on('message', h2);
    emitter.fire('message', 'test');

    expect(h1).toHaveBeenCalledWith('test');
    expect(h2).toHaveBeenCalledWith('test');
  });

  it('should pass multiple arguments', () => {
    const emitter = new TestEmitter();
    const handler = vi.fn();

    emitter.on('multi', handler);
    emitter.fire('multi', 'foo', 42);

    expect(handler).toHaveBeenCalledWith('foo', 42);
  });

  it('should support events with no arguments', () => {
    const emitter = new TestEmitter();
    const handler = vi.fn();

    emitter.on('empty', handler);
    emitter.fire('empty');

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('should remove a specific handler with off()', () => {
    const emitter = new TestEmitter();
    const h1 = vi.fn();
    const h2 = vi.fn();

    emitter.on('message', h1);
    emitter.on('message', h2);
    emitter.off('message', h1);
    emitter.fire('message', 'test');

    expect(h1).not.toHaveBeenCalled();
    expect(h2).toHaveBeenCalledWith('test');
  });

  it('should remove all handlers for an event with off(event)', () => {
    const emitter = new TestEmitter();
    const h1 = vi.fn();
    const h2 = vi.fn();

    emitter.on('message', h1);
    emitter.on('message', h2);
    emitter.off('message');
    emitter.fire('message', 'test');

    expect(h1).not.toHaveBeenCalled();
    expect(h2).not.toHaveBeenCalled();
  });

  it('should remove all handlers with removeAllListeners()', () => {
    const emitter = new TestEmitter();
    const h1 = vi.fn();
    const h2 = vi.fn();

    emitter.on('message', h1);
    emitter.on('count', h2);
    emitter.removeAllListeners();
    emitter.fire('message', 'test');
    emitter.fire('count', 5);

    expect(h1).not.toHaveBeenCalled();
    expect(h2).not.toHaveBeenCalled();
  });

  it('should return listener count', () => {
    const emitter = new TestEmitter();

    expect(emitter.listenerCount('message')).toBe(0);

    emitter.on('message', () => {});
    expect(emitter.listenerCount('message')).toBe(1);

    emitter.on('message', () => {});
    expect(emitter.listenerCount('message')).toBe(2);
  });

  it('should not throw when emitting with no listeners', () => {
    const emitter = new TestEmitter();
    expect(() => emitter.fire('message', 'test')).not.toThrow();
  });

  it('should catch handler errors and continue', () => {
    const emitter = new TestEmitter();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const h1 = vi.fn(() => { throw new Error('boom'); });
    const h2 = vi.fn();

    emitter.on('message', h1);
    emitter.on('message', h2);
    emitter.fire('message', 'test');

    expect(h1).toHaveBeenCalled();
    expect(h2).toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalled();

    errorSpy.mockRestore();
  });

  it('should be chainable', () => {
    const emitter = new TestEmitter();
    const result = emitter.on('message', () => {}).on('count', () => {});
    expect(result).toBe(emitter);
  });
});
