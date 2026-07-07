# Media transfer & permissions

Two things you flagged as key for the rewrite: **beautiful, reliable media
transfer** between Telegram and Slack, and **role-based permissions** (e.g. some
roles may send files/audio, some may not). This documents the design and how it
is reflected in the new NestJS entities.

Related: [`domain-model.md`](./domain-model.md),
[`performance-and-media.md`](./performance-and-media.md) (latency),
[`onboarding-redesign.md`](./onboarding-redesign.md).

## Message metadata (what we store)

Every bridged message is persisted with full metadata (NestJS
`domain/messaging/message.schema.ts`):

- **Who**: `author { userId?, platform, externalId, displayName, username }`.
- **Which side / direction**: `source`, `destination`, `direction`
  (`telegram_to_slack` | `slack_to_telegram`), `sourceChat`, `connection`.
- **When**: `receivedAt`, `sentAt`, `deliveredAt` (a full timeline), plus
  `delivery.latencyMs`.
- **Size & format**: `textLength`, `totalSizeBytes`, and per-attachment
  `kind` (photo/video/audio/voice/video_note/document), `mimeType`, `format`
  (e.g. `jpg`, `mp4`, `ogg`), `sizeBytes`, `width`/`height`, `durationSec`, and
  provider file ids.
- **Outcome**: `delivery { status, mode, providerMessageId, error, attempts,
  latencyMs }`.

This gives us the raw material for analytics (volume by format/size, latency,
per-user activity) and for the blocking/limiting rules below.

## Permissions model

Roles and fine-grained permissions live in
`server/src/common/permissions/`:

- `Role`: `owner`, `admin`, `teamlead`, `manager`, `cx_manager`, `integrator`,
  `client`.
- `Permission`: `message:send`, `file:send`, `audio:send`, `connection:create`,
  `connection:remove`, `connection:manage`, `user:approve`, `analytics:view`.
- `ROLE_PERMISSIONS` — the single matrix that answers "who can send files/audio".
  Defaults: integrators/managers/cx-managers may send files and audio; **clients
  (end users) are text-only by default**; owners/admins have everything.

Enforcement:

- `PermissionsService.can(role, permission)` — the check.
- `@RequirePermissions(...)` + the global `PermissionsGuard` — declarative
  protection on HTTP handlers.
- For the **message pipeline**, the same `PermissionsService.can(role,
  FILE_SEND | AUDIO_SEND)` gates whether an inbound attachment is forwarded. If
  denied, the attachment is dropped and the sender gets a short notice (instead
  of silently failing).

### Two layers: role + per-chat override

- **Role layer** (global default): the matrix above.
- **Per-chat layer** (`ChatSettings` on the `Chat` entity): `allowFiles`,
  `allowAudio`, `muted`, `rateLimitPerMinute`. A chat can be stricter than the
  role default (e.g. mute a noisy group, or disable files in a specific
  connection). Effective permission = role allows **AND** chat allows.

## Media transfer pipeline (target)

Rebuilt in `domain/messaging` + `domain/forwarding` on top of the queue, so it
runs off the webhook hot path (see `performance-and-media.md`).

```text
inbound file event
  -> permission check (role + chat settings)         # drop early if not allowed
  -> classify media (photo|video|audio|voice|video_note|document) + format/mime/size
  -> enqueue forward job (per-connection)
  -> worker: stream download from source -> stream upload to destination
  -> map to the destination's native media type (no "sent as document" for images)
  -> attach author caption (name/avatar) so it looks native
  -> persist Message with attachment metadata + delivery/latency
  -> on 429: honor retry_after and back off (rate limiter)
```

### Making it look good on both sides

Concrete rules so media renders natively, not as generic file dumps:

| Media | Telegram → Slack | Slack → Telegram |
| --- | --- | --- |
| Photo | upload as image so Slack shows a preview | `sendPhoto` (not `sendDocument`) |
| Video | uploaded video with preview | `sendVideo` |
| Voice | show as audio clip | `sendVoice` (keeps the round waveform UX) |
| Audio file | audio with title/duration | `sendAudio` with title/performer |
| Video note | render as file + note | `sendVideoNote` (round video) |
| Multiple images | grouped | `sendMediaGroup` (album), fallback to one-by-one |
| Document | file with name/size | `sendDocument` with original filename |

Author identity is preserved: Telegram sender name + avatar shown on the Slack
message (via `chat.postMessage` customize), and `<b>[Name]</b>` prefix on the
Telegram side, so both feel like a real forwarded conversation.

### Reliability & limits (ties into blocking/analysis)

- **Streaming** instead of full in-memory buffering (lower latency, safe for big
  files); enforce a **max file size** per chat/plan.
- **Bounded concurrency** per connection (already present) + **outbound rate
  limiting** (per chat / global) with `429` backoff.
- **Blocking/analysis hooks**: because every attachment's `mimeType`, `format`,
  and `sizeBytes` are recorded, we can add rules later (block executables,
  quarantine oversized files, flag suspicious content) as a pipeline step
  without touching transport.

## Status

- Entities and the permissions model are scaffolded now (R1). The streaming
  media pipeline and rate limiter land in the messaging/forwarding phase (R3),
  reusing the fixes already made to the Express bridge in the meantime.
