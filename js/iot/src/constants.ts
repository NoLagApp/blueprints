/** Default app name for NoLag IoT SDK */
export const DEFAULT_APP_NAME = 'iot';

/** Maximum telemetry readings to retain per device/sensor key */
export const DEFAULT_MAX_TELEMETRY_POINTS = 1000;

/** Default command acknowledgement timeout in milliseconds */
export const DEFAULT_COMMAND_TIMEOUT = 30000;

/** Topic name for telemetry readings */
export const TOPIC_TELEMETRY = 'telemetry';

/** Topic name for dispatched commands */
export const TOPIC_COMMANDS = 'commands';

/** Topic name for command acknowledgements */
export const TOPIC_CMD_ACK = '_cmd_ack';

/** Lobby ID for global online presence */
export const LOBBY_ID = 'online';
