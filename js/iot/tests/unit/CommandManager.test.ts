import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CommandManager } from '../../src/CommandManager';

describe('CommandManager', () => {
  let manager: CommandManager;

  beforeEach(() => {
    vi.useFakeTimers();
    manager = new CommandManager(5000); // 5s default timeout
  });

  afterEach(() => {
    manager.dispose();
    vi.useRealTimers();
  });

  describe('send', () => {
    it('should return a promise', () => {
      const result = manager.send('device-01', 'reboot', undefined, 'controller-01');
      expect(result).toBeInstanceOf(Promise);
    });

    it('should create a command with pending status', () => {
      manager.send('device-01', 'reboot', undefined, 'controller-01');
      const pending = manager.getPending();
      expect(pending.length).toBe(1);
      expect(pending[0].status).toBe('pending');
      expect(pending[0].command).toBe('reboot');
      expect(pending[0].targetDeviceId).toBe('device-01');
      expect(pending[0].sentBy).toBe('controller-01');
    });

    it('should assign a unique id to the command', () => {
      manager.send('device-01', 'reboot', undefined, 'ctrl');
      manager.send('device-01', 'ping', undefined, 'ctrl');
      const pending = manager.getPending();
      expect(pending[0].id).not.toBe(pending[1].id);
    });

    it('should attach params to the command', () => {
      manager.send('device-01', 'setTemp', { target: 21 }, 'ctrl');
      const pending = manager.getPending();
      expect(pending[0].params).toEqual({ target: 21 });
    });

    it('should record sentAt timestamp', () => {
      const before = Date.now();
      manager.send('device-01', 'reboot', undefined, 'ctrl');
      const after = Date.now();
      const cmd = manager.getPending()[0];
      expect(cmd.sentAt).toBeGreaterThanOrEqual(before);
      expect(cmd.sentAt).toBeLessThanOrEqual(after);
    });

    it('should make the command retrievable by get()', () => {
      manager.send('device-01', 'reboot', undefined, 'ctrl');
      const id = manager.getPending()[0].id;
      expect(manager.get(id)).toBeDefined();
      expect(manager.get(id)!.command).toBe('reboot');
    });
  });

  describe('ack — acked status', () => {
    it('should resolve the promise on acked status', async () => {
      const promise = manager.send('device-01', 'reboot', undefined, 'ctrl');
      const id = manager.getPending()[0].id;

      manager.ack(id, 'acked');

      const cmd = await promise;
      expect(cmd.status).toBe('acked');
      expect(cmd.ackedAt).toBeDefined();
    });

    it('should remove the command from pending after ack', () => {
      const promise = manager.send('device-01', 'reboot', undefined, 'ctrl');
      const id = manager.getPending()[0].id;

      manager.ack(id, 'acked');

      expect(manager.getPending().length).toBe(0);
      return promise;
    });

    it('should return the updated command', () => {
      manager.send('device-01', 'reboot', undefined, 'ctrl');
      const id = manager.getPending()[0].id;

      const cmd = manager.ack(id, 'acked');
      expect(cmd).not.toBeNull();
      expect(cmd!.status).toBe('acked');
    });
  });

  describe('ack — completed status', () => {
    it('should resolve the promise on completed status', async () => {
      const promise = manager.send('device-01', 'ping', undefined, 'ctrl');
      const id = manager.getPending()[0].id;

      manager.ack(id, 'completed', { pong: true });

      const cmd = await promise;
      expect(cmd.status).toBe('completed');
      expect(cmd.completedAt).toBeDefined();
      expect(cmd.result).toEqual({ pong: true });
    });

    it('should set ackedAt and completedAt on completed', async () => {
      const promise = manager.send('device-01', 'ping', undefined, 'ctrl');
      const id = manager.getPending()[0].id;
      manager.ack(id, 'completed');
      const cmd = await promise;
      expect(cmd.ackedAt).toBeDefined();
      expect(cmd.completedAt).toBeDefined();
    });
  });

  describe('ack — failed status', () => {
    it('should reject the promise on failed status', async () => {
      const promise = manager.send('device-01', 'reboot', undefined, 'ctrl');
      const id = manager.getPending()[0].id;

      manager.ack(id, 'failed', 'Power error');

      await expect(promise).rejects.toThrow('Power error');
    });

    it('should set error on the command', () => {
      manager.send('device-01', 'reboot', undefined, 'ctrl');
      const id = manager.getPending()[0].id;

      manager.ack(id, 'failed', 'Power error');

      const cmd = manager.get(id);
      expect(cmd!.error).toBe('Power error');
    });

    it('should return the updated command even on failed', () => {
      manager.send('device-01', 'reboot', undefined, 'ctrl');
      const id = manager.getPending()[0].id;

      const cmd = manager.ack(id, 'failed', 'oops');
      expect(cmd).not.toBeNull();
      expect(cmd!.status).toBe('failed');
    });
  });

  describe('ack — unknown command', () => {
    it('should return null for unknown commandId', () => {
      const result = manager.ack('does-not-exist', 'acked');
      expect(result).toBeNull();
    });

    it('should return null for already-settled command', async () => {
      const promise = manager.send('device-01', 'ping', undefined, 'ctrl');
      const id = manager.getPending()[0].id;
      manager.ack(id, 'completed');
      await promise;

      // Second ack on same id — already removed from pending
      expect(manager.ack(id, 'acked')).toBeNull();
    });
  });

  describe('timeout', () => {
    it('should reject after the default timeout', async () => {
      const promise = manager.send('device-01', 'slow-op', undefined, 'ctrl');

      vi.advanceTimersByTime(5001);

      await expect(promise).rejects.toThrow('timed out');
    });

    it('should reject after a custom per-command timeout', async () => {
      const promise = manager.send('device-01', 'fast-op', undefined, 'ctrl', 1000);

      vi.advanceTimersByTime(1001);

      await expect(promise).rejects.toThrow('timed out');
    });

    it('should set status to timeout on the command', async () => {
      const promise = manager.send('device-01', 'slow-op', undefined, 'ctrl');
      const id = manager.getPending()[0].id;

      vi.advanceTimersByTime(5001);

      await promise.catch(() => {});

      expect(manager.get(id)!.status).toBe('timeout');
    });

    it('should remove from pending after timeout', async () => {
      const promise = manager.send('device-01', 'slow-op', undefined, 'ctrl');

      vi.advanceTimersByTime(5001);

      await promise.catch(() => {});
      expect(manager.getPending().length).toBe(0);
    });

    it('should not timeout if acked before timeout fires', async () => {
      const promise = manager.send('device-01', 'op', undefined, 'ctrl');
      const id = manager.getPending()[0].id;

      manager.ack(id, 'completed');

      vi.advanceTimersByTime(6000); // past timeout window

      const cmd = await promise;
      expect(cmd.status).toBe('completed');
    });
  });

  describe('getPending', () => {
    it('should return all pending commands', () => {
      manager.send('dev-1', 'cmd-a', undefined, 'ctrl');
      manager.send('dev-1', 'cmd-b', undefined, 'ctrl');
      expect(manager.getPending().length).toBe(2);
    });

    it('should return empty array when no commands pending', () => {
      expect(manager.getPending()).toEqual([]);
    });
  });

  describe('get', () => {
    it('should return undefined for unknown command', () => {
      expect(manager.get('unknown')).toBeUndefined();
    });

    it('should return a settled command by id', async () => {
      const promise = manager.send('dev', 'cmd', undefined, 'ctrl');
      const id = manager.getPending()[0].id;
      manager.ack(id, 'completed');
      await promise;

      const cmd = manager.get(id);
      expect(cmd).toBeDefined();
      expect(cmd!.status).toBe('completed');
    });
  });

  describe('dispose', () => {
    it('should reject all pending commands', async () => {
      const p1 = manager.send('dev', 'cmd1', undefined, 'ctrl');
      const p2 = manager.send('dev', 'cmd2', undefined, 'ctrl');

      manager.dispose();

      await expect(p1).rejects.toThrow('disposed');
      await expect(p2).rejects.toThrow('disposed');
    });

    it('should clear all pending entries', () => {
      manager.send('dev', 'cmd1', undefined, 'ctrl');
      manager.send('dev', 'cmd2', undefined, 'ctrl');

      manager.dispose();

      expect(manager.getPending().length).toBe(0);
    });

    it('should mark commands as timeout after dispose', async () => {
      const promise = manager.send('dev', 'cmd', undefined, 'ctrl');
      const id = manager.getPending()[0].id;

      manager.dispose();

      await promise.catch(() => {});
      expect(manager.get(id)!.status).toBe('timeout');
    });
  });
});
