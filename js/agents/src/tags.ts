/** Standard tag prefixes for agent coordination */
export const TAG_PREFIX = {
  CAPABILITY: "capability",
  PRIORITY: "priority",
  ROLE: "role",
  SEVERITY: "severity",
  URGENCY: "urgency",
  TENANT: "tenant",
} as const;

/** Boolean flags (used as standalone tags, no prefix) */
export const TAG_FLAGS = {
  REQUIRES_HUMAN: "requires_human",
  REQUIRES_AUDIT: "requires_audit",
} as const;

/** Helper to create prefixed tags */
export function tag(prefix: string, value: string): string {
  return `${prefix}:${value}`;
}
