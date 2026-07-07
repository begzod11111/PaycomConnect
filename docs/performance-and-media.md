# Performance & media transfer — why there are delays, and the plan

You reported delays in message sync (especially with media). This documents the
concrete causes found in the code, what was fixed now, and what to do next to
make forwarding fast and reliable.

## Root causes (found in code)

### 1. Telegram webhook waited for the whole delivery before replying — FIXED

The Slack webhook already ACKs immediately and forwards in the background. The
**Telegram webhook did the opposite**: it `await`ed the entire bridge pipeline
(normalize → CRM → routing → Jira → deliver to Slack, **including downloading and
re-uploading every attachment**) *before* returning `200` to Telegram.

Effect: Telegram sees a slow webhook, treats the update as not yet delivered, and
**retries it**. Retries add load and cause duplicate forwards (only partly
absorbed by the in-memory dedupe). This is the main source of perceived lag.

**Fix (done):** for normal messages the Telegram webhook now ACKs first and runs
the bridge in the background — mirroring the Slack path.
(`routes/telegram.js`, normal-message branch.)

### 2. Media is fully buffered in memory, then re-uploaded

Both directions download the whole file into an in-memory `arraybuffer` and then
upload it:

- **Telegram → Slack** (`slackService.uploadTelegramFileToSlack`): `getFile` →
  download bytes → `files.getUploadURLExternal` → PUT bytes → `files.completeUploadExternal`.
  That's ~4 sequential round-trips **per file**.
- **Slack → Telegram** (`telegramService.sendSlackFileToTelegram`): download
  Slack bytes → `sendPhoto/Document/...` to Telegram.

Large files ⇒ high memory and latency; there is no streaming. This is acceptable
short-term (now that it runs after ACK) but should move to **streaming** and a
**worker** (below).

### 3. Avatar lookup adds two Telegram API calls to the first message per user

For Telegram→Slack, `resolveTelegramAvatarUrl` calls `getUserProfilePhotos` +
`getFile` before posting text (cached 10 min per user). On a cache miss this adds
two round-trips to the critical path. Fine after ACK, but a candidate to move
off the hot path / warm proactively.

### 4. A crash bug in the media fallback path — FIXED

`telegramService.sendToTelegram` referenced an undefined variable `authorText`
in the "all attachments failed" fallback, throwing `ReferenceError` and marking
the message as failed. Fixed to use the composed caption. (`telegramService.js`.)

### 5. `setWebhook` omitted `callback_query`

`telegramService.setTelegramWebhook` did not subscribe to `callback_query`, so
inline-button callbacks could be missed. The new `scripts/setup-telegram.js`
sets `allowed_updates` including `callback_query`.

### 6. No queue / no outbound rate limiting

All forwarding happens inline in the request lifecycle with no retry budget and
no protection against Telegram/Slack rate limits (Telegram: ~1 msg/s per chat,
~30 msg/s global; bursts get `429`). Under load this causes both drops and
throttling-induced delays.

## What was fixed in this change set

| Fix | File | Impact |
| --- | --- | --- |
| Telegram webhook ACKs before forwarding | `routes/telegram.js` | Removes retry-driven lag/duplicates — the biggest win |
| `authorText` → `authorCaption` | `services/telegramService.js` | Removes a crash in the media fallback path |
| `setup-telegram.js` sets `callback_query` + commands/description | `scripts/setup-telegram.js` | Inline buttons delivered; proper bot menu |

These are low-risk and keep all tests green (12/12).

## Next steps (ordered by impact)

1. **Introduce the job queue** (`infra/queue`, in-process first). Webhooks only
   `verify → enqueue → 200`; a worker does normalize/route/deliver with retries
   and backoff. This makes latency independent of delivery time and is the seam
   for extracting the Balancer forwarder later.
2. **Add outbound rate limiting** (`infra/ratelimit`, token buckets): per-chat,
   per-workspace, and global, with `429`/`retry_after`-aware backoff. Required
   for the Balancer Telegram→Telegram feature and to avoid platform bans.
3. **Stream media** instead of buffering: pipe the download straight into the
   upload where the platform APIs allow it; cap max in-flight size; keep the
   bounded concurrency that already exists.
4. **Shared dedupe state** (Redis or Mongo) so retries/duplicates are handled
   correctly across restarts and multiple instances.
5. **Move avatar resolution off the hot path** (pre-warm or resolve lazily in the
   worker) and persist the resolved URL on the user record.
6. **Structured logging + metrics** (delivery latency, retries, `429` counts) so
   "is it fast enough?" becomes measurable instead of anecdotal.

## Note on the queue and horizontal scaling

Several pieces of state are currently in-memory (dedupe map, connect/onboarding
sessions, avatar cache). They are lost on restart and not shared between
instances, so you cannot safely run more than one process yet. Moving these to
Redis (which also backs the queue and rate limiter) unlocks running multiple
instances behind a load balancer — the real path to "faster and no delays" under
growth.
