import type { SyncDocument, SyncChange } from './types';

/**
 * DocumentStore — in-memory store for sync documents.
 *
 * Tracks all documents in a collection, applies local and remote changes,
 * and maintains version counters for conflict detection.
 */
export class DocumentStore {
  private _documents = new Map<string, SyncDocument>();

  /**
   * Create a new document with version 1.
   */
  create(id: string, data: Record<string, unknown>, userId: string): SyncDocument {
    const now = Date.now();
    const doc: SyncDocument = {
      id,
      data: { ...data },
      version: 1,
      updatedBy: userId,
      updatedAt: now,
      createdAt: now,
      deleted: false,
    };
    this._documents.set(id, doc);
    return doc;
  }

  /**
   * Update an existing document — increments version, merges fields.
   * Returns null if the document does not exist or is deleted.
   */
  update(id: string, fields: Record<string, unknown>, userId: string): SyncDocument | null {
    const existing = this._documents.get(id);
    if (!existing || existing.deleted) return null;

    const updated: SyncDocument = {
      ...existing,
      data: { ...existing.data, ...fields },
      version: existing.version + 1,
      updatedBy: userId,
      updatedAt: Date.now(),
    };
    this._documents.set(id, updated);
    return updated;
  }

  /**
   * Soft-delete a document — marks deleted, increments version.
   * Returns null if the document does not exist.
   */
  delete(id: string, userId: string): SyncDocument | null {
    const existing = this._documents.get(id);
    if (!existing) return null;

    const deleted: SyncDocument = {
      ...existing,
      version: existing.version + 1,
      updatedBy: userId,
      updatedAt: Date.now(),
      deleted: true,
    };
    this._documents.set(id, deleted);
    return deleted;
  }

  /**
   * Get a document by ID (including soft-deleted).
   */
  get(id: string): SyncDocument | undefined {
    return this._documents.get(id);
  }

  /**
   * Get all non-deleted documents.
   */
  getAll(): SyncDocument[] {
    return Array.from(this._documents.values()).filter((d) => !d.deleted);
  }

  /**
   * Apply a remote change to the store.
   * Returns the resulting document, or null if the change could not be applied.
   */
  applyRemoteChange(change: SyncChange): SyncDocument | null {
    const existing = this._documents.get(change.documentId);

    if (change.type === 'create') {
      const now = change.timestamp;
      const doc: SyncDocument = {
        id: change.documentId,
        data: { ...(change.fields ?? {}) },
        version: change.version,
        updatedBy: change.updatedBy,
        updatedAt: now,
        createdAt: now,
        deleted: false,
      };
      this._documents.set(change.documentId, doc);
      return doc;
    }

    if (change.type === 'update') {
      if (!existing) return null;
      const updated: SyncDocument = {
        ...existing,
        data: { ...existing.data, ...(change.fields ?? {}) },
        version: change.version,
        updatedBy: change.updatedBy,
        updatedAt: change.timestamp,
      };
      this._documents.set(change.documentId, updated);
      return updated;
    }

    if (change.type === 'delete') {
      if (!existing) return null;
      const deleted: SyncDocument = {
        ...existing,
        version: change.version,
        updatedBy: change.updatedBy,
        updatedAt: change.timestamp,
        deleted: true,
      };
      this._documents.set(change.documentId, deleted);
      return deleted;
    }

    return null;
  }

  /**
   * Get the current version of a document, or 0 if it doesn't exist.
   */
  getVersion(id: string): number {
    return this._documents.get(id)?.version ?? 0;
  }

  /**
   * Returns true if the document exists (including soft-deleted).
   */
  has(id: string): boolean {
    return this._documents.has(id);
  }

  /**
   * Number of documents tracked (including soft-deleted).
   */
  get size(): number {
    return this._documents.size;
  }

  /**
   * Clear all documents.
   */
  clear(): void {
    this._documents.clear();
  }
}
