export function generateId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'xxxx-xxxx-xxxx-xxxx'.replace(/x/g, () =>
    Math.floor(Math.random() * 16).toString(16),
  );
}

export function createLogger(prefix: string, enabled: boolean) {
  if (!enabled) {
    return (..._args: unknown[]) => {};
  }
  return (...args: unknown[]) => {
    console.log(`[${prefix}]`, ...args);
  };
}
