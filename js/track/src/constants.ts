/** Default app name for NoLag track SDK */
export const DEFAULT_APP_NAME = 'track';

/** Maximum number of location updates retained per asset (default) */
export const DEFAULT_MAX_LOCATION_HISTORY = 500;

/** Topic name for location updates within a zone */
export const TOPIC_LOCATIONS = 'locations';

/** Topic name for server-side geofence events within a zone */
export const TOPIC_GEOFENCE = '_geofence';

/** Lobby ID for global online presence */
export const LOBBY_ID = 'online';

/** Delay before the post-setup lobby presence refetch (catches simultaneous joiners) */
export const LOBBY_REFRESH_DELAY_MS = 2000;
