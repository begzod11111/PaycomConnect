# Slack-Telegram bridge architecture

This document describes the intended module boundaries for the current
PaycomConnect MVP and the next safe direction for the file architecture.

## Current flow

```text
Slack Events / Slash Commands          Telegram Webhook
        |                                      |
        v                                      v
routes/slack.js                         routes/telegram.js
        |                                      |
        +------------------+-------------------+
                           v
                 services/bridgeService.js
                           |
        +------------------+-------------------+
        |                                      |
        v                                      v
services/slackService.js                 services/telegramService.js
        |                                      |
        v                                      v
Slack Web API                            Telegram Bot API
```

`services/bridgeService.js` is the orchestration layer:

1. Normalize inbound Slack/Telegram payloads.
2. Deduplicate messages.
3. Detect `/connect` activation commands.
4. Resolve the linked destination channel/chat.
5. Register CRM/message history.
6. Optionally call Jira helpers if Jira env variables are configured.
7. Send the message to the destination platform.

## Existing file responsibilities

| File or directory | Responsibility |
| --- | --- |
| `routes/slack.js` | Slack HTTP adapter: Events API, slash commands, interactivity ACKs. |
| `routes/telegram.js` | Telegram HTTP adapter: webhook, callback, connect activation routes. |
| `services/bridgeService.js` | Platform-neutral message normalization, dedupe, routing orchestration. |
| `services/slackService.js` | Outbound Telegram-to-Slack delivery, Slack file upload, Slack message formatting. |
| `services/telegramService.js` | Outbound Slack-to-Telegram delivery, Slack file download, Telegram message formatting. |
| `services/SlackApiService.js` | Low-level Slack Web API client used for channels, users, DMs, messages. |
| `services/connectionService.js` | Slack/Telegram channel mapping, `/connect`, `/disconnect`, private-channel lifecycle. |
| `services/onboardingService.js` | Slack-side user onboarding and `/approve`. |
| `services/TelegramOnboardingService.js` | Telegram-side onboarding notifications. |
| `services/jiraService.js`, `services/JiraApiService.js` | Optional Jira integration; remains inactive unless Jira env vars are set. |
| `models/channelLink.js` | Persistent mapping between Telegram chats, Slack channels, and Jira metadata. |
| `models/message.js` | Message history and delivery status. |
| `models/slackUser.js` | Internal Slack user registry, roles, Telegram link, Jira relation metadata. |

## Recommended project structure

Keep the current structure for the MVP, but separate platform adapters from
domain logic as the project grows:

```text
config/
  env.js
docs/
  bridge-architecture.md
  slack-permissions.md
models/
  channelLink.js
  contact.js
  jiraIssue.js
  message.js
  slackUser.js
routes/
  api.js
  slack.js
  telegram.js
services/
  bridgeService.js
  connectionService.js
  onboardingService.js
  persistenceService.js
  slackService.js
  telegramService.js
  jiraService.js
  SlackApiService.js
  TelegramApiService.js
tests/
```

For a later refactor, split `services/` into explicit adapters and domain
services:

```text
src/
  adapters/
    slack/
      slack.routes.js
      slack.client.js
      slack.formatter.js
      slack.signature.js
    telegram/
      telegram.routes.js
      telegram.client.js
      telegram.formatter.js
      telegram.secret.js
    jira/
      jira.client.js
      jira.service.js
  domain/
    bridge/
      bridge.service.js
      normalize-message.js
      dedupe.js
    connections/
      connection.service.js
      routing.service.js
    onboarding/
      slack-onboarding.service.js
      telegram-onboarding.service.js
  persistence/
    models/
    repositories/
  config/
```

Only do this refactor when the MVP stabilizes; the current file layout is still
small enough that adding documentation and targeted tests is lower risk.

## Configuration checklist

Required for local or production live forwarding:

| Variable | Purpose |
| --- | --- |
| `SLACK_BOT_TOKEN` | Bot token used for Slack Web API calls. |
| `TELEGRAM_BOT_TOKEN` | Telegram bot token used for Telegram Bot API calls. |
| `MONGODB_URI` | Persistent storage for links, users, messages, and Jira metadata. |
| `ENABLE_LIVE_FORWARDING=true` | Sends real messages instead of mock delivery. |
| `SLACK_CHANNEL_ID` | Fallback Slack destination if no channel link is found. |
| `TELEGRAM_CHAT_ID` | Fallback Telegram destination if no channel link is found. |
| `ONBOARDING_CHANNEL_ID` | Slack channel for registration approval requests. |
| `SLACK_BRIDGE_BOT_NAME` | Optional fallback display name for Slack forwarded messages. |
| `SLACK_BRIDGE_BOT_ICON_EMOJI` | Optional fallback emoji avatar for Slack forwarded messages. |
| `TELEGRAM_WEBHOOK_SECRET` | Optional secret token used to validate Telegram webhook calls. |

Jira remains optional/closed. Leave the Jira variables empty to keep it inactive:

```text
JIRA_BASE_URL=
JIRA_EMAIL=
JIRA_API_TOKEN=
JIRA_PROJECT_KEY=
```

## Security hardening next steps

1. Validate Slack request signatures on every Slack route before processing.
2. Keep `chat:write.public`, public-channel management scopes, and user-token
   scopes disabled unless a production flow explicitly needs them.
3. Store bot tokens only in environment variables or secret storage.
4. Make Jira integration opt-in by env flags and fail closed when Jira is not
   configured.
5. Log provider message IDs and delivery failures without logging bot tokens or
   private file URLs.
