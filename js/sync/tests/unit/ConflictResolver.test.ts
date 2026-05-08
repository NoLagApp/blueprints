import { describe, it, expect, beforeEach } from 'vitest';
import { ConflictResolver } from '../../src/ConflictResolver';
import type { SyncDocument, SyncChange } from '../../src/types';

const USER_A = 'user-alice';
const USER_B = 'user-bob';

function makeDocument(overrides: Partial<SyncDocument> = {}): SyncDocument {
  const now = Date.now();
  return {
    id: 'doc-1',
    data: { text: 'Hello', count: 0 },
    version: 1,
    updatedBy: USER_A,
    updatedAt: now,
    createdAt: now,
    deleted: false,
    ...overrides,
  };
}

function makeChange(overrides: Partial<SyncChange> = {}): SyncChange {
  return {
    id: 'change-1',
    documentId: 'doc-1',
    type: 'update',
    fields: { count: 5 },
    version: 2,
    updatedBy: USER_B,
    timestamp: Date.now() + 100,
    optimistic: false,
    isReplay: false,
    ...overrides,
  };
}

describe('ConflictResolver', () => {
  let resolver: ConflictResolver;

  beforeEach(() => {
    resolver = new ConflictResolver();
  });

  // ============ Remote ahead (no conflict) ============

  describe('remote version > local version', () => {
    it('should apply remote change without conflict flag', () => {
      const local = makeDocument({ version: 1 });
      const change = makeChange({ version: 3, fields: { count: 10 } });

      const { resolved, hadConflict } = resolver.resolve(local, change);

      expect(hadConflict).toBe(false);
      expect(resolved.version).toBe(3);
      expect(resolved.data.count).toBe(10);
      expect(resolved.updatedBy).toBe(USER_B);
    });

    it('should merge fields from remote into local data', () => {
      const local = makeDocument({ data: { text: 'Hello', count: 0 }, version: 1 });
      const change = makeChange({ version: 2, fields: { count: 99 } });

      const { resolved } = resolver.resolve(local, change);

      expect(resolved.data.text).toBe('Hello');
      expect(resolved.data.count).toBe(99);
    });

    it('should handle delete change from remote', () => {
      const local = makeDocument({ version: 1 });
      const change = makeChange({ version: 2, type: 'delete', fields: undefined });

      const { resolved, hadConflict } = resolver.resolve(local, change);

      expect(hadConflict).toBe(false);
      expect(resolved.deleted).toBe(true);
      expect(resolved.version).toBe(2);
    });
  });

  // ============ Same version — last-writer-wins by timestamp ============

  describe('same version — last-writer-wins', () => {
    it('should pick remote when remote timestamp is newer', () => {
      const now = Date.now();
      const local = makeDocument({ version: 2, updatedAt: now - 500, data: { text: 'Local' } });
      const change = makeChange({ version: 2, timestamp: now, fields: { text: 'Remote' } });

      const { resolved, hadConflict } = resolver.resolve(local, change);

      expect(hadConflict).toBe(true);
      expect(resolved.data.text).toBe('Remote');
    });

    it('should pick remote when timestamps are equal', () => {
      const now = Date.now();
      const local = makeDocument({ version: 2, updatedAt: now, data: { count: 1 } });
      const change = makeChange({ version: 2, timestamp: now, fields: { count: 2 } });

      const { resolved, hadConflict } = resolver.resolve(local, change);

      expect(hadConflict).toBe(true);
      expect(resolved.data.count).toBe(2);
    });

    it('should pick local when local timestamp is newer', () => {
      const now = Date.now();
      const local = makeDocument({ version: 2, updatedAt: now, data: { text: 'Local' } });
      const change = makeChange({ version: 2, timestamp: now - 500, fields: { text: 'Remote' } });

      const { resolved, hadConflict } = resolver.resolve(local, change);

      expect(hadConflict).toBe(true);
      expect(resolved.data.text).toBe('Local');
      expect(resolved.updatedBy).toBe(USER_A);
    });
  });

  // ============ Local ahead (remote stale) ============

  describe('local version > remote version', () => {
    it('should keep local and flag conflict', () => {
      const local = makeDocument({ version: 5, data: { text: 'Local v5' } });
      const change = makeChange({ version: 3, fields: { text: 'Remote v3' } });

      const { resolved, hadConflict } = resolver.resolve(local, change);

      expect(hadConflict).toBe(true);
      expect(resolved.version).toBe(5);
      expect(resolved.data.text).toBe('Local v5');
    });
  });

  // ============ Create change ============

  describe('create change type', () => {
    it('should apply create as a non-conflict when remote is ahead', () => {
      const local = makeDocument({ version: 1 });
      const change = makeChange({ type: 'create', version: 2, fields: { text: 'Created remotely' } });

      const { resolved, hadConflict } = resolver.resolve(local, change);

      expect(hadConflict).toBe(false);
      expect(resolved.data.text).toBe('Created remotely');
    });
  });

  // ============ Timestamp propagation ============

  describe('timestamp propagation', () => {
    it('should set resolved.updatedAt to remote timestamp when remote wins', () => {
      const local = makeDocument({ version: 1 });
      const remoteTs = Date.now() + 1000;
      const change = makeChange({ version: 2, timestamp: remoteTs });

      const { resolved } = resolver.resolve(local, change);

      expect(resolved.updatedAt).toBe(remoteTs);
    });

    it('should preserve local updatedAt when local wins', () => {
      const now = Date.now();
      const localUpdatedAt = now - 100;
      const local = makeDocument({ version: 2, updatedAt: localUpdatedAt });
      const change = makeChange({ version: 2, timestamp: now - 500 });

      const { resolved } = resolver.resolve(local, change);

      expect(resolved.updatedAt).toBe(localUpdatedAt);
    });
  });
});
