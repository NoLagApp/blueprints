/** Default app name for NoLag queue SDK */
export const DEFAULT_APP_NAME = 'queue';

/** Default maximum number of jobs to cache in memory */
export const DEFAULT_MAX_JOB_CACHE = 1000;

/** Default maximum number of attempts before a job is permanently failed */
export const DEFAULT_MAX_ATTEMPTS = 3;

/** Topic name for job lifecycle messages within a queue room */
export const TOPIC_JOBS = 'jobs';

/** Topic name for job progress updates within a queue room */
export const TOPIC_PROGRESS = '_progress';

/** Lobby ID for global online presence */
export const LOBBY_ID = 'online';
