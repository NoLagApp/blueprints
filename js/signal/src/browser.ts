/**
 * @nolag/signal — Browser entry point
 */

export { NoLagSignal } from './NoLagSignal';
export { SignalRoom } from './SignalRoom';
export { EventEmitter } from './EventEmitter';

export type {
  NoLagSignalOptions,
  ResolvedSignalOptions,
  SignalType,
  SignalMessage,
  Peer,
  SignalPresenceData,
  SignalClientEvents,
  SignalRoomEvents,
} from './types';
