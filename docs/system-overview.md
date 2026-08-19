# PaycomConnect — System Overview

Short, current-state documentation of what the service does today, how a message
flows through it, and where the important logic lives. Use this as the map before
reading the architecture recommendation in
[`architecture-recommendation.md`](./architecture-recommendation.md).

> Status: MVP. Single Node.js/Express process. MongoDB with an in-memory
> fallback. All 5 tests in `tests/app.test.js` pass with
> `ENABLE_LIVE_FORWARDING=false`.

## What it is

PaycomConnect is a **bridge** between **Telegram** and **Slack**. A support
conversation happening in a Telegram group is mirrored into a dedicated Slack
channel (and back), so Payme integrators/managers can work from Slack while the
customer stays in Telegram. Around that core it also provides:

- **Connections (CRM link)** — a Telegram chat and a Slack channel are linked by
  a customer **INN** (tax id). A connection can also carry a Jira issue key.
- **Onboarding** — Slack-DM and Telegram-DM flows that register users
  (integrators, managers) and approve them.
- **Jira integration** — two roles: (1) validating a Jira task during
  `/connect`, and (2) keyword-triggered auto-creation of Jira issues.
- **Analytics + dashboard** — counters and a home page (`GET /`).

## High-level flow

```text
Telegram (webhook)                         Slack (Events API + slash cmds)
      |                                              |
      v                                              v
routes/telegram.js                            routes/slack.js
      |   (onboarding / connect / message)          |   (onboarding / connect / message)
      +----------------------+----------------------+
                             v
              services/bridgeService.js   <-- orchestration
        normalize -> dedupe -> /connect? -> CRM -> route -> Jira? -> deliver -> save
                             |
        +--------------------+---------------------+
        v                                          v
services/slackService.js                  services/telegramService.js
        v                                          v
   Slack Web API                             Telegram Bot API
```

`bridgeService.processInboundMessage(source, payload)` is the heart of the
system. For every inbound message it:

1. **Normalizes** the Telegram/Slack payload into one shape
   (`normalizeInboundMessage`).
2. **Deduplicates** using an in-memory `source:externalId` map (5-min TTL) plus a
   MongoDB unique index on `(source, externalId)`.
3. Detects **`/connect <INN> [JIRA-KEY]`** control commands and routes them to
   `connectionService` instead of forwarding.
4. Registers the contact in **CRM** (`crmService.registerInteraction`).
5. **Resolves the destination** channel/chat from the INN connection
   (`resolveDestinationForMessage`).
6. Optionally **creates a Jira issue** by keyword (`jiraService.maybeCreateJiraIssue`).
7. **Delivers** to the other platform (live or mock) and **saves** the message
   with delivery + Jira metadata.

## Directory map

| Path | Responsibility |
| --- | --- |
| `index.js` | Express app wiring (CORS, JSON, routers, error handler). |
| `bin/www` | HTTP entrypoint; also opens an ngrok tunnel on boot. |
| `config/env.js` | Env loading, normalization, and `integrationFlags`. |
| `routes/api.js` | `/api` root: mounts telegram/slack routers, mock endpoints, health, analytics, connection CRUD. |
| `routes/telegram.js` | Telegram HTTP adapter: webhook, bot/webhook admin, connect activation, mock. |
| `routes/slack.js` | Slack HTTP adapter: Events API, slash commands, interactivity, disconnect+archive. |
| `routes/index.js` | Dashboard page (`GET /`). |
| `routes/users.js` | Express scaffold stub — **not mounted (dead code)**. |
| `services/bridgeService.js` | Platform-neutral normalize/dedupe/route orchestration. |
| `services/connectionService.js` | INN-based Telegram↔Slack linking, `/connect`, `/disconnect`, private channel lifecycle, Jira task validation. |
| `services/slackService.js` | Outbound Telegram→Slack delivery (text, blocks, avatars, file upload). |
| `services/telegramService.js` | Outbound Slack→Telegram delivery + Telegram Bot API admin (webhook, keyboards, callbacks). |
| `services/onboardingService.js` | Slack-DM registration + `/approve`. |
| `services/TelegramOnboardingService.js` | Telegram-DM registration flow. |
| `services/telegramCallbackService.js` | Legacy inline-keyboard connect wizard (partly dead). |
| `services/jiraService.js` | Keyword-triggered Jira issue creation (used by bridge). |
| `services/integrationDistributionService.js` | Load-balances integrator assignment across connections. |
| `services/scriptService.js` | Canned `/script` templates pushed to Telegram. |
| `services/persistenceService.js` | MongoDB + in-memory store for connections, messages, contacts, Jira records, analytics. |
| `services/databaseService.js` | App-level Mongoose connect with graceful memory fallback. |
| `services/JiraApiService.js` | Full Jira REST wrapper — **unused at runtime**. |
| `services/SlackApiService.js` | Slack Web API wrapper (channels/users/messages). |
| `services/TelegramApiService.js` | Telegram Bot API wrapper — **unused at runtime**. |
| `models/*.js` | Mongoose schemas: `channelLink`, `message`, `contact`, `slackUser`, `jiraIssue`; `db.js` alternate bootstrap (unused). |

## Data model (MongoDB)

| Collection | Purpose | Key fields |
| --- | --- | --- |
| `ChannelLink` | The Telegram↔Slack connection keyed by INN. | `inn` (unique), `status` (`pending_telegram`/`pending_slack`/`linked`/`suspended`), `telegramChatId`, `slackChannelId`, `jiraIssueKey`, `jiraTaskKeys[]`, `integrators[]`, `managers[]`, `stats`. |
| `Message` | Audit log of every bridged message. | `source`, `externalId` (unique with source), `delivery`, `jira`, `metadata`. |
| `Contact` | Per-platform user CRM record. | `platform`, `userId`, `firstMessageAt`, `lastMessageAt`, `channels[]`. |
| `SlackUser` | User registry (Slack + Telegram ids, role, onboarding status). | `slackId`, `telegramId`, `role`, `status`, `connects[]`. |
| `JiraIssue` | Persisted record of auto-created/mock Jira issues. | `sourceMessageId`, `issueKey`, `status`, `mode`. |

## HTTP surface (today)

| Method + path | Purpose |
| --- | --- |
| `GET /` | Dashboard page (needs a `views/` template — see issues). |
| `GET /api/health` | Health + integration flags + analytics. |
| `GET /api/analytics/summary` | Aggregated counters. |
| `GET /api/messages/recent` | Recent messages. |
| `GET/PATCH/DELETE /api/connections[/:inn]` | Connection CRUD (Mongo only). |
| `POST /api/connections/:inn/jira` | Attach Jira issue to a connection. |
| `POST /api/mock/telegram`, `POST /api/mock/slack` | Simulate inbound messages (used by tests). |
| `POST /api/telegram/webhook` | Telegram webhook (optional secret-token check). |
| `POST /api/slack/webhook` | Slack Events API (no signature check). |
| `POST /api/slack/commands/*` | `/connect`, `/disconnect`, `/approve`, `/script`, `/skript`, `/sync`, `/pull`. |

## Configuration

Everything is env-driven through `config/env.js` (see `.env.example`). The most
important switches:

| Variable | Effect |
| --- | --- |
| `MONGODB_URI` | If empty → in-memory store (data lost on restart). |
| `ENABLE_LIVE_FORWARDING` | **Defaults to `true`.** When false, delivery is mocked. |
| `TELEGRAM_BOT_TOKEN` / `SLACK_BOT_TOKEN` | Required for live delivery on each side. |
| `JIRA_BASE_URL` / `JIRA_EMAIL` / `JIRA_API_TOKEN` / `JIRA_PROJECT_KEY` | Enable live Jira; otherwise Jira issues are mocked (`MOCK-...`). |
| `TELEGRAM_WEBHOOK_SECRET` | Optional Telegram webhook validation. |
| `SLACK_CHANNEL_ID` / `TELEGRAM_CHAT_ID` | Fallback destinations when no INN link exists. |

## Mock vs live delivery

| Layer | Live when | Otherwise |
| --- | --- | --- |
| Message delivery | `ENABLE_LIVE_FORWARDING=true` **and** token **and** target set | `{ status: 'mocked' }` |
| Routing gate | connection `status === 'linked'` | `pending_link` / `unlinked` (no API call) |
| Jira auto-create | all Jira env vars set | `MOCK-{timestamp}` record |

## Known issues / technical debt

Confirmed while reviewing the code. These inform the architecture proposal.

1. **No rate limiting** anywhere — neither inbound HTTP nor outbound Telegram/Slack
   API calls. This is a hard requirement for the upcoming Balancer (Telegram→Telegram)
   work and to stay within Telegram/Slack API limits.
2. **Slack requests are not verified** — no signing-secret check on the Events
   webhook or slash commands; they can be forged if the URL is known. Telegram
   webhook validation is optional.
3. **Admin/mock/connection APIs are unauthenticated.**
4. **Credentials in plaintext** — onboarding stores a password in
   `SlackUser.metadata` and sends codes/passwords through Slack/Telegram messages.
5. **Contact schema mismatch** — `persistenceService.upsertContact` writes fields
   (`firstInteractionAt`, `lastInteractionAt`, `channelId`) that do not match
   `models/contact.js` (`firstMessageAt`, `lastMessageAt`, `channels`). CRM/analytics
   contact counts are unreliable under MongoDB.
6. **Dead / duplicated layers** — `TelegramApiService`, `JiraApiService`, and
   `routes/users.js` are unused; Telegram/Slack/Jira calls are implemented two or
   three times across functional services and class wrappers. Onboarding exists in
   two parallel implementations (Slack-DM and Telegram-DM).
7. **In-memory state everywhere** — dedupe map, connect sessions, onboarding
   sessions, avatar cache are all lost on restart and are not shared across
   instances (blocks horizontal scaling).
8. **`GET /` likely fails** — `routes/index.js` renders a Pug `index` view but
   there is no `views/` directory (and `public/` is git-ignored).
9. **Two MongoDB bootstraps** — `services/databaseService.js` (used, graceful) and
   `models/db.js` (`connectDB`, exits process on failure, unused).
10. **ngrok tunnel opens on every boot** in `bin/www`, including production.
