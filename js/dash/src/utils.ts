import type { FilterValue } from './types';

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

// ============ Filters ============

/**
 * Build the filter fragment of an emit options object.
 *
 * `filter` wins over `filters`: a publish is routed to exactly one topic, so
 * honouring both would silently drop one of them.
 */
export function filterEmitOptions(opts?: {
  filter?: string;
  filters?: string[];
}): { filter?: string; filters?: string[] } {
  if (opts?.filter) return { filter: opts.filter };
  if (opts?.filters && opts.filters.length > 0) return { filters: opts.filters };
  return {};
}

/**
 * Rebuild publish options from the filter a message arrived with, so a reply
 * to it reaches the same audience the original did.
 *
 * The server joins AND groups into one composite value with '|', which is not
 * a legal character in a plain filter, so split those back apart.
 */
export function inheritFilter(filter?: string): { filter?: string; filters?: string[] } {
  if (!filter) return {};
  if (filter.includes('|')) return { filters: filter.split('|') };
  return { filter };
}

/**
 * Merge OR terms into an existing filter set. AND groups (nested arrays) are
 * preserved as-is — only plain string terms are deduplicated.
 */
export function mergeFilters(existing: FilterValue[], add: string[]): FilterValue[] {
  const simple = new Set<string>();
  const groups: string[][] = [];
  for (const f of existing) {
    if (typeof f === 'string') simple.add(f);
    else groups.push(f);
  }
  for (const v of add) simple.add(v);
  return [...simple, ...groups];
}

/**
 * Drop OR terms from a filter set. AND groups are left untouched — remove
 * those by calling `setFilters` with the set you want.
 */
export function withoutFilters(existing: FilterValue[], remove: string[]): FilterValue[] {
  const drop = new Set(remove);
  return existing.filter((f) => typeof f !== 'string' || !drop.has(f));
}

/**
 * The composite key the server derives from an AND filter group: values are
 * lowercased, sorted, and joined with '|'. Mirrored here so an item created
 * locally carries the same filter string as one arriving off the wire.
 */
export function compositeFilterKey(values: string[]): string {
  return [...values].map((v) => v.toLowerCase()).sort().join('|');
}

/**
 * The single string form of whatever filter a publish used, for recording on
 * the local copy of an item. Round-trips through `inheritFilter`.
 */
export function recordedFilter(opts?: {
  filter?: string;
  filters?: string[];
}): string | undefined {
  if (opts?.filter) return opts.filter;
  if (opts?.filters && opts.filters.length > 0) return compositeFilterKey(opts.filters);
  return undefined;
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
