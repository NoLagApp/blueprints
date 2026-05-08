import type { RoomContext, MessageMeta } from '@nolag/js-sdk';
import { EventEmitter } from './EventEmitter';
import { NotificationStore } from './NotificationStore';
import { generateId } from './utils';
import { TOPIC_NOTIFICATIONS, TOPIC_READ } from './constants';
import type {
  NotifyChannelEvents,
  Notification,
  ResolvedNotifyOptions,
  SendNotificationOptions,
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
  private _active = false;

  /** @internal */
  constructor(
    name: string,
    roomContext: RoomContext,
    options: ResolvedNotifyOptions,
    log: (...args: unknown[]) => void,
  ) {
    super();
    this.name = name;
    this._roomContext = roomContext;
    this._options = options;
    this._store = new NotificationStore(options.maxNotificationCache);
    this._log = log;
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

    this._roomContext.emit(TOPIC_NOTIFICATIONS, {
      id: notification.id,
      channel: notification.channel,
      title: notification.title,
      body: notification.body,
      icon: notification.icon,
      data: notification.data,
      timestamp: notification.timestamp,
    });
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
  _subscribe(): void {
    this._log('Channel subscribe:', this.name);

    this._roomContext.subscribe(TOPIC_NOTIFICATIONS);
    this._roomContext.subscribe(TOPIC_READ);

    this._roomContext.on(TOPIC_NOTIFICATIONS, (data: unknown, meta: MessageMeta) => {
      this._handleIncomingNotification(data, meta);
    });

    this._roomContext.on(TOPIC_READ, (data: unknown) => {
      this._handleIncomingRead(data);
    });
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

    this._roomContext.unsubscribe(TOPIC_NOTIFICATIONS);
    this._roomContext.unsubscribe(TOPIC_READ);
    this._roomContext.off(TOPIC_NOTIFICATIONS);
    this._roomContext.off(TOPIC_READ);

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
