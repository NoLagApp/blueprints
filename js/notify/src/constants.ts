/** Default app name for channel topic prefixes */
export const DEFAULT_APP_NAME = 'notify';

/** Default max notifications kept per channel */
export const DEFAULT_MAX_NOTIFICATION_CACHE = 500;

/** Topic name for notifications within a channel */
export const TOPIC_NOTIFICATIONS = 'notifications';

/** Topic name for read receipts within a channel */
export const TOPIC_READ = '_read';

/** Lobby ID for global online presence */
export const LOBBY_ID = 'online';

/** Delay before the post-setup lobby presence refetch (catches simultaneous joiners) */
export const LOBBY_REFRESH_DELAY_MS = 2000;
