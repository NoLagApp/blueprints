import { generateId } from './utils';
import type { DeviceCommand, CommandStatus } from './types';

interface PendingEntry {
  command: DeviceCommand;
  resolve: (cmd: DeviceCommand) => void;
  reject: (reason: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Command dispatch with ack tracking and per-command timeout.
 *
 * Controllers call `send()` to dispatch a command and await the result.
 * Devices call `ack()` to acknowledge receipt and report completion/failure.
 */
export class CommandManager {
  private _pending = new Map<string, PendingEntry>();
  private _commands = new Map<string, DeviceCommand>();
  private _defaultTimeout: number;

  constructor(defaultTimeout: number) {
    this._defaultTimeout = defaultTimeout;
  }

  // ============ Public API ============

  /**
   * Dispatch a command to a target device.
   *
   * Returns a Promise that resolves once the device acks with 'acked' or
   * 'completed', or rejects on 'failed' status or timeout.
   */
  send(
    targetDeviceId: string,
    command: string,
    params: Record<string, unknown> | undefined,
    sentBy: string,
    timeout?: number,
  ): Promise<DeviceCommand> {
    const id = generateId();
    const now = Date.now();

    const cmd: DeviceCommand = {
      id,
      targetDeviceId,
      command,
      params,
      status: 'pending',
      sentBy,
      sentAt: now,
    };

    this._commands.set(id, cmd);

    const promise = new Promise<DeviceCommand>((resolve, reject) => {
      const ms = timeout ?? this._defaultTimeout;

      const timer = setTimeout(() => {
        const entry = this._pending.get(id);
        if (!entry) return;

        entry.command.status = 'timeout';
        this._commands.set(id, entry.command);
        this._pending.delete(id);

        reject(new Error(`Command "${command}" (${id}) timed out after ${ms}ms`));
      }, ms);

      this._pending.set(id, { command: cmd, resolve, reject, timer });
    });

    // Prevent unhandled rejection warnings when dispose() rejects orphaned commands.
    // Callers who await/catch send() still see the rejection normally.
    promise.catch(() => {});

    return promise;
  }

  /**
   * Acknowledge a command from the device side.
   *
   * `status` must be one of 'acked', 'completed', or 'failed'.
   * Returns the updated DeviceCommand, or null if the command is unknown or
   * already settled.
   */
  ack(
    commandId: string,
    status: 'acked' | 'completed' | 'failed',
    result?: unknown,
  ): DeviceCommand | null {
    const entry = this._pending.get(commandId);
    if (!entry) return null;

    clearTimeout(entry.timer);
    this._pending.delete(commandId);

    const now = Date.now();
    const cmd = entry.command;

    cmd.status = status;

    if (status === 'acked') {
      cmd.ackedAt = now;
    } else if (status === 'completed') {
      cmd.ackedAt = cmd.ackedAt ?? now;
      cmd.completedAt = now;
      cmd.result = result;
    } else if (status === 'failed') {
      cmd.ackedAt = cmd.ackedAt ?? now;
      cmd.error = typeof result === 'string' ? result : 'Command failed';
    }

    this._commands.set(commandId, cmd);

    if (status === 'acked' || status === 'completed') {
      entry.resolve(cmd);
    } else {
      entry.reject(new Error(cmd.error ?? 'Command failed'));
    }

    return cmd;
  }

  /**
   * Get a command by id (includes settled commands).
   */
  get(commandId: string): DeviceCommand | undefined {
    return this._commands.get(commandId);
  }

  /**
   * Get all commands currently in 'pending' status.
   */
  getPending(): DeviceCommand[] {
    return Array.from(this._pending.values()).map((e) => e.command);
  }

  /**
   * Clear all pending timers and reject all outstanding promises.
   * Call this when the group or client is torn down.
   */
  dispose(): void {
    for (const [id, entry] of this._pending.entries()) {
      clearTimeout(entry.timer);
      entry.command.status = 'timeout';
      this._commands.set(id, entry.command);
      entry.reject(new Error(`Command "${entry.command.command}" (${id}) was disposed`));
    }
    this._pending.clear();
  }
}
