import type { RoomContext } from '@nolag/js-sdk';
import { EventEmitter } from './EventEmitter';
import { PresenceManager } from './PresenceManager';
import { OperationStore } from './OperationStore';
import { AwarenessManager } from './AwarenessManager';
import { generateId } from './utils';
import { TOPIC_OPERATIONS, TOPIC_CURSORS } from './constants';
import type {
  CollabDocumentEvents,
  CollabOperation,
  CollabUser,
  CollabPresenceData,
  CursorPosition,
  CursorUpdateOptions,
  OperationType,
  SendOperationOptions,
  UserStatus,
  ResolvedCollabOptions,
} from './types';

/**
 * CollabDocument — a single collaborative document room.
 *
 * Created via `NoLagCollab.joinDocument(name)`. Do not instantiate directly.
 *
 * Subscribes to 'operations' and '_cursors' topics and exposes a clean API
 * for sending operations, broadcasting cursor positions, and managing
 * user awareness (idle detection, status).
 */
export class CollabDocument extends EventEmitter<CollabDocumentEvents> {
  /** Document name */
  readonly name: string;

  private _roomContext: RoomContext;
  private _localUser: CollabUser;
  private _options: ResolvedCollabOptions;
  private _presenceManager: PresenceManager;
  private _operationStore: OperationStore;
  private _awarenessManager: AwarenessManager;
  private _log: (...args: unknown[]) => void;

  /** Throttle state for cursor updates */
  private _cursorThrottleTimer: ReturnType<typeof setTimeout> | null = null;
  private _pendingCursorUpdate: CursorUpdateOptions | null = null;

  /** @internal */
  constructor(
    name: string,
    roomContext: RoomContext,
    localUser: CollabUser,
    options: ResolvedCollabOptions,
    log: (...args: unknown[]) => void,
  ) {
    super();
    this.name = name;
    this._roomContext = roomContext;
    this._localUser = localUser;
    this._options = options;
    this._log = log;

    this._presenceManager = new PresenceManager(localUser.actorTokenId);
    this._operationStore = new OperationStore(options.maxOperationCache);
    this._awarenessManager = new AwarenessManager(localUser.userId);
  }

  // ============ Public Properties ============

  /** All remote users currently in this document */
  get users(): Map<string, CollabUser> {
    return this._presenceManager.users;
  }

  // ============ Operations ============

  /**
   * Send an operation to all collaborators in this document.
   * Returns the operation that was created and broadcast.
   */
  sendOperation(type: OperationType, opts: SendOperationOptions = {}): CollabOperation {
    const op: CollabOperation = {
      id: generateId(),
      type,
      path: opts.path,
      position: opts.position,
      length: opts.length,
      content: opts.content,
      data: opts.data,
      userId: this._localUser.userId,
      username: this._localUser.username,
      timestamp: Date.now(),
      isReplay: false,
    };

    this._log('Sending operation:', type, op.id);

    this._operationStore.add(op);
    this._roomContext.emit(TOPIC_OPERATIONS, op, { echo: false });

    return op;
  }

  /**
   * Get all cached operations for this document, in timestamp order.
   */
  getOperations(): CollabOperation[] {
    return this._operationStore.getAll();
  }

  // ============ Cursors ============

  /**
   * Broadcast a cursor position update. Calls are throttled by the
   * cursorThrottle option (default 50 ms) to avoid flooding.
   */
  updateCursor(opts: CursorUpdateOptions): void {
    this._pendingCursorUpdate = opts;

    if (this._cursorThrottleTimer !== null) {
      // Already scheduled — the pending update will be sent when it fires
      return;
    }

    // Send immediately for the first call in the window, then throttle
    this._flushCursorUpdate();

    this._cursorThrottleTimer = setTimeout(() => {
      this._cursorThrottleTimer = null;
      if (this._pendingCursorUpdate) {
        this._flushCursorUpdate();
      }
    }, this._options.cursorThrottle);
  }

  /**
   * Get all remote cursor positions.
   */
  getCursors(): CursorPosition[] {
    return this._awarenessManager.getCursors();
  }

  // ============ Awareness ============

  /**
   * Update the local user's activity status and broadcast it.
   */
  setStatus(status: UserStatus): void {
    this._localUser = { ...this._localUser, status };
    this._setPresence();

    this._log('Status updated:', status);
  }

  // ============ Users ============

  /**
   * Get all remote users currently in the document.
   */
  getUsers(): CollabUser[] {
    return this._presenceManager.getAll();
  }

  /**
   * Get a specific user by userId.
   */
  getUser(userId: string): CollabUser | undefined {
    return this._presenceManager.getUser(userId);
  }

  // ============ Internal (called by NoLagCollab) ============

  /** @internal Subscribe to operations and cursors topics and attach listeners */
  _subscribe(): void {
    this._log('Document subscribe:', this.name);

    this._roomContext.subscribe(TOPIC_OPERATIONS);
    this._roomContext.subscribe(TOPIC_CURSORS);

    this._roomContext.on(TOPIC_OPERATIONS, (data: unknown) => {
      this._handleIncomingOperation(data);
    });

    this._roomContext.on(TOPIC_CURSORS, (data: unknown) => {
      this._handleIncomingCursor(data);
    });
  }

  /** @internal Set presence and fetch current room members */
  _activate(): void {
    this._log('Document activate:', this.name);
    this._setPresence();

    this._roomContext.fetchPresence().then((actors) => {
      this._log('Document presence fetched:', this.name, actors.length, 'actors');
      for (const actor of actors) {
        if (actor.presence) {
          const user = this._presenceManager.addFromPresence(
            actor.actorTokenId,
            actor.presence as CollabPresenceData,
            actor.joinedAt,
          );
          if (user) {
            this._awarenessManager.setStatus(user.userId, user.status);
            this.emit('userJoined', user);
          }
        }
      }
    }).catch((err) => {
      this._log('Failed to fetch document presence:', err);
    });
  }

  /** @internal Re-set presence after reconnect */
  _updateLocalPresence(): void {
    this._setPresence();
  }

  /** @internal Handle a presence:join event */
  _handlePresenceJoin(actorTokenId: string, presenceData: CollabPresenceData): void {
    const user = this._presenceManager.addFromPresence(actorTokenId, presenceData);
    if (user) {
      this._log('User joined document:', this.name, user.userId);
      this._awarenessManager.setStatus(user.userId, user.status);
      this._startUserIdleTracking(user);
      this.emit('userJoined', user);
    }
  }

  /** @internal Handle a presence:leave event */
  _handlePresenceLeave(actorTokenId: string): void {
    const user = this._presenceManager.removeByActorId(actorTokenId);
    if (user) {
      this._log('User left document:', this.name, user.userId);
      this._awarenessManager.removeCursor(user.userId);
      this.emit('userLeft', user);
    }
  }

  /** @internal Handle a presence:update event */
  _handlePresenceUpdate(actorTokenId: string, presenceData: CollabPresenceData): void {
    const user = this._presenceManager.addFromPresence(actorTokenId, presenceData);
    if (user) {
      this._awarenessManager.setStatus(user.userId, user.status);
    }
  }

  /** @internal Replay operations from another source (e.g. history fetch) */
  _replayOperations(ops: CollabOperation[]): void {
    const pending = ops.filter((op) => !this._operationStore.has(op.id));
    if (pending.length === 0) return;

    this._log('Replaying', pending.length, 'operations');
    this.emit('replayStart', { count: pending.length });

    let replayed = 0;
    for (const op of pending) {
      const replayOp: CollabOperation = { ...op, isReplay: true };
      if (this._operationStore.add(replayOp)) {
        this.emit('operation', replayOp);
        replayed++;
      }
    }

    this.emit('replayEnd', { replayed });
  }

  /** @internal Unsubscribe and clean up */
  _cleanup(): void {
    this._log('Document cleanup:', this.name);

    // Cancel throttle timer
    if (this._cursorThrottleTimer !== null) {
      clearTimeout(this._cursorThrottleTimer);
      this._cursorThrottleTimer = null;
    }

    this._roomContext.unsubscribe(TOPIC_OPERATIONS);
    this._roomContext.unsubscribe(TOPIC_CURSORS);
    this._roomContext.off(TOPIC_OPERATIONS);
    this._roomContext.off(TOPIC_CURSORS);

    this._awarenessManager.dispose();
    this._presenceManager.clear();
    this._operationStore.clear();
    this.removeAllListeners();
  }

  // ============ Private ============

  private _handleIncomingOperation(data: unknown): void {
    const op = data as CollabOperation;

    // Deduplicate
    if (this._operationStore.has(op.id)) return;

    const stored: CollabOperation = { ...op, isReplay: false };
    this._operationStore.add(stored);

    this._log('Received operation:', op.type, op.id, 'from', op.userId);
    this.emit('operation', stored);
  }

  private _handleIncomingCursor(data: unknown): void {
    const cursor = data as CursorPosition;

    // Ignore own cursor echoes (should not happen with echo: false, but guard anyway)
    if (cursor.userId === this._localUser.userId) return;

    this._awarenessManager.updateCursor(cursor.userId, cursor);

    // Reset idle tracking for this user
    const user = this._presenceManager.getUser(cursor.userId);
    if (user) {
      this._startUserIdleTracking(user);
    }

    this._log('Cursor moved:', cursor.userId);
    this.emit('cursorMoved', cursor);
  }

  private _flushCursorUpdate(): void {
    if (!this._pendingCursorUpdate) return;

    const opts = this._pendingCursorUpdate;
    this._pendingCursorUpdate = null;

    const cursor: CursorPosition = {
      userId: this._localUser.userId,
      username: this._localUser.username,
      color: this._localUser.color,
      timestamp: Date.now(),
      ...opts,
    };

    this._awarenessManager.updateCursor(this._localUser.userId, cursor);
    this._roomContext.emit(TOPIC_CURSORS, cursor, { echo: false });
  }

  private _setPresence(): void {
    const presenceData: CollabPresenceData = {
      userId: this._localUser.userId,
      username: this._localUser.username,
      avatar: this._localUser.avatar,
      color: this._localUser.color,
      status: this._localUser.status,
      metadata: this._localUser.metadata,
    };
    this._roomContext.setPresence(presenceData);
  }

  private _startUserIdleTracking(user: CollabUser): void {
    // Mark user as active first
    if (this._awarenessManager.getStatus(user.userId) !== 'active') {
      this._awarenessManager.setStatus(user.userId, 'active');
    }

    this._awarenessManager.startIdleTracking(
      user.userId,
      this._options.idleTimeout,
      () => {
        this._log('User went idle:', user.userId);
        this.emit('awarenessChanged', { userId: user.userId, status: 'idle' });
      },
    );
  }
}
