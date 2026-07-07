# Domain model — entities

You said the direction is "everything is an entity": a **chat** is one entity
with many functions, there is a **user** entity, and so on, and you want to be
able to add people to each other. This defines the entities, their relationships,
and how they map from today's Mongoose models.

This is the model the NestJS rewrite (see [`framework-decision.md`](./framework-decision.md))
is built around.

## Entities at a glance

| Entity | What it is | Replaces / relates to today |
| --- | --- | --- |
| **Organization** | A customer, identified by a globally-unique **INN**. The anchor that prevents duplicate chats for the same customer. | new (INN currently lives inside `ChannelLink`) |
| **User** | A person: manager, integrator, teamlead, cx_manager, owner, admin. Has platform identities and roles. | `SlackUser` (generalized) + `Contact` |
| **Identity** | One platform login of a User (Telegram or Slack): `{ platform, externalId, username }`. | `slackId` / `telegramId` fields on `SlackUser` |
| **Chat** | A single conversation surface: a Telegram group **or** a Slack channel. Has a platform, external id, title, type, and settings. | the `telegram*` / `slack*` fields inside `ChannelLink` |
| **Membership** | A User's participation in a Chat, with a role. This is where "add people to each other" lives. | `integrators[]` / `managers[]` on `ChannelLink` (generalized) |
| **Connection (Connect)** | Links a Telegram Chat and a Slack Chat under one Organization, activated by a Jira task. Has a lifecycle. | `ChannelLink` (the link itself) |
| **JiraTask** | The activation task (PTI-key). A Connection cannot go live without an active one. | `jiraIssueKey` / `jiraTaskKeys[]` on `ChannelLink` + `JiraIssue` |
| **Message** | A bridged message: source Chat, Connection, delivery status, attachments. | `Message` |
| **OnboardingSession** | Persisted state of a User's registration flow (no more in-memory sessions). | in-memory `sessionState` in the onboarding services |

## Relationships

```text
Organization (INN, unique)
   1│
    ├───< Connection >──────────────┐
    │        │ status               │
    │        │ jiraTask ──> JiraTask │
    │        │                       │
    │   ┌────┴─────┐                 │
    │   ▼          ▼                 │
   Chat(telegram) Chat(slack)        │
     │  ▲            ▲               │
     │  │            │               │
     │  └── Membership ──> User <────┘  (integrators, managers assigned to the connection)
     │                     │  ▲
     │                     │  └── Identity(platform, externalId)   (telegram / slack)
     └───< Message >───────┘
                 │
                 └─ belongs to a Connection, has delivery status + attachments
```

In words:

- An **Organization** (one INN) has one active **Connection** at a time (your
  guarantee that INN is unique keeps this clean and prevents duplicate chats).
- A **Connection** binds exactly two **Chats** — one Telegram group, one Slack
  channel — and references the **JiraTask** that activated it.
- **Users** join **Chats** through **Memberships** (role per chat), and are
  assigned to **Connections** as managers/integrators. A User has one or more
  **Identities** (their Telegram and/or Slack accounts).
- **Messages** belong to a source Chat and a Connection.

## Entity details (fields that matter)

### Organization
`inn` (unique), `name`, `metadata`, timestamps. The de-duplication anchor.

### User
`displayName`, `email`, `role` (`manager|integrator|teamlead|cx_manager|owner|admin`),
`status` (`pending|active|suspended`), `identities: Identity[]`, `connects: Connection[]`.
Secrets are **hashed** (fixes today's plaintext password). Merges `SlackUser` and
folds the CRM `Contact` (first/last seen, message counts) into the User.

### Identity
`platform` (`telegram|slack`), `externalId`, `username`, `linkedAt`. Lets one
person be recognized across both platforms and enables Slack↔Telegram mention
mapping cleanly.

### Chat
`platform` (`telegram|slack`), `externalId` (chat/channel id), `title`, `type`
(`group|supergroup|channel|im`), `settings` (per-chat rate limit, muted, etc.).
"A chat is one entity with many functions" — membership, settings, message
history, and its role in a Connection all hang off it.

### Membership
`chat`, `user`, `role`, `addedBy`, `addedAt`. The explicit "add people to each
other" record. Replaces the implicit `integrators[]`/`managers[]` arrays.

### Connection
`organization` (INN), `telegramChat`, `slackChat`, `status`
(`pending_telegram|pending_slack|linked|suspended`), `jiraTask`, `managers[]`,
`integrators[]`, `activationSource`, `linkedAt`, `lastActivityAt`, `stats`.
This is `ChannelLink` re-expressed as references to real entities instead of
inlined ids.

### JiraTask
`key` (e.g. `PTI-12345`), `organization`/`connection`, `statusName`,
`isActive`, `url`, `usedForActivationAt`. Enforces "no connect without an active
task".

### Message
`connection`, `sourceChat`, `source` (`telegram|slack`), `externalId` (unique
with source), `text`, `attachments[]`, `delivery` (`status|mode|providerMessageId`),
`author` (User/Identity ref), timestamps.

### OnboardingSession
`user`/`identity`, `channel` (`telegram|slack`), `state`
(`started|email_provided|code_sent|verified|active|rejected`), `attempts`,
`expiresAt`. Persisted so restarts/instances don't lose progress.

## Mapping / migration from current models

| Today | Becomes |
| --- | --- |
| `models/channelLink.js` | `Connection` + `Organization` (INN) + two `Chat` rows + `Membership` rows + `JiraTask` |
| `models/slackUser.js` | `User` + `Identity[]` (slack, telegram) |
| `models/contact.js` | folded into `User` (first/last seen, counts) — also fixes the current schema mismatch |
| `models/message.js` | `Message` (+ refs to `Connection`/`Chat`/`User`) |
| `models/jiraIssue.js` | `JiraTask` (+ optional auto-created issue records) |
| in-memory onboarding/connect sessions | `OnboardingSession` (+ a persisted "awaiting PTI" flag on `Connection`) |

A one-time backfill script reads existing `ChannelLink`/`SlackUser` documents and
creates the new entities, so no data is lost during the strangler migration.

## Open modeling questions

- **One active Connection per Organization** — enforce as a hard unique
  constraint (recommended, matches your INN guarantee), or allow historical
  suspended ones alongside? (Plan: unique on `organization` among non-suspended.)
- **Chat reuse** — if the same Telegram group is reconnected later, reuse the
  existing `Chat` row or create a new one per Connection? (Plan: reuse by
  `platform + externalId`.)
- **Client as a User?** — should the end customer in the Telegram group be a
  `User` with a `client` role, or stay an anonymous author on `Message`? (Plan:
  lightweight author identity now; promote to `User` only if needed.)
