# Onboarding & Connect — current flow and redesign

You described two things that live together today: **user registration**
(onboarding) and **connect** (linking a Telegram group to a Slack channel by
INN + Jira task). Both **stay server-side in PaycomConnect** — the tamada /
Balancer UI is only for UX, viewing data, and internal analytics, not for
registration. This documents how it works now (accurately, from the code and
your description) and how the rewrite reshapes it around entities.

## How it works today

### A. User registration (onboarding)

1. A user writes to the bot in a **DM** (Telegram-DM or Slack-DM — two separate
   implementations).
2. They provide a **corporate email**; the system looks them up (Slack
   `users.lookupByEmail`) and creates a pending user.
3. A **verification code** is issued; after approval (`/approve` or the code
   step) the user becomes **active** with a role (manager, integrator, …).

Problems: two parallel flows (`onboardingService.js` + `TelegramOnboardingService.js`)
with duplicated email/code logic; **in-memory** session state (lost on restart);
**plaintext password** stored/sent; email-domain validation commented out.

### B. Connect (manager-driven, the default you want to keep)

1. A manager **manually creates** a Telegram group.
2. In the group the manager runs the slash command **`/connect <INN>`**. The INN
   (organization tax id) is **globally unique**, which guarantees one chat per
   organization and prevents duplicates.
3. The manager then sends the **PTI activation key** (`<INN> PTI-12345`). Without
   an **active Jira task** there is no activation — because integrators cannot
   answer requests without the task. This is a hard rule.
4. On activation the system: validates the Jira task is active → creates a
   **private Slack channel** → invites the manager + an auto-assigned integrator
   → links the **Telegram group ↔ Slack channel**. The Connection becomes
   `linked` and messages bridge both ways.

Problem: the "INN entered, now awaiting PTI" state is held in an **in-memory**
group session (`groupConnectSessions`), so it is fragile across restarts and
cannot be shared across instances.

### Current flow (diagram)

```text
User DM ──> email ──> code ──> approved ──> ACTIVE user (role)

Manager in TG group:
  /connect <INN> ───────────────> Connection draft (pending, awaiting PTI)   [in-memory session]
  <INN> PTI-12345 ──> Jira active? ──yes──> create Slack channel
                                            invite manager + integrator
                                            link TG chat <-> Slack channel ──> LINKED
                          └──no──> denied (need active task)
```

## Redesign (entity-based, server-side)

Same behavior for the manager (the manual flow you want to keep) — but rebuilt on
the [domain entities](./domain-model.md) with **persisted** state and a **single**
onboarding implementation.

### 1. One onboarding state machine (persisted)

Replace the two DM implementations with **one** `OnboardingModule` whose state
lives in an `OnboardingSession` entity. Platform adapters (Telegram/Slack) only
translate inbound events into the same use-cases.

```text
states:  started ──> email_provided ──> code_sent ──> verified ──> active
                                   └──────────────> rejected (bad email / too many attempts)
```

- State stored in `OnboardingSession` (not memory) → survives restarts, works
  across instances.
- Secrets **hashed** (fix plaintext); codes have an attempt limit and expiry.
- Email-domain allowlist re-enabled and configurable.
- Result: a `User` with `Identity` rows (Telegram and/or Slack) and a role.

### 2. Connect as a use-case pipeline (entity-based)

The connect lifecycle becomes an explicit pipeline in `ConnectionsModule`, each
step operating on entities and persisting state:

```text
parseConnectCommand(text)                      # "/connect <INN> [PTI-KEY]"
  └─> requireActiveManager(user)               # role + status check (User)
  └─> upsertOrganization(inn)                   # Organization (unique INN)
  └─> upsertChat(telegram group)               # Chat entity
  └─> createOrGetConnection(org, tgChat)        # status = pending, persist "awaiting PTI"
        # second message with PTI:
  └─> requireActiveJiraTask(ptiKey)             # JiraTask.isActive (hard rule)
  └─> provisionSlackChat(connection)            # create private Slack channel = Chat
  └─> assignMembers(manager, integrator)        # Membership rows (add people to each other)
  └─> link(connection)                          # status = linked
```

Key change: the "awaiting PTI" state moves from the in-memory `groupConnectSessions`
onto the **`Connection` entity** (a persisted `pending` status), so it is durable
and visible in the admin API/UX.

### 3. Redesigned flow (diagram)

```text
Onboarding (one flow, persisted OnboardingSession):
  DM ─> email ─> code ─> verified ─> User + Identity(+role)

Connect (manager-driven, entities + persisted state):
  /connect <INN>      ─> Organization + Chat(tg) + Connection(pending)   [persisted]
  <INN> PTI-12345     ─> JiraTask active? ─yes─> Chat(slack) provisioned
                                                 Membership(manager, integrator)
                                                 Connection ─> LINKED
                              └─no─> denied (active task required)
```

## What stays vs changes

| Aspect | Now | After |
| --- | --- | --- |
| Where onboarding runs | PaycomConnect (server-side) | **unchanged** — stays server-side |
| tamada / Balancer role | — | UX + data viewing + analytics only (via service-auth API) |
| Manager connect UX | manual group + `/connect` + PTI | **unchanged** (kept as default) |
| Onboarding implementations | two (Slack, Telegram) | **one** shared state machine |
| Session state | in-memory | **persisted** (`OnboardingSession`, `Connection.status`) |
| Passwords/codes | plaintext | **hashed**, expiring, attempt-limited |
| INN uniqueness | implicit | **enforced** via `Organization` unique constraint |
| Active-task rule | enforced in code | **unchanged** (modeled on `JiraTask.isActive`) |

## Room for the future (not now)

You mentioned a possible variant where the slash command makes the **bot create
the group and send an invite link**, and the manager/integrator are added
automatically. The pipeline above isolates connect into steps, so this becomes an
**alternative provisioning strategy** (`provisionTelegramChat`) swapped in later —
without touching onboarding or bridging. For now the manual manager-driven flow
is the default, exactly as you asked.

## Open questions

- Verification code delivery channel — same platform as the DM only, or allow
  cross-channel (code to email)? (Plan: same channel, plus email option.)
- Re-connect of a previously suspended Organization — reuse the old Slack channel
  or always provision a fresh one? (Plan: reuse the `Chat` if still valid.)
- Should integrators be auto-assigned (current load-balancer) or also selectable
  by the manager in the tamada UX? (Plan: keep auto, allow manual override via
  admin API later.)
