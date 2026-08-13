# Slack scopes for PaycomConnect

This project bridges Telegram and Slack messages. Slack should use a bot token
only; user-token scopes are not needed for the current code path.

## Recommended minimal bot scopes

Start with this set when the bridge must:

- receive Slack messages from public/private channels and bot DMs;
- send messages to Telegram-linked Slack channels;
- send onboarding/approval DMs;
- resolve Slack user names and corporate email during onboarding;
- upload/download attachments;
- create and archive private Slack channels during Telegram `/connect`.

| Scope | Required for | Why it is needed in this codebase |
| --- | --- | --- |
| `commands` | Slash commands | Enables `/connect`, `/disconnect`, `/approve`, `/script`, `/skript` endpoints under `/api/slack/commands/*`. |
| `chat:write` | Slack outbound messages | Used by `chat.postMessage` for bridged messages, onboarding notifications, command status messages, and DMs. |
| `chat:write.customize` | Telegram user imitation in Slack | Allows `username`, `icon_url`, or `icon_emoji` in `chat.postMessage`, so Telegram messages can appear with the Telegram sender name/avatar. Slack still shows that the message was sent by the app. |
| `channels:history` | Public-channel message events | Needed only if the app subscribes to normal public channel message events (`message.channels`). |
| `groups:history` | Private-channel message events | Needed only if the app subscribes to private channel message events (`message.groups`). |
| `im:history` | Bot DM events | Needed for Slack onboarding, where users write to the bot in a direct message (`message.im`). |
| `im:write` | Opening DMs | Used by `conversations.open` before sending approval/login messages to a Slack user. |
| `users:read` | User profiles | Used by `users.info` and `users.list` to resolve display names and assign integrators. |
| `users:read.email` | Email onboarding | Used by `users.lookupByEmail` to verify a corporate email during onboarding. |
| `files:read` | Slack to Telegram attachments | Required to access Slack file metadata/private download URLs received from Slack message events. |
| `files:write` | Telegram to Slack attachments | Used by `files.getUploadURLExternal` and `files.completeUploadExternal` to upload Telegram files into Slack. |
| `groups:write` | Automatic private-channel lifecycle | Used when Telegram `/connect` creates a private Slack channel, invites users, and `/disconnect` archives it. |

## Scopes to remove from the current test app

These scopes are present in the test environment but are not justified by the
current code path:

| Scope | Recommendation | Reason |
| --- | --- | --- |
| `app_mentions:read` | Remove | The webhook processes message events, not `app_mention` events. Keep only if you add mention-only behavior. |
| `channels:manage` | Remove | The code creates/manages private Slack channels, not public channels. Add only if you intentionally create/archive public channels. |
| `chat:write.public` | Remove | Avoid posting to channels where the app is not a member. Invite the app to required channels instead. |
| `incoming-webhook` | Remove | The project uses `chat.postMessage` with `SLACK_BOT_TOKEN`, not Slack incoming webhook URLs. |
| `groups:read` | Remove for now | Current live paths do not call private-channel read/list/member APIs. Add back only if you use `conversations.info`, `conversations.list`, or `conversations.members` for private channels in production flows. |
| User-token `admin.usergroups:write` | Remove | The app does not modify Slack user groups. |
| User-token `channels:history` | Remove | Use bot-token event scopes instead. The app does not act as an installing user. |
| User-token `channels:write` | Remove | The app should not manage public channels on behalf of a user. |
| User-token `groups:history` | Remove | Use bot-token event scopes instead. The app does not act as an installing user. |
| User-token `groups:write` | Remove | Private-channel lifecycle should run through the bot token, not a user token. |

## Optional reductions by feature

If you disable a feature, remove the related scope too:

| Disabled feature | Remove scopes |
| --- | --- |
| No Slack DM onboarding/approval messages | `im:history`, `im:write`, and possibly `users:read.email` |
| No email verification by Slack profile email | `users:read.email` |
| No attachments in either direction | `files:read`, `files:write` |
| No Telegram-user style name/avatar in Slack | `chat:write.customize` |
| No automatic Slack private-channel creation/archive | `groups:write` |
| Only public Slack channels | `groups:history`, `groups:write` |
| Only private Slack channels | `channels:history` |

## Slack app event subscriptions

Configure the Slack Events API request URL to:

```text
https://<your-domain>/api/slack/webhook
```

Subscribe only to events that match the enabled surfaces:

| Event | Enable when |
| --- | --- |
| `message.channels` | Bridging messages from public Slack channels. |
| `message.groups` | Bridging messages from private Slack channels. |
| `message.im` | Running the Slack DM onboarding flow. |
| `app_mention` | Only if you add mention-triggered commands later. |

## Slash command URLs

Configure Slack slash commands to these request URLs:

```text
/connect     -> https://<your-domain>/api/slack/commands/connect
/disconnect  -> https://<your-domain>/api/slack/commands/disconnect
/approve     -> https://<your-domain>/api/slack/commands/approve
/script      -> https://<your-domain>/api/slack/commands/script
/skript      -> https://<your-domain>/api/slack/commands/skript
```

## Slack sender names in Telegram

When a Slack message is bridged to Telegram it is prefixed with the sender's
name (`[Name] : text`). Slack message callbacks only include a `user` id and,
inconsistently, a `user_profile` object (for example, it is often absent for
messages sent from mobile enterprise clients). To always show a real name
without paying a Slack API round-trip on every message, the bridge resolves the
name from the cheapest available source, in order:

1. `user_profile` in the Slack event callback — zero latency, used as-is when
   present.
2. The registered-user directory (`SlackUser.displayName` / email) in Mongo,
   for people who onboarded into the bridge.
3. A cached `users.info` lookup — only for users we have never seen (for
   example, clients who never registered). The result is memoized so repeated
   messages from the same person never re-query Slack.

If nothing resolves, the message falls back to a neutral `Slack user` label
instead of leaking the raw Slack user id. The `users:read` scope is what enables
step 3; without it, only steps 1–2 and the fallback apply.

## Important limitation

Slack bots cannot truly send messages as real Slack users with a bot token.
`chat:write.customize` only customizes the displayed bot message name/avatar.
Use it for transparent "message forwarded from Telegram user X" behavior, and
make this clear in workspace policy if needed.
