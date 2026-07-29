export const DEFAULT_APP_NAME = 'dash';
export const DEFAULT_MAX_METRIC_POINTS = 1000;
export const DEFAULT_AGGREGATION_WINDOW = 60000; // 1 minute
export const TOPIC_METRICS = 'metrics';
export const TOPIC_WIDGETS = 'widgets';
export const LOBBY_ID = 'online';

/** Delay before the post-setup lobby presence refetch (catches simultaneous joiners) */
export const LOBBY_REFRESH_DELAY_MS = 2000;
