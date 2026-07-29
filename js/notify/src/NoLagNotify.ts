import type {
  LobbyPresenceEvent,
  LobbyPresenceState,
  LobbyContext,
  ActorPresence,
  NoLagSocket,
} from '@nolag/js-sdk';
import { EventEmitter } from './EventEmitter';
import { NotifyChannel } from './NotifyChannel';
import { BadgeManager } from './BadgeManager';
import { PresenceManager } from './PresenceManager';
import { generateId, createLogger, registerWrapper, releaseWrapper } from './utils';
import {
  DEFAULT_APP_NAME,
  DEFAULT_MAX_NOTIFICATION_CACHE,
  LOBBY_ID,
  LOBBY_REFRESH_DELAY_MS,
} from './constants';
import type {
  NoLagNotifyOptions,
  ResolvedNotifyOptions,
  NotifyClientEvents,
  NotifyPresenceData,
  BadgeCounts,
} from './types';

/**
 * NoLagNotify — high-level notifications SDK built on @nolag/js-sdk.
 *
 * Provides multi-channel notifications, read/unread tracking, badge counts,
 * message replay, and global presence — all framework-agnostic via events.
 *
 * The wrapper NEVER manages the connection. The app owns one core NoLag
 * client (shared by any number of wrappers on distinct apps) and the
 * wrapper attaches to it at construction and releases it via `detach()`.
 *
 * @example
 * ```typescript
 * import { NoLag } from '@nolag/js-sdk';
 * import { NoLagNotify } from '@nolag/notify';
 *
 * const client = NoLag(async () => (await (await fetch('/api/nolag-token')).json()).token);
 * const notify = new NoLagNotify({ client, appName: 'my-notify' });
 *
 * notify.on('notification', (n) => console.log('New notification:', n.title));
 *
 * await client.connect();   // the app owns the connection
 * await notify.ready();      // wrapper setup done (identity, lobby, channels)
 *
 * const alerts = notify.subscribe('alerts');
 * alerts.on('notification', (n) => console.log(n.title));
 *
 * notify.detach();           // wrapper releases its handlers and topics
 * client.disconnect();       // the app closes the socket
 * ```
 */
export class NoLagNotify extends EventEmitter<NotifyClientEvents> {
  private _client: NoLagSocket;
  private _options: ResolvedNotifyOptions;
  private _channels = new Map<string, NotifyChannel>();
  private _lobby: LobbyContext | null = null;
  private _badgeManager = new BadgeManager();
  private _presenceManager = new PresenceManager();
  private _actorToUserId = new Map<string, string>();
  private _userId: string;
  private _log: (...args: unknown[]) => void;

  // Lifecycle: one setup run per connection epoch; detach is terminal.
  private _epoch = 0;
  private _detached = false;
  private _isReady = false;
  private _readyResolve!: () => void;
  private _readyReject!: (err: Error) => void;
  private _readyPromise: Promise<void>;
  private _lobbyRefreshTimer: ReturnType<typeof setTimeout> | null = null;

  // Stored client handler refs. INVARIANT: every client.on() below has a
  // matching client.off() in detach() — never bare off(event), never inline
  // closures on the client.
  private _onConnectRef = () => this._onConnect();
  private _onDisconnectRef = (reason: string) => {
    this._log('Disconnected:', reason);
    this.emit('disconnected', reason);
  };
  private _onReconnectRef = () => {
    this._log('Reconnecting...');
    this.emit('reconnecting');
  };
  private _onErrorRef = (error: Error) => {
    this._log('Error:', error);
    this.emit('error', error);
  };
  private _onReplayStartRef = (data: unknown) => {
    const event = data as { count: number };
    for (const channel of this._channels.values()) {
      channel._handleReplayStart(event.count);
    }
  };
  private _onReplayEndRef = (data: unknown) => {
    const event = data as { replayed: number };
    for (const channel of this._channels.values()) {
      channel._handleReplayEnd(event.replayed);
    }
  };
  private _onPresenceJoinRef = (data: ActorPresence) => this._handleRoomPresenceJoin(data);
  private _onPresenceLeaveRef = (data: ActorPresence) => this._handleRoomPresenceLeave(data);
  private _onPresenceUpdateRef = (data: ActorPresence) => this._handleRoomPresenceUpdate(data);
  private _onLobbyJoinRef = (data: unknown) => this._handleLobbyJoin(data as LobbyPresenceEvent);
  private _onLobbyLeaveRef = (data: unknown) => this._handleLobbyLeave(data as LobbyPresenceEvent);
  private _onLobbyUpdateRef = (data: unknown) => this._handleLobbyUpdate(data as LobbyPresenceEvent);

  constructor(options: NoLagNotifyOptions) {
    super();

    if (!options?.client) {
      throw new TypeError(
        'NoLagNotify requires an injected NoLag client: new NoLagNotify({ client, ... })',
      );
    }

    this._client = options.client;
    this._userId = generateId();

    this._options = {
      metadata: options.metadata,
      appName: options.appName ?? DEFAULT_APP_NAME,
      maxNotificationCache: options.maxNotificationCache ?? DEFAULT_MAX_NOTIFICATION_CACHE,
      debug: options.debug ?? false,
      channels: options.channels ?? [],
    };

    this._log = createLogger('NoLagNotify', this._options.debug);

    this._readyPromise = new Promise<void>((resolve, reject) => {
      this._readyResolve = resolve;
      this._readyReject = reject;
    });
    // ready() rejection is only meaningful to callers that await it
    this._readyPromise.catch(() => {});

    registerWrapper(this._client, this._options.appName, 'NoLagNotify');

    // Construction = attach: wire everything now, with stored refs.
    this._client.on('connect', this._onConnectRef);
    this._client.on('disconnect', this._onDisconnectRef);
    this._client.on('reconnect', this._onReconnectRef);
    this._client.on('error', this._onErrorRef);
    this._client.on('replay:start', this._onReplayStartRef);
    this._client.on('replay:end', this._onReplayEndRef);
    this._client.on('presence:join', this._onPresenceJoinRef);
    this._client.on('presence:leave', this._onPresenceLeaveRef);
    this._client.on('presence:update', this._onPresenceUpdateRef);
    this._client.on('lobbyPresence:join', this._onLobbyJoinRef);
    this._client.on('lobbyPresence:leave', this._onLobbyLeaveRef);
    this._client.on('lobbyPresence:update', this._onLobbyUpdateRef);

    // Attach-to-connected: if the client is already authenticated, run setup.
    // The microtask lets the caller wire wrapper event handlers synchronously
    // first; a racing real 'connect' event wins via the epoch guard.
    queueMicrotask(() => {
      if (this._epoch === 0 && !this._detached && this._client.connected) {
        this._onConnect();
      }
    });
  }

  // ============ Public Properties ============

  /** Whether the underlying connection is established (connected ≠ ready) */
  get connected(): boolean {
    return !this._detached && this._client.connected;
  }

  /** The injected core client (owned by the app, not the wrapper) */
  get client(): NoLagSocket {
    return this._client;
  }

  /** All currently subscribed channels */
  get channels(): Map<string, NotifyChannel> {
    return this._channels;
  }

  // ============ Lifecycle ============

  /**
   * Resolves once the wrapper's first setup completed (identity, lobby and
   * configured channels ready — equivalently, once 'connected' has fired).
   * Rejects only if detach() is called before that. Client auth failures
   * surface via the app's own `await client.connect()`, not here.
   */
  ready(): Promise<void> {
    return this._readyPromise;
  }

  /**
   * Detach from the client: remove every handler this wrapper added,
   * unsubscribe its topics and lobby (when connected), clear state.
   * Terminal and idempotent; never touches the socket. To use notify again,
   * construct a new instance.
   */
  detach(): void {
    if (this._detached) return;
    this._log('Detaching...');
    this._detached = true;
    this._epoch++; // aborts any in-flight setup at its next checkpoint

    if (this._lobbyRefreshTimer) {
      clearTimeout(this._lobbyRefreshTimer);
      this._lobbyRefreshTimer = null;
    }

    // Remove all client handlers by stored ref
    this._client.off('connect', this._onConnectRef);
    this._client.off('disconnect', this._onDisconnectRef);
    this._client.off('reconnect', this._onReconnectRef);
    this._client.off('error', this._onErrorRef);
    this._client.off('replay:start', this._onReplayStartRef);
    this._client.off('replay:end', this._onReplayEndRef);
    this._client.off('presence:join', this._onPresenceJoinRef);
    this._client.off('presence:leave', this._onPresenceLeaveRef);
    this._client.off('presence:update', this._onPresenceUpdateRef);
    this._client.off('lobbyPresence:join', this._onLobbyJoinRef);
    this._client.off('lobbyPresence:leave', this._onLobbyLeaveRef);
    this._client.off('lobbyPresence:update', this._onLobbyUpdateRef);

    // Channels: handler-specific off + connected-gated server unsubscribe
    for (const name of [...this._channels.keys()]) {
      this._channels.get(name)!._cleanup();
      this._channels.delete(name);
    }

    // Lobby: server unsubscribe is best-effort and needs a live socket
    if (this._lobby && this._client.connected) {
      try {
        this._lobby.unsubscribe();
      } catch {
        /* best-effort */
      }
    }
    this._lobby = null;

    this._badgeManager.clear();
    this._presenceManager.clear();
    this._actorToUserId.clear();

    releaseWrapper(this._client, this._options.appName);

    if (!this._isReady) {
      this._readyReject(new Error('NoLagNotify detached before ready'));
    }
  }

  // ============ Private: Epoch Setup ============

  private _onConnect(): void {
    this._epoch++;
    void this._runSetup(this._epoch);
  }

  /**
   * One setup pass per connection epoch. Serves both initial setup (epoch 1)
   * and reconnect restore (epoch > 1). Aborts silently whenever a newer
   * epoch started or the wrapper detached — checked after every await.
   */
  private async _runSetup(epoch: number): Promise<void> {
    const stale = () => epoch !== this._epoch || this._detached;
    this._log(this._isReady ? 'Restoring after reconnect...' : 'Setting up...');
    this._log('Local userId:', this._userId, '→ actorId:', this._client.actorId);

    // Lobby: subscribe every epoch (idempotent server-side) and diff-hydrate
    // from the returned snapshot — one path for setup and restore.
    if (!this._lobby) {
      this._lobby = this._client.setApp(this._options.appName).setLobby(LOBBY_ID);
    }
    try {
      const state = await this._lobby.subscribe();
      if (stale()) return;
      this._diffHydratePresence(state);
      this._log('Lobby subscribed');
    } catch (err) {
      if (stale()) return;
      this._log('Lobby subscription failed:', err);
    }

    // First successful setup: pre-subscribe configured channels. The core
    // auto-restores topic subscriptions on reconnect, so later epochs skip it.
    if (!this._isReady) {
      for (const channelName of this._options.channels) {
        this._subscribeChannel(channelName);
      }
    }

    if (stale()) return;

    // Ready keys on the first setup that COMPLETES, not on epoch 1: an
    // epoch aborted by a racing reconnect must not strand ready().
    if (!this._isReady) {
      this._isReady = true;
      this._readyResolve();
      this.emit('connected');
    } else {
      this.emit('reconnected');
    }

    // Deferred lobby refetch: catches users who joined during the setup
    // window (e.g. simultaneous multi-tab connects).
    this._scheduleLobbyRefresh(epoch);
  }

  private _scheduleLobbyRefresh(epoch: number): void {
    if (this._lobbyRefreshTimer) clearTimeout(this._lobbyRefreshTimer);
    this._lobbyRefreshTimer = setTimeout(() => {
      this._lobbyRefreshTimer = null;
      if (epoch !== this._epoch || this._detached || !this._client.connected || !this._lobby) {
        return;
      }
      this._lobby
        .fetchPresence()
        .then((state) => {
          if (epoch !== this._epoch || this._detached) return;
          this._diffHydratePresence(state);
        })
        .catch(() => {
          /* best-effort */
        });
    }, LOBBY_REFRESH_DELAY_MS);
  }

  // ============ Channel Management ============

  /**
   * Subscribe to a notification channel (idempotent).
   * Returns the NotifyChannel instance.
   */
  subscribe(channelName: string): NotifyChannel {
    this._assertUsable();

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

  // ============ Private: Guards ============

  private _assertUsable(): void {
    if (this._detached) {
      throw new Error('NoLagNotify has been detached — construct a new instance');
    }
    if (!this._isReady) {
      throw new Error('NoLagNotify not ready — await ready() or the "connected" event');
    }
  }

  // ============ Private: Channel Setup ============

  private _subscribeChannel(name: string): NotifyChannel {
    this._log('Subscribing channel:', name);

    const roomContext = this._client.setApp(this._options.appName).setRoom(name);
    const channel = new NotifyChannel(
      name,
      roomContext,
      this._options,
      createLogger(`NotifyChannel:${name}`, this._options.debug),
      () => this._client.connected,
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

  // ============ Private: Scope Filtering ============

  /**
   * On a shared client, presence events from other apps' wrappers arrive on
   * the same connection-level events. Wrappers stamp their presence with a
   * `__scope` (their appName); a mismatched tag means another app's data.
   * Untagged presence is accepted (older peers in this same app).
   */
  private _foreignScope(data: NotifyPresenceData | undefined): boolean {
    const scope = (data as Record<string, unknown> | undefined)?.__scope;
    return typeof scope === 'string' && scope !== this._options.appName;
  }

  // ============ Private: Room Presence ============

  private _handleRoomPresenceJoin(data: ActorPresence): void {
    if (data.actorTokenId === this._client.actorId) return;
    const presenceData = data.presence as unknown as NotifyPresenceData;
    if (!presenceData?.userId || this._foreignScope(presenceData)) return;

    const user = this._presenceManager.addFromPresence(data.actorTokenId, presenceData);
    if (user) {
      this._actorToUserId.set(data.actorTokenId, user.userId);
    }
  }

  private _handleRoomPresenceLeave(data: ActorPresence): void {
    if (data.actorTokenId === this._client.actorId) return;
    this._presenceManager.removeByActorId(data.actorTokenId);
  }

  private _handleRoomPresenceUpdate(data: ActorPresence): void {
    if (data.actorTokenId === this._client.actorId) return;
    const presenceData = data.presence as unknown as NotifyPresenceData;
    if (!presenceData?.userId || this._foreignScope(presenceData)) return;
    this._presenceManager.addFromPresence(data.actorTokenId, presenceData);
  }

  // ============ Private: Lobby ============

  private _handleLobbyJoin(event: LobbyPresenceEvent): void {
    const { actorId, data } = event;
    if (actorId === this._client.actorId) return;

    const presenceData = data as unknown as NotifyPresenceData;
    if (!presenceData?.userId || this._foreignScope(presenceData)) return;

    const user = this._presenceManager.addFromPresence(actorId, presenceData);
    if (user) {
      this._actorToUserId.set(actorId, user.userId);
    }
  }

  private _handleLobbyLeave(event: LobbyPresenceEvent): void {
    const { actorId, data } = event;
    if (actorId === this._client.actorId) return;

    const presenceData = data as unknown as NotifyPresenceData;
    if (this._foreignScope(presenceData)) return;
    this._presenceManager.removeByActorId(actorId);
    this._actorToUserId.delete(actorId);
  }

  private _handleLobbyUpdate(event: LobbyPresenceEvent): void {
    const { actorId, data } = event;
    if (actorId === this._client.actorId) return;

    const presenceData = data as unknown as NotifyPresenceData;
    if (!presenceData?.userId || this._foreignScope(presenceData)) return;
    this._presenceManager.addFromPresence(actorId, presenceData);
  }

  /**
   * Reconcile tracked presence against a fresh lobby snapshot. One path for
   * initial hydration, reconnect restore, and the deferred refetch.
   */
  private _diffHydratePresence(state: LobbyPresenceState): void {
    // Build the fresh actor set from the snapshot
    const freshActors = new Set<string>();

    for (const roomId of Object.keys(state)) {
      const roomPresence = state[roomId];
      for (const actorId of Object.keys(roomPresence)) {
        if (actorId === this._client.actorId) continue;

        const raw = roomPresence[actorId] as Record<string, unknown>;
        // Server returns full actor records with presence nested under .presence
        const presenceData = (raw?.presence ?? raw) as unknown as NotifyPresenceData;
        if (presenceData?.userId && !this._foreignScope(presenceData)) {
          freshActors.add(actorId);
          const user = this._presenceManager.addFromPresence(actorId, presenceData);
          if (user) {
            this._actorToUserId.set(actorId, user.userId);
          }
        }
      }
    }

    // Vanished actors: present locally but absent from the fresh snapshot
    for (const [actorId] of [...this._actorToUserId]) {
      if (!freshActors.has(actorId)) {
        this._presenceManager.removeByActorId(actorId);
        this._actorToUserId.delete(actorId);
      }
    }
  }
}
