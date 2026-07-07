# Framework decision: NestJS vs structured Express

You asked whether to do the big, entity-based rewrite on **NestJS** or on a
**structured Express** setup. This is the recommendation, the reasoning, the
target NestJS structure, and a migration plan that keeps the current bridge
running.

> **Status (confirmed):** NestJS + TypeScript + MongoDB, in-repo. Phase **R0**
> (compiling Nest app: config, health, `ServiceAuthGuard`, permissions, Mongoose)
> and **R1** (entity schemas) are scaffolded under `server/` and build cleanly
> (`cd server && npm run build`). It runs on a separate port (`NEST_PORT`, default
> 9020) so the Express bridge keeps serving webhooks during the migration. At
> phase **R6** the Nest app moves to the repo root and Express is retired.

## Recommendation: NestJS + TypeScript

**Go with NestJS.** For where PaycomConnect is heading — an entity/domain model,
an admin data API for the Balancer UI, a Jira automation platform, a rate-limited
Balancer forwarder, and eventual service extraction — NestJS pays for its
overhead. Structured Express can work, but you would end up re-implementing most
of what NestJS gives you for free, by hand and inconsistently (which is how the
current `services/` sprawl happened).

### Why NestJS fits our goals

| Our goal (from the discussions) | What NestJS gives us |
| --- | --- |
| "Everything is an entity" (User, Chat, Connection…) | **Modules + providers + TypeScript classes** — one module per domain entity, DI between them. |
| A clear, enforced structure | Opinionated module/controller/provider layout — no more "everything in `services/`". |
| Service-to-service auth (done) | **Guards** (`@UseGuards`) — the base64 `name:secret` check becomes a reusable `ServiceAuthGuard`. |
| Rate limiting (inbound + outbound) | `@nestjs/throttler` for inbound; custom providers/interceptors for outbound token buckets. |
| Validated webhooks & API payloads | **Pipes + `class-validator` DTOs** — reject malformed Telegram/Slack/API payloads declaratively. |
| Jira automation (rules, SLA timers) | `@nestjs/schedule` (cron/timeouts) + event emitter for trigger→action rules. |
| Queue / async forwarding | `@nestjs/bullmq` (Redis) — the seam for the Balancer forwarder and Jira worker. |
| Extract services later | **Built-in microservice transports** — a module can become a standalone service with minimal change. |
| MongoDB now, options later | `@nestjs/mongoose` (keep Mongo) or `@nestjs/typeorm` (if we move org/user/roles to Postgres). |
| Testability | First-class `@nestjs/testing` with DI mocking — unit-test domain logic without HTTP. |

### Honest trade-offs

- **Learning curve & boilerplate.** More files/ceremony per feature (module,
  service, controller, DTO). Worth it at this size and trajectory; overkill for a
  throwaway script.
- **Migration cost.** The current code is ESM JS on Express; moving to NestJS
  means TypeScript + decorators + DI. We mitigate this with the strangler plan
  below (no big-bang rewrite, bridge keeps running).
- **TypeScript required in practice.** This is a feature (typed entities), but it
  is a real shift from the current JS.

### When structured Express would have been enough

If the scope were "just forward messages, few endpoints, one dev, no automation
platform," a structured Express (routers + a `src/` layout like
[`target-structure.md`](./target-structure.md) + `zod`/`joi` validation +
manual DI) would be lighter. Given the roadmap (automation, roles, admin API,
Balancer, extraction), that saving disappears quickly.

### Database note

Keep **MongoDB/Mongoose** through the rewrite to avoid changing two things at
once. But the core of the new model is relational (Organization ↔ Users ↔ Chats
↔ Connection ↔ JiraTask), so **flag Postgres + TypeORM as a later option** if
reporting/joins get heavy. NestJS makes that swap module-local.

## Target NestJS structure

One module per domain entity/concern. Webhooks are thin controllers that
validate → enqueue; workers run the heavy logic.

```text
src/
  main.ts                         # bootstrap
  app.module.ts                   # wires all modules
  config/
    config.module.ts              # @nestjs/config, typed env schema (zod/joi)
  common/
    guards/service-auth.guard.ts  # port of middleware/serviceAuth.js
    interceptors/                 # logging, request-id
    filters/                      # exception -> JSON
    pipes/                        # validation
    ratelimit/                    # outbound token-bucket provider
  platforms/                      # external systems (one client each)
    telegram/
      telegram.module.ts
      telegram.controller.ts      # POST /api/telegram/webhook (thin: verify + enqueue)
      telegram.client.ts          # Bot API client (merge telegramService + TelegramApiService)
      dto/
    slack/
      slack.module.ts
      slack.controller.ts         # events + slash commands (verify signature)
      slack.client.ts             # Web API client (merge slackService + SlackApiService)
      dto/
    jira/
      jira.module.ts
      jira.client.ts              # REST client (merge jiraService + JiraApiService)
  domain/
    organizations/                # INN anchor
    users/                        # people + platform identities + roles
    chats/                        # a conversation surface (TG group / Slack channel)
    memberships/                  # user <-> chat with role ("add people to each other")
    connections/                  # connect lifecycle: link TG chat <-> Slack channel by org + jira task
    messaging/                    # bridge: normalize, dedupe, forward (uses queue)
    onboarding/                   # persisted state machine (merge Slack + Telegram flows)
    automation/                   # Jira rules (trigger -> action)
  infra/
    persistence/                  # @nestjs/mongoose schemas + repositories
    queue/                        # @nestjs/bullmq (Redis) + processors (worker)
  api/
    admin/                        # controllers for tamada/Balancer, @UseGuards(ServiceAuthGuard)
test/
```

Each `domain/<entity>/` module typically contains: `<entity>.schema.ts`
(persistence), `<entity>.repository.ts`, `<entity>.service.ts` (business logic),
`<entity>.controller.ts` (only if it exposes HTTP), and `dto/`.

## Migration strategy: strangler, not big-bang

Rewriting 7k lines in one shot is risky and stops delivery. Instead, stand up the
NestJS app next to the current Express app and move capabilities across module by
module. The Telegram/Slack webhooks are cut over **last**, so bridging never
breaks.

| Phase | Scope | Cutover risk |
| --- | --- | --- |
| **R0 Scaffold** | Nest app boots: config, health, `ServiceAuthGuard`, Mongoose connection. Runs on a different port; Express still serves webhooks. | none |
| **R1 Entities** | Define schemas/repositories: Organization, User, Chat, Membership, Connection, JiraTask, Message, OnboardingSession. Backfill/migrate from `ChannelLink`/`SlackUser`. | low (read model first) |
| **R2 Admin API** | Port the data/admin endpoints (connections, analytics, messages) into `api/admin` behind `ServiceAuthGuard`. Point tamada/Balancer at the Nest API. | low |
| **R3 Messaging** | Port bridge (normalize/dedupe/forward) into `messaging` on top of BullMQ. Run in parallel (shadow) before cutover. | medium |
| **R4 Connections** | Port connect/disconnect lifecycle using entities. | medium |
| **R5 Onboarding** | Rebuild onboarding as a persisted state machine (see [`onboarding-redesign.md`](./onboarding-redesign.md)); merge Slack + Telegram flows. | medium |
| **R6 Webhooks cutover** | Move Telegram/Slack webhooks to Nest controllers; retire Express `routes/` and `services/`. | controlled (last) |

Data stays in the same MongoDB throughout, so both apps can read/write during
migration.

## What I need from you to start R0

1. **Confirm NestJS** (my recommendation) vs structured Express.
2. **Keep MongoDB** for now? (recommended) — or start on Postgres.
3. **TypeScript** across the new app? (recommended, and standard for NestJS).
4. Should the Nest app live in this repo under `src/` (Express retired at R6), or
   a fresh repo? (In-repo strangler is simplest.)

On your confirmation I scaffold **R0** (a compiling Nest app: config, health,
`ServiceAuthGuard`, Mongoose) and the **R1 entity schemas** as the foundation,
leaving the Express bridge running.
