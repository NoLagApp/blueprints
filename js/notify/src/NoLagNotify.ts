import type {
  NoLagOptions,
  LobbyPresenceEvent,
  LobbyPresenceState,
  LobbyContext,
  ActorPresence,
} from '@nolag/js-sdk';
import { NoLag } from '@nolag/js-sdk';
import { EventEmitter } from './EventEmitter';
import { NotifyChannel } from './NotifyChannel';
import { BadgeManager } from './BadgeManager';
import { PresenceManager } from './PresenceManager';
import { generateId, createLogger } from './utils';
import {
  DEFAULT_APP_NAME,
  DEFAULT_MAX_NOTIFICATION_CACHE,
  LOBBY_ID,
} from './constants';
import type {
  NoLagNotifyOptions,
  ResolvedNotifyOptions,
  NotifyClientEvents,
  NotifyPresenceData,
  BadgeCounts,
} from './types';

// The NoLag factory returns a client instance.
type NoLagClient = ReturnType<typeof NoLag>;

/**
 * NoLagNotify — high-level notifications SDK built on @nolag/js-sdk.
 *
 * Provides multi-channel notifications, read/unread tracking, badge counts,
 * message replay, and global presence — all framework-agnostic via events.
 *
 * @example
 * ```typescript
 * import { NoLagNotify } from '@nolag/notify';
 *
 * const notify = new NoLagNotify(token);
 *
 * notify.on('connected', () => console.log('Connected!'));
 * notify.on('notification', (n) => console.log('New notification:', n.title));
 *
 * await notify.connect();
 *
 * const alerts = notify.subscribe('alerts');
 * alerts.on('notification', (n) => console.log(n.title));
 * ```
 */
export class NoLagNotify extends EventEmitter<NotifyClientEvents> {
  private _token: string;
  private _options: ResolvedNotifyOptions;
  private _client: NoLagClient | null = null;
  private _channels = new Map<string, NotifyChannel>();
  private _lobby: LobbyContext | null = null;
  private _badgeManager = new BadgeManager();
  private _presenceManager = new PresenceManager();
  private _actorToUserId = new Map<string, string>();
  private _userId: string;
  private _log: (...args: unknown[]) => void;

  constructor(token: string, options: NoLagNotifyOptions = {}) {
    super();
    this._token = token;
    this._userId = generateId();

    this._options = {
      metadata: options.metadata,
      appName: options.appName ?? DEFAULT_APP_NAME,
      url: options.url,
      maxNotificationCache: options.maxNotificationCache ?? DEFAULT_MAX_NOTIFICATION_CACHE,
      debug: options.debug ?? false,
      reconnect: options.reconnect ?? true,
      channels: options.channels ?? [],
    };

    this._log = createLogger('NoLagNotify', this._options.debug);
  }

  // ============ Public Properties ============

  /** Whether the underlying connection is established */
  get connected(): boolean {
    return this._client?.connected ?? false;
  }

  /** All currently subscribed channels */
  get channels(): Map<string, NotifyChannel> {
    return this._channels;
  }

  // ============ Lifecycle ============

  /**
   * Connect to NoLag and set up global presence.
   */
  async connect(): Promise<void> {
    this._log('Connecting...');

    const clientOptions: NoLagOptions = {
      debug: this._options.debug,
      reconnect: this._options.reconnect,
    };
    if (this._options.url) {
      clientOptions.url = this._options.url;
    }

    this._client = NoLag(this._token, clientOptions);

    // Wire client lifecycle events
    this._client.on('connect', () => {
      this._log('Connected');
      if (this._channels.size > 0) {
        this._log('Reconnected — restoring channels...');
        this._restoreChannels();
        this.emit('reconnected');
      }
    });

    this._client.on('disconnect', (reason: string) => {
      this._log('Disconnected:', reason);
      this.emit('disconnected', reason);
    });

    this._client.on('reconnect', () => {
      this._log('Reconnecting...');
    });

    this._client.on('error', (error: Error) => {
      this._log('Error:', error);
      this.emit('error', error);
    });

    // Wire replay events
    this._client.on('replay:start', (data: unknown) => {
      const event = data as { count: number };
      for (const channel of this._channels.values()) {
        channel._handleReplayStart(event.count);
      }
    });

    this._client.on('replay:end', (data: unknown) => {
      const event = data as { replayed: number };
      for (const channel of this._channels.values()) {
        channel._handleReplayEnd(event.replayed);
      }
    });

    // Connect
    await this._client.connect();

    // Wire room-level presence events
    this._client.on('presence:join', (data: ActorPresence) => {
      this._handleRoomPresenceJoin(data);
    });
    this._client.on('presence:leave', (data: ActorPresence) => {
      this._handleRoomPresenceLeave(data);
    });
    this._client.on('presence:update', (data: ActorPresence) => {
      this._handleRoomPresenceUpdate(data);
    });

    this._log('Local userId:', this._userId, '→ actorId:', this._client.actorId);

    // Set up lobby for global presence
    await this._setupLobby();

    // Pre-subscribe to all configured channels
    for (const channelName of this._options.channels) {
      this._subscribeChannel(channelName);
    }

    // Emit connected now that lobby is ready
    this.emit('connected');

    // Deferred lobby refetch to catch late-joining users
    setTimeout(() => {
      if (this._lobby && this._client?.connected) {
        this._lobby.fetchPresence().then((state) => {
          this._hydratePresence(state);
        }).catch(() => { /* best-effort */ });
      }
    }, 2000);
  }

  /**
   * Disconnect from NoLag and clean up all channels.
   */
  disconnect(): void {
    this._log('Disconnecting...');

    for (const name of [...this._channels.keys()]) {
      this.unsubscribe(name);
    }

    this._lobby?.unsubscribe();
    this._lobby = null;

    this._client?.disconnect();
    this._client = null;

    this._badgeManager.clear();
    this._presenceManager.clear();
    this._actorToUserId.clear();
  }

  // ============ Channel Management ============

  /**
   * Subscribe to a notification channel (idempotent).
   * Returns the NotifyChannel instance.
   */
  subscribe(channelName: string): NotifyChannel {
    if (!this._client) {
      throw new Error('Not connected — call connect() first');
    }

    const existing = this._channels.get(channelName);
    if (existing) return existing;

    const channel = this._subscribeChannel(channelName);
    channel._activate();

    return channel;
  }

  /**
   * Unsubscribe from a notification channel.
   */
  unsubscribe(channelName: string): void {
    const channel = this._channels.get(channelName);
    if (!channel) return;

    this._log('Unsubscribing channel:', channelName);
    channel._cleanup();
    this._channels.delete(channelName);
    this._badgeManager.update(channelName, 0);
    this._emitBadgeUpdated();
  }

  // ============ Badge Counts ============

  /**
   * Get the current badge counts across all channels.
   */
  getBadgeCounts(): BadgeCounts {
    return this._badgeManager.getAll();
  }

  // ============ Read Tracking ============

  /**
   * Mark all notifications as read across all channels.
   */
  markAllRead(): void {
    for (const channel of this._channels.values()) {
      channel.markAllRead();
    }
  }

  // ============ Private: Channel Setup ============

  private _subscribeChannel(name: string): NotifyChannel {
    if (!this._client) {
      throw new Error('Not connected — call connect() first');
    }

    this._log('Subscribing channel:', name);

    const roomContext = this._client.setApp(this._options.appName).setRoom(name);
    const channel = new NotifyChannel(
      name,
      roomContext,
      this._options,
      createLogger(`NotifyChannel:${name}`, this._options.debug),
    );

    this._channels.set(name, channel);
    channel._subscribe();

    // Relay notifications up to the main client and update badges
    channel.on('notification', (notification) => {
      this._badgeManager.update(name, channel.unreadCount);
      this._emitBadgeUpdated();
      this.emit('notification', notification);
    });

    channel.on('read', () => {
      this._badgeManager.update(name, channel.unreadCount);
      this._emitBadgeUpdated();
    });

    channel.on('readAll', () => {
      this._badgeManager.update(name, 0);
      this._emitBadgeUpdated();
    });

    return channel;
  }

  private _emitBadgeUpdated(): void {
    this.emit('badgeUpdated', this._badgeManager.getAll());
  }

  // ============ Private: Room Presence ============

  private _handleRoomPresenceJoin(data: ActorPresence): void {
    if (data.actorTokenId === this._client?.actorId) return;
    const presenceData = data.presence as unknown as NotifyPresenceData;
    if (!presenceData?.userId) return;

    const user = this._presenceManager.addFromPresence(data.actorTokenId, presenceData);
    if (user) {
      this._actorToUserId.set(data.actorTokenId, user.userId);
    }
  }

  private _handleRoomPresenceLeave(data: ActorPresence): void {
    if (data.actorTokenId === this._client?.actorId) return;
    this._presenceManager.removeByActorId(data.actorTokenId);
  }

  private _handleRoomPresenceUpdate(data: ActorPresence): void {
    if (data.actorTokenId === this._client?.actorId) return;
    const presenceData = data.presence as unknown as NotifyPresenceData;
    if (!presenceData?.userId) return;
    this._presenceManager.addFromPresence(data.actorTokenId, presenceData);
  }

  // ============ Private: Lobby ============

  private async _setupLobby(): Promise<void> {
    if (!this._client) return;

    this._lobby = this._client.setApp(this._options.appName).setLobby(LOBBY_ID);

    // Set local presence in the lobby
    const presenceData: NotifyPresenceData = {
      userId: this._userId,
      metadata: this._options.metadata,
    };
    this._lobby.setPresence?.(presenceData);

    const lobbyHandler = (type: 'join' | 'leave' | 'update') =>
      (data: unknown) => {
        const event = data as LobbyPresenceEvent;
        if (type === 'join') this._handleLobbyJoin(event);
        else if (type === 'leave') this._handleLobbyLeave(event);
        else this._handleLobbyUpdate(event);
      };

    this._client.on('lobbyPresence:join', lobbyHandler('join'));
    this._client.on('lobbyPresence:leave', lobbyHandler('leave'));
    this._client.on('lobbyPresence:update', lobbyHandler('update'));

    try {
      const initialState = await this._lobby.subscribe();
      this._hydratePresence(initialState);
      this._log('Lobby subscribed');
    } catch (err) {
      this._log('Lobby subscription failed:', err);
    }
  }

  private _handleLobbyJoin(event: LobbyPresenceEvent): void {
    const { actorId, data } = event;
    if (actorId === this._client?.actorId) return;

    const presenceData = data as unknown as NotifyPresenceData;
    if (!presenceData?.userId) return;

    const user = this._presenceManager.addFromPresence(actorId, presenceData);
    if (user) {
      this._actorToUserId.set(actorId, user.userId);
    }
  }

  private _handleLobbyLeave(event: LobbyPresenceEvent): void {
    const { actorId } = event;
    if (actorId === this._client?.actorId) return;
    this._presenceManager.removeByActorId(actorId);
    this._actorToUserId.delete(actorId);
  }

  private _handleLobbyUpdate(event: LobbyPresenceEvent): void {
    const { actorId, data } = event;
    if (actorId === this._client?.actorId) return;

    const presenceData = data as unknown as NotifyPresenceData;
    if (!presenceData?.userId) return;
    this._presenceManager.addFromPresence(actorId, presenceData);
  }

  private _hydratePresence(state: LobbyPresenceState): void {
    for (const roomId of Object.keys(state)) {
      const roomPresence = state[roomId];
      for (const actorId of Object.keys(roomPresence)) {
        if (actorId === this._client?.actorId) continue;

        const raw = roomPresence[actorId] as Record<string, unknown>;
        const presenceData = (raw?.presence ?? raw) as unknown as NotifyPresenceData;
        if (presenceData?.userId) {
          const user = this._presenceManager.addFromPresence(actorId, presenceData);
          if (user) {
            this._actorToUserId.set(actorId, user.userId);
          }
        }
      }
    }
  }

  // ============ Private: Reconnect ============

  private _restoreChannels(): void {
    this._lobby?.fetchPresence().then((state) => {
      this._presenceManager.clear();
      this._actorToUserId.clear();
      this._hydratePresence(state);
    }).catch((err) => {
      this._log('Failed to re-fetch lobby presence:', err);
    });
  }
}
