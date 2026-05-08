/**
 * Generate a unique ID.
 * Uses crypto.randomUUID when available, falls back to a simple random string.
 */
export function generateId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Fallback for environments without crypto.randomUUID
  return 'xxxx-xxxx-xxxx-xxxx'.replace(/x/g, () =>
    Math.floor(Math.random() * 16).toString(16),
  );
}

/**
 * Create a debug logger that only logs when enabled.
 */
export function createLogger(prefix: string, enabled: boolean) {
  if (!enabled) {
    return (..._args: unknown[]) => {};
  }
  return (...args: unknown[]) => {
    console.log(`[${prefix}]`, ...args);
  };
}
