# Target directory & file architecture (for review)

This is the proposed file/folder layout to grow into, plus an exact **mapping
from today's files**. It is meant to be analyzed and adjusted together — nothing
here forces a big-bang refactor. We can migrate folder by folder while the app
keeps running.

See [`architecture-recommendation.md`](./architecture-recommendation.md) for the
"why" (modular monolith, extractable later) and
[`system-overview.md`](./system-overview.md) for the current state.

## Target tree

```text
src/
  api/                         # HTTP layer only: parse, verify, ACK, delegate
    http-app.js                #   express app wiring (from index.js)
    middleware/
      serviceAuth.js           #   [DONE] Balancer service-to-service auth
      rateLimit.js             #   inbound HTTP rate limiting (new)
      slackSignature.js        #   verify Slack signing secret (new)
      telegramSecret.js        #   verify Telegram secret token (from telegramService)
      errorHandler.js
    webhooks/
      telegram.webhook.js      #   thin: verify -> enqueue -> 200  (from routes/telegram.js)
      slack.webhook.js         #   thin: verify -> enqueue -> 200  (from routes/slack.js)
    admin/
      connections.routes.js    #   from routes/api.js (connections CRUD)
      analytics.routes.js      #   from routes/api.js (analytics, messages)
      health.routes.js
  adapters/                    # one client per external system (kill duplicates)
    telegram/
      telegram.client.js       #   merge telegramService.js + TelegramApiService.js
      telegram.format.js       #   HTML render, mentions, media-type mapping
    slack/
      slack.client.js          #   merge slackService.js + SlackApiService.js
      slack.format.js          #   blocks, avatar, customize fields
    jira/
      jira.client.js           #   merge jiraService.js + JiraApiService.js
  domain/                      # business logic, platform-neutral
    bridge/
      bridge.service.js        #   from bridgeService.js (orchestration)
      normalize.js             #   normalizeTelegram/Slack payloads
      dedupe.js                #   dedupe (backed by store, not in-memory Map)
    connections/
      connection.service.js    #   from connectionService.js
      routing.js               #   resolveDestinationForMessage
      distribution.js          #   from integrationDistributionService.js
    forwarding/                # delivery use-cases (the "what to send where")
      telegram-to-slack.js
      slack-to-telegram.js
      telegram-to-telegram.js  #   Balancer forwarder (new, rate-limited)
      media.js                 #   shared download/upload/stream helpers
    onboarding/
      onboarding.service.js    #   merge onboardingService + TelegramOnboardingService
    automation/
      automation.service.js    #   Jira automation rules (new)
    scripts/
      script.service.js        #   from scriptService.js
  infra/
    queue/
      queue.js                 #   job queue abstraction (in-proc now, Redis later)
    ratelimit/
      tokenBucket.js           #   per-chat / per-workspace / global limiters (new)
    persistence/
      db.js                    #   single Mongo bootstrap (merge databaseService + models/db.js)
      models/                  #   channelLink, message, contact, slackUser, jiraIssue
      repositories/            #   thin data-access wrappers (from persistenceService.js)
    config/
      env.js                   #   from config/env.js
    observability/
      logger.js                #   structured logging + requestId (replace raw console.log)
  worker/
    index.js                   #   queue consumers; same process now, own process when extracted
scripts/                       # ops tooling
  setup-telegram.js            #   [DONE] bot commands/description/webhook
  gen-service-key.js           #   [DONE] service key generator
tests/
docs/
```

## Mapping from current files

| Current | Target | Action |
| --- | --- | --- |
| `index.js` | `src/api/http-app.js` | move |
| `bin/www` | `bin/www` | keep (gate ngrok behind a dev flag) |
| `config/env.js` | `src/infra/config/env.js` | move |
| `routes/api.js` | `src/api/admin/*.routes.js` + webhook mounts | split |
| `routes/telegram.js` | `src/api/webhooks/telegram.webhook.js` + `domain/*` | split (thin webhook + move logic) |
| `routes/slack.js` | `src/api/webhooks/slack.webhook.js` + `domain/*` | split |
| `routes/index.js` | `src/api/admin/health.routes.js` or removed | replace (see broken `GET /`) |
| `routes/users.js` | — | **delete (dead)** |
| `services/bridgeService.js` | `src/domain/bridge/*` | move + split |
| `services/connectionService.js` | `src/domain/connections/*` | move |
| `services/integrationDistributionService.js` | `src/domain/connections/distribution.js` | move |
| `services/slackService.js` + `services/SlackApiService.js` | `src/adapters/slack/*` | **merge** |
| `services/telegramService.js` + `services/TelegramApiService.js` | `src/adapters/telegram/*` | **merge** |
| `services/jiraService.js` + `services/JiraApiService.js` | `src/adapters/jira/jira.client.js` + `domain/automation` | **merge** |
| `services/onboardingService.js` + `services/TelegramOnboardingService.js` | `src/domain/onboarding/onboarding.service.js` | **merge** |
| `services/telegramCallbackService.js` | `src/domain/connections/*` (keep used parts) | prune dead code |
| `services/scriptService.js` | `src/domain/scripts/script.service.js` | move |
| `services/persistenceService.js` | `src/infra/persistence/repositories/*` | split into repositories |
| `services/databaseService.js` + `models/db.js` | `src/infra/persistence/db.js` | **merge** (one bootstrap) |
| `services/crmService.js` | fold into `domain/bridge` + contact repository | inline |
| `models/*.js` | `src/infra/persistence/models/*` | move (fix `contact` schema) |
| `middleware/serviceAuth.js` | `src/api/middleware/serviceAuth.js` | move (already created) |
| `scripts/*` | `scripts/*` | keep |

## Migration order (safe, incremental)

1. **Delete dead code**: `routes/users.js`, `models/db.js` (after folding its
   bootstrap), unused `TelegramApiService`/`JiraApiService` once merged.
2. **Merge duplicate adapters** (Telegram/Slack/Jira) → one client each. Biggest
   maintenance win, no behavior change.
3. **Introduce `infra/queue` + `infra/ratelimit`**, make webhooks thin
   (verify → enqueue → ACK). This is the structural seam everything else needs.
4. **Split `persistenceService` into repositories** and fix the `contact` schema
   mismatch.
5. **Move to `src/`** folder by folder; update imports; keep tests green at each
   step.
6. Add **`domain/forwarding/telegram-to-telegram.js`** (Balancer) and
   **`domain/automation`** (Jira) on top of the queue.

## Open questions to decide together

- Keep everything under one repo/service (recommended for now) or spin the
  Balancer forwarder into its own repo when extracted?
- Queue backend when we outgrow in-process: **Redis + BullMQ** vs a lightweight
  DB-backed queue? (Redis also solves shared dedupe/session/rate-limit state.)
- Server-rendered admin vs. rendering PaycomConnect data inside the `tamada` UX
  (the latter is the current direction — see architecture doc).
