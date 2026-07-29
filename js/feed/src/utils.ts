export function generateId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'xxxx-xxxx-xxxx-xxxx'.replace(/x/g, () => Math.floor(Math.random() * 16).toString(16));
}

export function createLogger(prefix: string, enabled: boolean) {
  if (!enabled) { return (..._args: unknown[]) => {}; }
  return (...args: unknown[]) => { console.log(`[${prefix}]`, ...args); };
}

// ============ Wrapper registry ============
// One wrapper instance per (client, appName): two wrappers sharing an app on
// one connection would collide on topics, presence and the online lobby.
// Warn (not throw): HMR and tests legitimately construct before disposing.

const wrapperRegistry = new WeakMap<object, Map<string, string>>();

/** Register a wrapper against a client + appName; warns on collision. */
export function registerWrapper(client: object, appName: string, wrapperName: string): void {
  let apps = wrapperRegistry.get(client);
  if (!apps) {
    apps = new Map();
    wrapperRegistry.set(client, apps);
  }
  const existing = apps.get(appName);
  if (existing) {
    console.warn(
      `[${wrapperName}] Another wrapper (${existing}) is already attached to this client for app "${appName}". ` +
      `Use one wrapper per (client, app) — detach the other instance first.`,
    );
  }
  apps.set(appName, wrapperName);
}

/** Release a wrapper's (client, appName) registration on detach. */
export function releaseWrapper(client: object, appName: string): void {
  wrapperRegistry.get(client)?.delete(appName);
}
