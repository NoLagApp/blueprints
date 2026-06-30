/** Default app name for room topic prefixes */
export const DEFAULT_APP_NAME = 'chat';

/** Default typing indicator auto-stop timeout (ms) */
export const DEFAULT_TYPING_TIMEOUT = 3000;

/** Default max messages kept per room */
export const DEFAULT_MAX_MESSAGE_CACHE = 500;

/** Topic name for chat messages within a room */
export const TOPIC_MESSAGES = 'messages';

/** Topic name for typing indicators within a room */
export const TOPIC_TYPING = '_typing';

/** Topic name for live streamed message chunks within a room (ephemeral) */
export const TOPIC_STREAM = '_stream';

/** Default coalesce/flush interval for streamed token chunks (ms) */
export const DEFAULT_STREAM_FLUSH_MS = 60;

/** Lobby ID for global online presence */
export const LOBBY_ID = 'online';
