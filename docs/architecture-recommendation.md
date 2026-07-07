# PaycomConnect — Architecture Recommendation

This document answers the first, blocking question: **what architecture do we
build on?** It compares a monolith against microservices for PaycomConnect,
gives a concrete recommendation, and shows exactly where the upcoming
requirements fit:

- automatic actions driven by **Jira** (a small automation platform);
- integration with the **Balancer** project, whose core job is **Telegram →
  Telegram** data transfer **with rate limiters**;
- an **admin web** panel to view data;
- room to grow, without paying for that growth up front.

Read [`system-overview.md`](./system-overview.md) first for the current state,
and [`bridge-architecture.md`](./bridge-architecture.md) for the existing
Slack↔Telegram module boundaries.

---

## TL;DR — the recommendation

**Build a modular monolith now. Do not start with microservices.**

- One deployable Node.js service, but reorganized into **clear internal modules**
  with explicit boundaries and a thin **queue/outbox seam** between "receive a
  message" and "act on a message".
- That seam is what makes the difference: it lets us add **rate limiting**,
  **retries**, and **Jira automation** cleanly today, and lets us **extract any
  module into its own service later** (starting with the Balancer
  Telegram→Telegram forwarder) with no rewrite.
- Add the two things the current code is missing and the new work depends on:
  1. **Rate limiting** — inbound (HTTP) and outbound (per-chat/global token
     buckets for the platform APIs).
  2. **Request authenticity** — Slack signature + Telegram secret verification,
     and auth on admin/API.

In one line: **a monolith on the outside, microservice-ready on the inside.**

---

## Why not microservices (yet)

Microservices solve *organizational and scaling* problems (independent teams,
independent deploys, independent scaling of hot paths). PaycomConnect today has
none of those pressures, and adopting them now would cost more than it returns.

| Concern | Microservices now | Modular monolith now |
| --- | --- | --- |
| Team size / velocity | High overhead (many repos/pipelines, contracts) | Fast: one repo, one deploy |
| Operational cost | N services + queue + service discovery + tracing | One process (+ optional Redis) |
| Data consistency | Distributed transactions / sagas needed early | Local transactions in one DB |
| Debuggability | Cross-service tracing required to follow one message | Single stack trace |
| Failure surface | Network partitions, partial failures | In-process calls |
| Refactor cost | High if boundaries are wrong | Low — move a folder |

The requirements do contain **real seams** (ingestion, bridging, rate-limited
forwarding, Jira automation, admin) that *will* justify extraction under load.
The right move is to **name those seams now** and keep them clean, so extraction
is a deployment decision later, not a rewrite. That is precisely what a modular
monolith gives you: the **option** to split without the **obligation**.

**When to actually split** (trigger-based, not calendar-based):

- The Balancer Telegram→Telegram forwarder needs to scale or fail
  independently from the support bridge → extract it first (it is naturally
  isolated and rate-limit heavy).
- The Jira automation worker does heavy/slow work or needs its own retry/backoff
  budget → extract it as a worker consuming the queue.
- Admin traffic or a public API grows enough to need independent scaling/auth
  isolation → extract the API/admin surface.

Each of these is already a module in the target layout below, so extraction ==
"give this module its own process + the shared queue".

---

## Target architecture (modular monolith)

### Runtime shape

```text
                    ┌─────────────────────────── PaycomConnect (1 process) ───────────────────────────┐
   Telegram ─┐      │  api/ (HTTP)                domain/ (business logic)        infra/               │
   Slack ────┼────▶ │  ├─ webhooks  ─┐            ├─ bridge/                      ├─ queue (in-proc     │
   Balancer ─┘      │  ├─ admin      │  enqueue   ├─ connections/     ┌─ consume  │   now, Redis later) │
                    │  └─ api        │  ───────▶  ├─ onboarding/  ◀───┘           ├─ persistence (Mongo)│
                    │                │            ├─ automation/ (Jira)           ├─ ratelimit (buckets)│
                    │  adapters/ (platform IO) ◀──┴─ forwarding/ (TG→TG, TG↔Slack)├─ config             │
                    │  ├─ telegram  ├─ slack  ├─ jira                             └─ logging/metrics    │
                    └──────────────────────────────────────────────────────────────────────────────────┘
                                        │ outbound (rate-limited) │
                                        ▼                         ▼
                                   Telegram Bot API          Slack Web API / Jira REST
```

Key idea: **HTTP handlers stay thin.** A webhook validates the request, ACKs
fast (Slack/Telegram require a quick 200), and **enqueues** a job. Workers pull
from the queue and run the domain logic through **rate-limited** adapters. Today
the "queue" is an in-process async queue; the interface is identical when it
becomes Redis/BullMQ, so moving to a separate worker process is a config change.

### Proposed folder layout

Evolve the current flat `services/` into layered `src/` (this matches and
extends the "later refactor" sketch already in `bridge-architecture.md`):

```text
src/
  api/
    http/                # express app, middleware (auth, rate-limit, signatures)
    webhooks/            # telegram.webhook.js, slack.webhook.js  (thin: verify + enqueue)
    admin/               # admin REST + (optional) served UI
  adapters/
    telegram/            # single Telegram Bot API client (replaces telegramService + TelegramApiService)
    slack/               # single Slack Web API client (replaces slackService + SlackApiService)
    jira/                # single Jira REST client (replaces jiraService + JiraApiService)
  domain/
    bridge/              # normalize, dedupe, orchestrate (from bridgeService)
    connections/         # INN linking, /connect, /disconnect, routing (from connectionService)
    forwarding/          # delivery use-cases: telegram->slack, slack->telegram, telegram->telegram (Balancer)
    onboarding/          # ONE onboarding service (merge Slack-DM + Telegram-DM)
    automation/          # Jira automation rules/actions (new)
  infra/
    queue/               # job queue abstraction (in-proc -> Redis/BullMQ)
    persistence/         # models + repositories (Mongo, with a real memory impl for tests)
    ratelimit/           # token-bucket limiters (per-chat, per-workspace, global)
    config/              # env.js
    observability/       # logger, metrics, request-id
  worker/                # queue consumers (same process now; own process when extracted)
tests/
```

You do not have to move every file on day one. The high-value moves are:
**(1)** collapse the duplicate API clients into one adapter each, **(2)** add the
`infra/queue` + `infra/ratelimit` seams, **(3)** put webhook verification in
`api/`.

---

## Where the new requirements land

### 1. Jira automation platform

Add a `domain/automation/` module driven by **rules** (trigger → condition →
action) so new automations are data/config, not new code paths scattered around.

- **Triggers:** inbound message keywords (already exists in `jiraService`),
  connection lifecycle events (`/connect`, `/disconnect`), Jira webhooks (status
  changes), schedules (SLA timers).
- **Actions:** create/transition/comment Jira issues, assign integrator, post
  Slack/Telegram notifications, update the connection.
- **Execution:** automations run as **queue jobs** in `worker/`, so they retry
  with backoff and never block a webhook ACK. This is the natural first
  candidate to become a separate worker process later.
- Consolidate `jiraService.js` + `JiraApiService.js` into one `adapters/jira`
  client and drive it from rules.

### 2. Balancer integration (Telegram → Telegram, with limiters)

This is a distinct **forwarding use-case**, so it gets its own file in
`domain/forwarding/` (`telegram-to-telegram.js`) sharing the same inbound
pipeline (verify → enqueue → rate-limited deliver).

- **Rate limiting is mandatory here.** Implement token-bucket limiters in
  `infra/ratelimit`:
  - **per destination chat:** Telegram allows ~1 message/second/chat and
    ~20 messages/minute to the same group;
  - **global per bot:** ~30 messages/second;
  - queue + backoff on `429` using Telegram's `retry_after`.
- Because forwarding already goes through the queue and a dedicated module, the
  Balancer forwarder is the **first clean extraction target** — it can become
  its own service consuming the shared queue without touching the support bridge.

### 3. Admin web

Start **inside the monolith** under `api/admin/` behind authentication:

- Read views over existing data: connections, messages, delivery status,
  onboarding queue, Jira automation runs, rate-limit/queue health.
- Write actions: approve users, link/unlink INN, retry failed deliveries,
  enable/disable automations.
- UI: either server-rendered (a real `views/` template — note `GET /` is
  currently broken) or a small SPA hitting `/api/admin`. Keep the API separate
  from the UI so the UI can move out later.
- **Extract only if** admin traffic or auth isolation demands it.

### 4. Rate limiting (cross-cutting, needed regardless)

Two independent layers, both currently missing:

- **Inbound HTTP:** `express-rate-limit` (or equivalent) on webhooks, mock, and
  admin routes to absorb floods and abuse.
- **Outbound platform APIs:** token-bucket limiters in front of every
  Telegram/Slack/Jira call, keyed by chat/workspace/global, with `429`-aware
  backoff. This protects us from platform bans and is the backbone of the
  Balancer feature.

---

## Foundational fixes to do alongside (small, high-leverage)

These unblock the new work and remove risk found during review (details in
`system-overview.md`):

1. **Verify requests** — Slack signing secret on webhook + slash commands; make
   the Telegram webhook secret required in production; add auth on admin/API.
2. **Introduce the queue seam** — even in-process — so webhooks ACK fast and work
   is retriable. This is the single most important structural change.
3. **Collapse duplicate clients** — one adapter each for Telegram/Slack/Jira;
   delete unused `TelegramApiService`, `JiraApiService`, `routes/users.js`,
   `models/db.js`.
4. **Fix the Contact schema mismatch** so CRM/analytics are correct.
5. **Move volatile state out of memory** (dedupe, sessions, avatar cache) into
   Mongo/Redis so the service can run more than one instance.
6. **Stop opening ngrok in production**; gate it behind a dev flag.
7. **Stop persisting/sending plaintext credentials**; hash secrets, deliver
   codes over a single channel.
8. **Provide the missing `views/` (or convert `GET /` to JSON/SPA).**

---

## Phased roadmap (dependency-ordered, not time-boxed)

Phases are ordered by dependency, not by calendar. Each phase is independently
shippable.

**Phase 0 — Harden the current monolith**
Request verification (Slack/Telegram), auth on admin/mock, inbound HTTP rate
limiting, remove ngrok-in-prod, fix Contact schema. No structural change.

**Phase 1 — Introduce the seams (modular monolith core)**
Add `infra/queue` (in-process) and `infra/ratelimit`; make webhooks
verify→enqueue→ACK; route all outbound calls through rate-limited adapters;
collapse duplicate API clients; delete dead code.

**Phase 2 — Feature modules on the seams**
`domain/forwarding/telegram-to-telegram.js` (Balancer) with per-chat/global
limits; `domain/automation/` rule engine for Jira; merge the two onboarding
flows into one module.

**Phase 3 — Admin web**
`api/admin/` (authenticated) + UI over connections, deliveries, automations,
queue/rate-limit health.

**Phase 4 — Scale-out (only when triggered)**
Swap in-process queue for Redis/BullMQ; move `worker/` to its own process; then,
per the triggers above, extract the Balancer forwarder and/or the Jira
automation worker into standalone services that consume the shared queue.
Everything up to here has already made these extractions mechanical.

---

## Decision summary

| Question | Decision |
| --- | --- |
| Monolith or microservices now? | **Modular monolith.** |
| How do we avoid a future rewrite? | **Queue/outbox seam + clear module boundaries** so any module extracts cleanly. |
| First service to extract, later? | **Balancer Telegram→Telegram forwarder**, then the **Jira automation worker**. |
| Where does rate limiting live? | Cross-cutting `infra/ratelimit` (outbound) + `express-rate-limit` (inbound) — added now. |
| Where does the admin web start? | Inside the monolith under `api/admin/`, extractable later. |
| What must happen before new features? | Phase 0 hardening + Phase 1 seams. |

This keeps us fast and cheap today while making the microservice path a
low-risk, incremental decision when — and only when — the load actually
requires it.
