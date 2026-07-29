export const DEFAULT_APP_NAME = 'stream';
export const DEFAULT_MAX_COMMENT_CACHE = 500;
export const DEFAULT_REACTION_WINDOW = 3000; // ms window for reaction aggregation
export const TOPIC_COMMENTS = 'comments';
export const TOPIC_REACTIONS = '_reactions';
export const TOPIC_POLLS = 'polls';
export const LOBBY_ID = 'online';

/** Delay before the post-setup lobby presence refetch (catches simultaneous joiners) */
export const LOBBY_REFRESH_DELAY_MS = 2000;
