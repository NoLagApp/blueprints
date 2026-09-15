import type { RoomContext, MessageMeta } from '@nolag/js-sdk';
import { EventEmitter } from './EventEmitter';
import { DocumentStore } from './DocumentStore';
import { ConflictResolver } from './ConflictResolver';
import { PresenceManager } from './PresenceManager';
import {
  generateId, inheritFilter, recordedFilter, mergeFilters, withoutFilters,
} from './utils';
import { TOPIC_CHANGES } from './constants';
import type {
  SyncRoomEvents,
  SyncDocument,
  SyncChange,
  SyncChangeType,
  SyncCollaborator,
  SyncPresenceData,
  ResolvedSyncOptions,
  SyncPublishOptions,
  FilterValue,
} from './types';

/**
 * SyncRoom — a single synchronized collection room.
 *
 * Created via `NoLagSync.joinCollection(name)`. Do not instantiate directly.
 */
export class SyncRoom extends EventEmitter<SyncRoomEvents> {
  /** Collection name */
  readonly name: string;

  private _roomContext: RoomContext;
  private _localCollaborator: SyncCollaborator;
  private _options: ResolvedSyncOptions;
  private _store: DocumentStore;
  private _resolver: ConflictResolver;
  private _presenceManager: PresenceManager;
  private _log: (...args: unknown[]) => void;
  private _isConnected: () => boolean;

  // Stored topic handler ref — cleanup removes exactly this, never all
  // handlers for a topic (the client may be shared with other consumers).
  private _onChangesRef: ((data: unknown, meta: MessageMeta) => void) | null = null;

  /** Filter values applied to the changes subscription. */
  private _filters: FilterValue[] = [];

  /** documentId → the filter its changes are published with. */
  private _docFilters = new Map<string, string>();

  /** @internal */
  constructor(
    name: string,
    roomContext: RoomContext,
    localCollaborator: SyncCollaborator,
    options: ResolvedSyncOptions,
    log: (...args: unknown[]) => void,
    isConnected: () => boolean,
  ) {
    super();
    this.name = name;
    this._roomContext = roomContext;
    this._localCollaborator = localCollaborator;
    this._options = options;
    this._log = log;
    this._isConnected = isConnected;

    this._store = new DocumentStore();
    this._resolver = new ConflictResolver();
    this._presenceManager = new PresenceManager(localCollaborator.actorTokenId);
  }

  // ============ Public Properties ============

  /** All remote collaborators currently in this collection */
  get collaborators(): Map<string, SyncCollaborator> {
    return this._presenceManager.collaborators;
  }

  // ============ Document CRUD ============

  /**
   * Create a new document locally and publish the change to all peers.
   */
  createDocument(
    id: string,
    data: Record<string, unknown>,
    opts?: SyncPublishOptions,
  ): SyncDocument {
    const doc = this._store.create(id, data, this._options.userId);
    this._log('Document created:', id);

    // Remember the partition so this document's later updates and deletes
    // reach the same peers its create did.
    const filter = recordedFilter(opts);
    if (filter) this._docFilters.set(doc.id, filter);

    const change = this._buildChange('create', doc.id, doc.version, data);
    this._publishChange(change);
    this.emit('localChange', change);
    this.emit('documentCreated', doc);

    return doc;
  }

  /**
   * Update an existing document locally and publish the change to all peers.
   * Returns null if the document does not exist.
   */
  updateDocument(id: string, fields: Record<string, unknown>): SyncDocument | null {
    const doc = this._store.update(id, fields, this._options.userId);
    if (!doc) return null;

    this._log('Document updated:', id);

    const change = this._buildChange('update', doc.id, doc.version, fields);
    this._publishChange(change);
    this.emit('localChange', change);
    this.emit('documentUpdated', doc);

    return doc;
  }

  /**
   * Delete a document locally and publish the change to all peers.
   * Returns null if the document does not exist.
   */
  deleteDocument(id: string): SyncDocument | null {
    const doc = this._store.delete(id, this._options.userId);
    if (!doc) return null;

    this._log('Document deleted:', id);

    const change = this._buildChange('delete', doc.id, doc.version);
    this._publishChange(change);
    this.emit('localChange', change);
    this.emit('documentDeleted', doc);

    return doc;
  }

  // ============ Filters ============

  /** The filter values currently applied to this collection's changes. */
  get filters(): FilterValue[] {
    return [...this._filters];
  }

  /**
   * Replace this collection's filters — only changes published with one of
   * these values are delivered. Use it to sync one partition of a large
   * collection (a tenant, a region) instead of all of it.
   *
   * Passing an empty array clears filtering and restores the wildcard
   * subscription, which receives every change.
   *
   * @example
   * ```ts
   * room.setFilters(['tenant-a']);            // one tenant
   * room.setFilters([['tenant-a', 'eu']]);    // tenant-a AND eu
   * room.setFilters([]);                       // whole collection
   * ```
   */
  setFilters(values: FilterValue[]): void {
    this._filters = [...values];
    // The core types filters as `string[]`, but both its implementation and
    // the wire protocol accept AND groups (nested arrays).
    this._roomContext.setFilters(TOPIC_CHANGES, this._filters as unknown as string[]);
  }

  /** Add filter values to the existing set. Existing AND groups are kept. */
  addFilters(values: string[]): void {
    this.setFilters(mergeFilters(this._filters, values));
  }

  /**
   * Remove filter values from the existing set. Removing the last value
   * restores the wildcard subscription.
   */
  removeFilters(values: string[]): void {
    this.setFilters(withoutFilters(this._filters, values));
  }

  /**
   * Get a document by ID.
   */
  getDocument(id: string): SyncDocument | undefined {
    return this._store.get(id);
  }

  /**
   * Get all non-deleted documents.
   */
  getAllDocuments(): SyncDocument[] {
    return this._store.getAll();
  }

  // ============ Internal (called by NoLagSync) ============

  /** @internal Subscribe to changes topic and attach listeners */
  _subscribe(filters?: FilterValue[]): void {
    this._log('Room subscribe:', this.name);

    this._filters = filters ? [...filters] : [];

    if (this._filters.length > 0) {
      this._roomContext.subscribe(TOPIC_CHANGES, { filters: this._filters });
    } else {
      this._roomContext.subscribe(TOPIC_CHANGES);
    }

    // Listen for changes (ref stored for handler-specific removal)
    this._onChangesRef = (data: unknown) => {
      this._handleIncomingChange(data);
    };
    this._roomContext.on(TOPIC_CHANGES, this._onChangesRef);
  }

  /** @internal Set presence and fetch room members */
  _activate(): void {
    this._log('Room activate:', this.name);
    this._setPresence();

    this._roomContext.fetchPresence().then((actors) => {
      this._log('Room presence fetched:', this.name, actors.length, 'actors');
      for (const actor of actors) {
        if (actor.presence) {
          const collaborator = this._presenceManager.addFromPresence(
            actor.actorTokenId,
            actor.presence as SyncPresenceData,
            actor.joinedAt,
          );
          if (collaborator) {
            this.emit('collaboratorJoined', collaborator);
          }
        }
      }
    }).catch((err) => {
      this._log('Failed to fetch room presence:', err);
    });
  }

  /** @internal Re-set presence after reconnect */
  _updateLocalPresence(): void {
    this._setPresence();
  }

  /** @internal Handle a presence:join event */
  _handlePresenceJoin(actorTokenId: string, presenceData: SyncPresenceData): void {
    const collaborator = this._presenceManager.addFromPresence(actorTokenId, presenceData);
    if (collaborator) {
      this._log('Collaborator joined:', this.name, collaborator.userId);
      this.emit('collaboratorJoined', collaborator);
    }
  }

  /** @internal Handle a presence:leave event */
  _handlePresenceLeave(actorTokenId: string): void {
    const collaborator = this._presenceManager.removeByActorId(actorTokenId);
    if (collaborator) {
      this._log('Collaborator left:', this.name, collaborator.userId);
      this.emit('collaboratorLeft', collaborator);
    }
  }

  /** @internal Handle a presence:update event */
  _handlePresenceUpdate(actorTokenId: string, presenceData: SyncPresenceData): void {
    this._presenceManager.addFromPresence(actorTokenId, presenceData);
  }

  /** @internal Unsubscribe and clean up */
  _cleanup(): void {
    this._log('Room cleanup:', this.name);

    // Server unsubscribes need a live socket; skip when disconnected
    // (best-effort — the core would no-op with an error callback anyway).
    if (this._isConnected()) {
      this._roomContext.unsubscribe(TOPIC_CHANGES);
    }

    // Handler-specific removal only: the client may be shared, and a bare
    // off(topic) would strip other consumers' handlers too.
    if (this._onChangesRef) this._roomContext.off(TOPIC_CHANGES, this._onChangesRef);
    this._onChangesRef = null;

    this._store.clear();
    this._presenceManager.clear();
    this.removeAllListeners();
  }

  // ============ Private ============

  private _handleIncomingChange(data: unknown): void {
    const change = data as SyncChange;

    // Ignore our own echoed changes
    if (change.updatedBy === this._options.userId) return;

    this._log('Incoming change:', change.type, change.documentId, 'v' + change.version);

    // Learn the document's partition from its author, so our own updates to it
    // are routed to the same peers rather than falling back to unfiltered.
    if (change.filter) this._docFilters.set(change.documentId, change.filter);

    const existing = this._store.get(change.documentId);

    // Conflict detection: document exists locally and versions diverge
    if (existing && change.type !== 'create') {
      const { resolved, hadConflict } = this._resolver.resolve(existing, change);

      if (hadConflict) {
        this._log('Conflict detected for:', change.documentId);
        this._store.applyRemoteChange({
          ...change,
          fields: { ...resolved.data },
        });
        const finalDoc = this._store.get(change.documentId)!;
        this.emit('conflict', { documentId: change.documentId, localChange: this._buildChange(change.type, change.documentId, existing.version), remoteChange: change, resolved: finalDoc });
        this.emit('synced', finalDoc);
        return;
      }
    }

    // Apply change normally
    const result = this._store.applyRemoteChange(change);
    if (!result) return;

    this.emit('synced', result);

    if (change.type === 'create') {
      this.emit('documentCreated', result);
    } else if (change.type === 'update') {
      this.emit('documentUpdated', result);
    } else if (change.type === 'delete') {
      this.emit('documentDeleted', result);
    }
  }

  private _publishChange(change: SyncChange): void {
    this._roomContext.emit(TOPIC_CHANGES, change, { echo: false, ...inheritFilter(change.filter) });
  }

  private _buildChange(
    type: SyncChangeType,
    documentId: string,
    version: number,
    fields?: Record<string, unknown>,
  ): SyncChange {
    return {
      id: generateId(),
      documentId,
      type,
      fields,
      version,
      updatedBy: this._options.userId,
      timestamp: Date.now(),
      optimistic: true,
      filter: this._docFilters.get(documentId),
      isReplay: false,
    };
  }

  private _setPresence(): void {
    const presenceData: SyncPresenceData = {
      userId: this._localCollaborator.userId,
      username: this._localCollaborator.username,
      metadata: this._localCollaborator.metadata,
      // Scope tag: on a shared client, other apps' wrappers filter our
      // presence out by this (and we filter theirs).
      __scope: this._options.appName,
    };
    this._roomContext.setPresence(presenceData);
  }
}
