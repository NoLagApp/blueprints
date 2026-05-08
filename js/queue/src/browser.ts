/**
 * @nolag/queue — Browser entry point
 */

export { NoLagQueue } from './NoLagQueue';
export { QueueRoom } from './QueueRoom';
export { JobStore } from './JobStore';
export { WorkerManager } from './WorkerManager';
export { PresenceManager } from './PresenceManager';
export { EventEmitter } from './EventEmitter';

export type {
  NoLagQueueOptions,
  ResolvedQueueOptions,
  WorkerRole,
  JobStatus,
  JobPriority,
  Job,
  AddJobOptions,
  JobProgress,
  QueueWorker,
  QueuePresenceData,
  QueueClientEvents,
  QueueRoomEvents,
} from './types';
