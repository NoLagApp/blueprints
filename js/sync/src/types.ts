/**
 * @nolag/sync — Public types
 */

import type { NoLagSocket } from '@nolag/js-sdk';

// ============ Options ============

export interface NoLagSyncOptions {
  /**
   * The injected NoLag core client. The app owns its lifecycle: create it
   * with `NoLag(tokenOrProvider)`, call `connect()`/`disconnect()` yourself.
   * The wrapper only attaches protocol behavior on top and releases it
   * again via `detach()`. One wrapper per (client, appName).
   */
  client: NoLagSocket;
  /** Stable user ID (generated via generateId() if not provided) */
  userId?: string;
  /** Human-readable display name */
  username?: string;
  /** Custom metadata attached to collaborator presence */
  metadata?: Record<string, unknown>;
  /** NoLag app name (default: 'sync') */
  appName?: string;
  /** Enable debug logging for the wrapper (default: false) */
  debug?: boolean;
  /** Collection names to pre-join on connect */
  collections?: string[];
}

/** Resolved options with defaults applied */
export interface ResolvedSyncOptions {
  /** Always present — either provided or generated */
  userId: string;
  username?: string;
  metadata?: Record<string, unknown>;
  appName: string;
  debug: boolean;
  collections: string[];
}

// ============ Document ============

export interface SyncDocument {
  /** Stable document ID */
  id: string;
  /** Document payload */
  data: Record<string, unknown>;
  /** Monotonically increasing version counter */
  version: number;
  /** userId of the last writer */
  updatedBy: string;
  /** Timestamp of the last update (ms since epoch) */
  updatedAt: number;
  /** Timestamp when the document was first created (ms since epoch) */
  createdAt: number;
  /** Soft-delete flag */
  deleted: boolean;
}

// ============ Change ============

export type SyncChangeType = 'create' | 'update' | 'delete';

export interface SyncChange {
  /** Unique change ID */
  id: string;
  /** Document this change applies to */
  documentId: string;
  /** Type of change */
  type: SyncChangeType;
  /** Fields that changed (for update; omitted for create/delete) */
  fields?: Record<string, unknown>;
  /** Document version after this change */
  version: number;
  /** userId who authored this change */
  updatedBy: string;
  /** When this change was authored (ms since epoch) */
  timestamp: number;
  /** True if change was applied optimistically before server confirmation */
  optimistic: boolean;
  /**
   * The filter this change was published with, if any. Carried in the payload
   * so peers learn a document's partition from its create and route their own
   * updates and deletes to the same audience.
   */
  filter?: string;
  /** True if this change is being replayed from history */
  isReplay: boolean;
}

/** Publish-side filter options for a document change. */
export interface SyncPublishOptions {
  /**
   * Route this document to peers filtering on this value — a tenant, region,
   * or partition key. Later updates and deletes to the same document reuse it
   * automatically. Unfiltered (wildcard) peers still receive it.
   */
  filter?: string;
  /**
   * AND composite filter — reaches only peers filtering on all of these
   * values together. Ignored when `filter` is also set.
   */
  filters?: string[];
}

/** Options for `NoLagSync.joinCollection()`. */
export interface JoinCollectionOptions {
  /**
   * Only receive changes published with one of these filter values — sync a
   * partition of the collection rather than all of it.
   *
   * Omit (or pass an empty array) to receive every change.
   */
  filters?: FilterValue[];
}

// ============ Conflict ============

export interface SyncConflict {
  /** Document ID where the conflict occurred */
  documentId: string;
  /** The locally-held change that conflicted */
  localChange: SyncChange;
  /** The remote change that arrived and triggered the conflict */
  remoteChange: SyncChange;
  /** The resolved document state after conflict resolution */
  resolved: SyncDocument;
}

// ============ Collaborator ============

export interface SyncCollaborator {
  /** Stable user ID */
  userId: string;
  /** NoLag internal actor token ID */
  actorTokenId: string;
  /** Human-readable display name */
  username?: string;
  /** Custom metadata */
  metadata?: Record<string, unknown>;
  /** Timestamp when the collaborator joined (ms since epoch) */
  joinedAt: number;
  /** Whether this is the local collaborator */
  isLocal: boolean;
}

// ============ Presence ============

/** Shape of data stored in NoLag presence for sync collaborators */
export interface SyncPresenceData {
  [key: string]: unknown;
  userId: string;
  username?: string;
  metadata?: Record<string, unknown>;
}

// ============ Event Maps ============

export interface SyncClientEvents {
  connected: [];
  disconnected: [reason: string];
  reconnecting: [];
  reconnected: [];
  error: [error: Error];
  collaboratorOnline: [collaborator: SyncCollaborator];
  collaboratorOffline: [collaborator: SyncCollaborator];
}

export interface SyncRoomEvents {
  documentCreated: [document: SyncDocument];
  documentUpdated: [document: SyncDocument];
  documentDeleted: [document: SyncDocument];
  localChange: [change: SyncChange];
  conflict: [conflict: SyncConflict];
  synced: [document: SyncDocument];
  collaboratorJoined: [collaborator: SyncCollaborator];
  collaboratorLeft: [collaborator: SyncCollaborator];
  replayStart: [info: { count: number }];
  replayEnd: [info: { replayed: number }];
}


// ============ Filters ============

/**
 * A single subscription filter value.
 *
 * A plain string is an OR term: `['alice', 'bob']` matches either. A nested
 * array is an AND group: `[['alice', 'admin']]` matches only what was
 * published tagged with both.
 */
export type FilterValue = string | string[];
