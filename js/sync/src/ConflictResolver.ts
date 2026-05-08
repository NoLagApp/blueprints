import type { SyncDocument, SyncChange } from './types';

export interface ResolveResult {
  /** The resolved document state */
  resolved: SyncDocument;
  /** True if a conflict was detected (versions diverged) */
  hadConflict: boolean;
}

/**
 * ConflictResolver — last-writer-wins conflict resolution for sync documents.
 *
 * Strategy:
 *  1. If remoteChange.version > local.version → remote wins unconditionally.
 *  2. If versions are equal → last-writer-wins by timestamp (higher timestamp wins).
 *  3. If local.version > remoteChange.version → local wins (remote is stale).
 */
export class ConflictResolver {
  /**
   * Resolve a conflict between the current local document and an incoming remote change.
   *
   * @param local - The local document state before the remote change arrived.
   * @param remoteChange - The incoming remote change to reconcile.
   * @returns The resolved document and whether a conflict was detected.
   */
  resolve(local: SyncDocument, remoteChange: SyncChange): ResolveResult {
    // No conflict — remote is simply ahead
    if (remoteChange.version > local.version) {
      const resolved = this._applyChange(local, remoteChange, remoteChange.version);
      return { resolved, hadConflict: false };
    }

    // Versions match — last-writer-wins by timestamp
    if (remoteChange.version === local.version) {
      if (remoteChange.timestamp >= local.updatedAt) {
        // Remote wins
        const resolved = this._applyChange(local, remoteChange, remoteChange.version);
        return { resolved, hadConflict: true };
      } else {
        // Local wins — keep local state but acknowledge the conflict
        return { resolved: local, hadConflict: true };
      }
    }

    // Local is ahead — remote is stale, local wins
    return { resolved: local, hadConflict: true };
  }

  // ============ Private ============

  private _applyChange(local: SyncDocument, change: SyncChange, version: number): SyncDocument {
    if (change.type === 'delete') {
      return {
        ...local,
        version,
        updatedBy: change.updatedBy,
        updatedAt: change.timestamp,
        deleted: true,
      };
    }

    // create or update — merge fields
    return {
      ...local,
      data: { ...local.data, ...(change.fields ?? {}) },
      version,
      updatedBy: change.updatedBy,
      updatedAt: change.timestamp,
      deleted: false,
    };
  }
}
