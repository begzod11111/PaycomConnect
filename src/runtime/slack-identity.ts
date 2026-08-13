import { env } from '../core/env';
import { isMongoConnected } from './database';
import { SlackUser } from './models';
import { SlackApiService } from './slack-api';

// Resolve the human-readable name of a Slack sender for messages bridged into
// Telegram. Historically the bridge either (a) called `users.info` on every
// inbound message (correct but slow — a synchronous Slack round-trip per
// message) or (b) fell back to the raw Slack user id (`user-U0123...`), which
// is what surfaced in Telegram when the id was all we had.
//
// This resolver combines the fast paths so a real name is shown without paying
// the API cost on the hot path:
//   1. The name Slack already put in the event callback (`user_profile`), when
//      present — zero latency, this is the preferred source.
//   2. The registered-user directory in Mongo (SlackUser.displayName/email).
//   3. A cached `users.info` lookup — only hit once per unknown user, then
//      memoized — so unregistered Slack users still get a proper name.
// Results (including "not found") are cached so repeated messages from the same
// person never re-query Slack or the database.

const NAME_CACHE_TTL_MS = 60 * 60 * 1000; // 1h for resolved names
const NEGATIVE_CACHE_TTL_MS = 5 * 60 * 1000; // 5m before we retry an unknown user

interface CacheEntry {
  name: string;
  ts: number;
}

const nameCache = new Map<string, CacheEntry>();

function cacheGet(slackUserId: string): string | undefined {
  const entry = nameCache.get(slackUserId);
  if (!entry) return undefined;
  const ttl = entry.name ? NAME_CACHE_TTL_MS : NEGATIVE_CACHE_TTL_MS;
  if (Date.now() - entry.ts > ttl) {
    nameCache.delete(slackUserId);
    return undefined;
  }
  return entry.name;
}

function cacheSet(slackUserId: string, name: string): void {
  if (!slackUserId) return;
  nameCache.set(slackUserId, { name, ts: Date.now() });
}

// Pick the best display name out of a Slack profile object, ignoring blanks.
function pickProfileName(profile: any): string {
  if (!profile) return '';
  const candidates = [profile.real_name, profile.display_name, profile.name];
  for (const candidate of candidates) {
    const value = String(candidate ?? '').trim();
    if (value) return value;
  }
  return '';
}

// Best name we can get straight from the Slack event payload, no I/O involved.
// Slack includes `user_profile` on many (but not all) message events, so this is
// the preferred, zero-latency source when available.
export function extractSlackNameFromEvent(event: any): string {
  if (!event) return '';
  const fromProfile = pickProfileName(event.user_profile);
  if (fromProfile) return fromProfile;
  const username = String(event.username ?? '').trim();
  return username;
}

// Resolve the display name for a Slack user id, trying the fast/cached sources
// first and only falling back to the (slower) Slack Web API for users we have
// never seen. Returns '' when nothing could be resolved.
export async function resolveSlackDisplayName(
  slackUserId: unknown,
  event?: any,
): Promise<string> {
  // 1. Straight from the callback payload — no lookup needed.
  const fromEvent = extractSlackNameFromEvent(event);
  const id = String(slackUserId ?? '').trim();
  if (fromEvent) {
    cacheSet(id, fromEvent);
    return fromEvent;
  }

  if (!id) return '';

  // 2. Memoized result (covers previous callback/DB/API resolutions).
  const cached = cacheGet(id);
  if (cached !== undefined) return cached;

  // 3. Registered-user directory (employees onboarded into the bridge).
  if (isMongoConnected()) {
    try {
      const user: any = await SlackUser.findOne({ slackId: id }).select('displayName email').lean();
      const dbName = String(user?.displayName || user?.email || '').trim();
      if (dbName) {
        cacheSet(id, dbName);
        return dbName;
      }
    } catch {
      // Ignore lookup failures and fall through to the API.
    }
  }

  // 4. Slack Web API — the definitive source for users we do not have locally
  //    (e.g. clients who never registered). Cached so it only runs once.
  if (env.slackBotToken) {
    try {
      const info: any = await SlackApiService.getUserInfo(id);
      const apiName = pickProfileName(info?.profile) || String(info?.real_name || info?.name || '').trim();
      if (apiName) {
        cacheSet(id, apiName);
        return apiName;
      }
    } catch {
      // Ignore — negative-cache below so we do not hammer the API.
    }
  }

  cacheSet(id, '');
  return '';
}

// Test/maintenance helper: drop the in-memory cache.
export function clearSlackNameCache(): void {
  nameCache.clear();
}
