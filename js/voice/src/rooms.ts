/**
 * Creating the room a call will live in.
 *
 * Two platform rules shape everything here, and both present as silence rather
 * than an error, which is why they are worth stating plainly:
 *
 *   A room has to exist before anyone touches it. The broker never creates one
 *   implicitly; publishing to an unknown room is rejected. So a call's room is
 *   created through the control plane before the call connects.
 *
 *   A connection only sees rooms that existed when it authenticated. A
 *   long-lived connection cannot reach a room made later, so each call needs
 *   its own connection, opened after `ensureRoom` resolves. That is not as
 *   wasteful as it sounds: telephony already gives one socket per call.
 */

import { VOICE_TOPICS } from "./types.js";

const DEFAULT_API_URL = "https://api.nolag.app/v1";

export interface RoomProvisionerOptions {
  /** Project API key (`nlg_live_...`). */
  apiKey: string;
  /** Override for non-production control planes. */
  apiUrl?: string;
  /** The real app slug, including the suffix NoLag appends. */
  appSlug: string;
}

export interface RoomProvisioner {
  readonly appId: string;
  /** Idempotent. Safe to call for a room that already exists. */
  ensureRoom(slug: string): Promise<void>;
}

interface AppRecord {
  appId: string;
  slug: string;
  topics?: string[];
  config?: { autoProvisionRooms?: boolean } | null;
}

async function request(
  { apiKey, apiUrl = DEFAULT_API_URL }: RoomProvisionerOptions,
  method: string,
  path: string,
  body?: unknown
): Promise<unknown> {
  const response = await fetch(`${apiUrl}${path}`, {
    method,
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`NoLag API ${method} ${path}: HTTP ${response.status} ${text.slice(0, 200)}`);
  }
  return text ? JSON.parse(text) : null;
}

export async function createRoomProvisioner(
  options: RoomProvisionerOptions
): Promise<RoomProvisioner> {
  const apps = (await request(options, "GET", "/apps")) as { data?: AppRecord[] } | null;
  const app = (apps?.data ?? []).find((candidate) => candidate.slug === options.appSlug);
  if (!app) {
    const known = (apps?.data ?? []).map((candidate) => candidate.slug).join(", ") || "none";
    throw new Error(`no app with slug "${options.appSlug}" (project has: ${known})`);
  }
  if (!app.config?.autoProvisionRooms) {
    throw new Error(
      `app "${options.appSlug}" has config.autoProvisionRooms disabled, so per-call ` +
        `rooms cannot be created. PATCH it with {"config":{"autoProvisionRooms":true}}.`
    );
  }
  const missing = VOICE_TOPICS.filter((topic) => !(app.topics ?? []).includes(topic));
  if (missing.length) {
    throw new Error(
      `app "${options.appSlug}" is missing topics: ${missing.join(", ")}. ` +
        `Create it from the Agents blueprint so its schema matches.`
    );
  }

  return {
    appId: app.appId,
    async ensureRoom(slug: string): Promise<void> {
      await request(options, "POST", `/apps/${app.appId}/rooms/ensure`, {
        name: slug,
        slug,
        topics: VOICE_TOPICS,
      });
    },
  };
}

/** Room slug for a call. Lower-cased because slugs are stored verbatim. */
export function callRoomSlug(callId: string): string {
  return callId.toLowerCase();
}

/** Agent id for a call, so supervisors can address it without being told. */
export function callAgentId(callId: string): string {
  return `call-${callRoomSlug(callId)}`;
}
