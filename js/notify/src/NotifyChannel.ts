import type { RoomContext, MessageMeta } from '@nolag/js-sdk';
import { EventEmitter } from './EventEmitter';
import { NotificationStore } from './NotificationStore';
import { generateId, filterEmitOptions, mergeFilters, withoutFilters } from './utils';
import { TOPIC_NOTIFICATIONS, TOPIC_READ } from './constants';
import type {
  NotifyChannelEvents,
  Notification,
  ResolvedNotifyOptions,
  SendNotificationOptions,
  FilterValue,
} from './types';

/**
 * NotifyChannel — a single notification channel with read/unread tracking.
 *
 * Created via `NoLagNotify.subscribe(name)`. Do not instantiate directly.
 */
export class NotifyChannel extends EventEmitter<NotifyChannelEvents> {
  /** Channel name */
  readonly name: string;

  private _roomContext: RoomContext;
  private _options: ResolvedNotifyOptions;
  private _store: NotificationStore;
  private _log: (...args: unknown[]) => void;
  private _isConnected: () => boolean;
  private _active = false;
  private _filters: FilterValue[] = [];

  // Stored topic handler refs — cleanup removes exactly these, never all
  // handlers for a topic (the client may be shared with other consumers).
  private _onNotificationsRef: ((data: unknown, meta: MessageMeta) => void) | null = null;
  private _onReadRef: ((data: unknown) => void) | null = null;

  /** @internal */
  constructor(
    name: string,
    roomContext: RoomContext,
    options: ResolvedNotifyOptions,
    log: (...args: unknown[]) => void,
    isConnected: () => boolean,
  ) {
    super();
    this.name = name;
    this._roomContext = roomContext;
    this._options = options;
    this._store = new NotificationStore(options.maxNotificationCache);
    this._log = log;
    this._isConnected = isConnected;
  }

  // ============ Public Properties ============

  /** All notifications in this channel (timestamp order) */
  get notifications(): Notification[] {
    return this._store.getAll();
  }

  /** Number of unread notifications */
  get unreadCount(): number {
    return this._store.unreadCount;
  }

  /** Whether this channel is currently active */
  get active(): boolean {
    return this._active;
  }

  // ============ Sending ============

  /**
   * Send a notification to this channel.
   */
  send(title: string, opts?: SendNotificationOptions): void {
    const notification: Notification = {
      id: generateId(),
      channel: this.name,
      title,
      body: opts?.body,
      icon: opts?.icon,
      data: opts?.data,
      timestamp: Date.now(),
      read: false,
      isReplay: false,
    };

    const payload = {
      id: notification.id,
      channel: notification.channel,
      title: notification.title,
      body: notification.body,
      icon: notification.icon,
      data: notification.data,
      timestamp: notification.timestamp,
    };

    // Only pass options when there is a filter: an unfiltered send should look
    // exactly as it did before filters existed.
    const emitOpts = filterEmitOptions(opts);
    if (Object.keys(emitOpts).length > 0) {
      this._roomContext.emit(TOPIC_NOTIFICATIONS, payload, emitOpts);
    } else {
      this._roomContext.emit(TOPIC_NOTIFICATIONS, payload);
    }
  }

  // ============ Filters ============

  /** The filter values currently applied to this channel. */
  get filters(): FilterValue[] {
    return [...this._filters];
  }

  /**
   * Replace this channel's filters — only notifications published with one of
   * these values are delivered. Subscribe with your own user id (or role) to
   * receive only what was addressed to you.
   *
   * Passing an empty array clears filtering and restores the wildcard
   * subscription, which receives every notification on the channel.
   *
   * @example
   * ```ts
   * channel.setFilters(['user-42', 'all-hands']); // mine OR broadcast
   * channel.setFilters([['eu', 'admin']]);        // eu AND admin
   * channel.setFilters([]);                        // everything
   * ```
   */
  setFilters(values: FilterValue[]): void {
    this._filters = [...values];
    // The core types filters as `string[]`, but both its implementation and
    // the wire protocol accept AND groups (nested arrays).
    this._roomContext.setFilters(TOPIC_NOTIFICATIONS, this._filters as unknown as string[]);
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

  // ============ Read Tracking ============

  /**
   * Mark a single notification as read by id.
   * Emits the read receipt to the _read topic for cross-tab sync.
   */
  markRead(id: string): void {
    if (this._store.markRead(id)) {
      this._log('Mark read:', id);
      this._roomContext.emit(TOPIC_READ, { id, channel: this.name });
      this.emit('read', id);
    }
  }

  /**
   * Mark all notifications in this channel as read.
   */
  markAllRead(): void {
    this._store.markAllRead();
    this._log('Mark all read:', this.name);
    this._roomContext.emit(TOPIC_READ, { all: true, channel: this.name });
    this.emit('readAll');
  }

  /**
   * Get all notifications (alias for the notifications getter).
   */
  getNotifications(): Notification[] {
    return this._store.getAll();
  }

  /**
   * Get all unread notifications.
   */
  getUnread(): Notification[] {
    return this._store.getUnread();
  }

  // ============ Internal (called by NoLagNotify) ============

  /** @internal Subscribe to notifications and _read topics */
  _subscribe(filters?: FilterValue[]): void {
    this._log('Channel subscribe:', this.name);

    this._filters = filters ? [...filters] : [];

    // Read receipts stay unfiltered: they are this user's own cross-tab sync.
    if (this._filters.length > 0) {
      this._roomContext.subscribe(TOPIC_NOTIFICATIONS, { filters: this._filters });
    } else {
      this._roomContext.subscribe(TOPIC_NOTIFICATIONS);
    }
    this._roomContext.subscribe(TOPIC_READ);

    // Listen for notifications (refs stored for handler-specific removal)
    this._onNotificationsRef = (data: unknown, meta: MessageMeta) => {
      this._handleIncomingNotification(data, meta);
    };
    this._roomContext.on(TOPIC_NOTIFICATIONS, this._onNotificationsRef);

    this._onReadRef = (data: unknown) => {
      this._handleIncomingRead(data);
    };
    this._roomContext.on(TOPIC_READ, this._onReadRef);
  }

  /** @internal Activate this channel (mark as visible/active) */
  _activate(): void {
    this._log('Channel activate:', this.name);
    this._active = true;
  }

  /** @internal Deactivate this channel */
  _deactivate(): void {
    this._log('Channel deactivate:', this.name);
    this._active = false;
  }

  /** @internal Handle replay start event */
  _handleReplayStart(count: number): void {
    this.emit('replayStart', { count });
  }

  /** @internal Handle replay end event */
  _handleReplayEnd(replayed: number): void {
    this.emit('replayEnd', { replayed });
  }

  /** @internal Unsubscribe and clean up */
  _cleanup(): void {
    this._log('Channel cleanup:', this.name);

    // Server unsubscribes need a live socket; skip when disconnected
    // (best-effort — the core would no-op with an error callback anyway).
    if (this._isConnected()) {
      this._roomContext.unsubscribe(TOPIC_NOTIFICATIONS);
      this._roomContext.unsubscribe(TOPIC_READ);
    }

    // Handler-specific removal only: the client may be shared, and a bare
    // off(topic) would strip other consumers' handlers too.
    if (this._onNotificationsRef) this._roomContext.off(TOPIC_NOTIFICATIONS, this._onNotificationsRef);
    if (this._onReadRef) this._roomContext.off(TOPIC_READ, this._onReadRef);
    this._onNotificationsRef = null;
    this._onReadRef = null;

    this._store.clear();
    this.removeAllListeners();
  }

  // ============ Private ============

  private _handleIncomingNotification(data: unknown, meta: MessageMeta): void {
    const raw = data as Record<string, unknown>;

    const notification: Notification = {
      id: (raw.id as string) || generateId(),
      channel: this.name,
      title: raw.title as string,
      body: raw.body as string | undefined,
      icon: raw.icon as string | undefined,
      data: raw.data as Record<string, unknown> | undefined,
      timestamp: raw.timestamp as number || Date.now(),
      read: false,
      isReplay: meta.isReplay ?? false,
    };

    if (this._store.add(notification)) {
      this._log('Notification received:', notification.id, notification.title);
      this.emit('notification', notification);
    }
  }

  private _handleIncomingRead(data: unknown): void {
    const raw = data as Record<string, unknown>;

    if (raw.all === true) {
      this._store.markAllRead();
      this.emit('readAll');
    } else if (typeof raw.id === 'string') {
      if (this._store.markRead(raw.id)) {
        this.emit('read', raw.id);
      }
    }
  }
}
