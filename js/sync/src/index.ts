/**
 * @nolag/sync
 * Real-time data sync SDK for Node.js
 */

export { NoLagSync } from './NoLagSync';
export { SyncRoom } from './SyncRoom';
export { DocumentStore } from './DocumentStore';
export { ConflictResolver } from './ConflictResolver';
export { PresenceManager } from './PresenceManager';
export { EventEmitter } from './EventEmitter';

export type {
  NoLagSyncOptions,
  ResolvedSyncOptions,
  SyncDocument,
  SyncChangeType,
  SyncChange,
  SyncConflict,
  SyncCollaborator,
  SyncPresenceData,
  SyncClientEvents,
  SyncRoomEvents,
} from './types';
