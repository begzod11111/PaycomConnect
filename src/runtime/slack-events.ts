// Classify inbound Slack Events API payloads so the bridge only forwards
// real user messages. Slack Connect notices, membership/system events, and
// other non-messages stay on Slack.

export type SlackInboundKind = 'create' | 'edit' | 'delete' | 'ignore';

export interface SlackInboundClassification {
  kind: SlackInboundKind;
  reason?: string;
  // The user-authored message body (inner `message` for edits, previous for deletes).
  message: any;
  envelope: any;
}

const SLACKBOT_USER_IDS = new Set(['USLACKBOT', 'USLACKBOT'.toLowerCase()]);

const IGNORED_EVENT_TYPES = new Set([
  'member_joined_channel',
  'member_left_channel',
  'channel_created',
  'channel_deleted',
  'channel_archive',
  'channel_unarchive',
  'channel_rename',
  'channel_shared',
  'channel_unshared',
  'channel_id_changed',
  'group_archive',
  'group_unarchive',
  'group_rename',
  'group_deleted',
  'pin_added',
  'pin_removed',
  'reaction_added',
  'reaction_removed',
  'star_added',
  'star_removed',
  'user_change',
  'team_join',
  'file_created',
  'file_public',
  'file_shared',
  'file_unshared',
  'file_deleted',
  'file_change',
  'app_mention',
  'app_home_opened',
  'shared_channel_invite_received',
  'shared_channel_invite_accepted',
  'shared_channel_invite_approved',
  'shared_channel_invite_declined',
  'shared_channel_invite_requested',
]);

// Subtypes that are still a human message we want to bridge.
const USER_MESSAGE_SUBTYPES = new Set(['', 'file_share', 'me_message']);

const SYSTEM_MESSAGE_SUBTYPES = new Set([
  'bot_message',
  'bot_add',
  'bot_remove',
  'channel_join',
  'channel_leave',
  'channel_topic',
  'channel_purpose',
  'channel_name',
  'channel_archive',
  'channel_unarchive',
  'channel_posting_permissions',
  'channel_canvas_created',
  'channel_convert_to_private',
  'channel_convert_to_public',
  'group_join',
  'group_leave',
  'group_topic',
  'group_purpose',
  'group_name',
  'group_archive',
  'group_unarchive',
  'pinned_item',
  'unpinned_item',
  'ekm_access_denied',
  'file_comment',
  'file_mention',
  'thread_broadcast',
  'message_replied',
  'joiner_notification',
  'joiner_notification_for_inviter',
  'slackbot_response',
  'huddle_thread',
  'sh_room_created',
  'reminder_add',
  'tombstone',
]);

// Slack Connect / org-share / membership copy that sometimes arrives as a
// normal `message` with no subtype (so a denylist of event types is not enough).
const SYSTEM_NOTICE_PATTERNS: RegExp[] = [
  /has added .+ to all of .+/i,
  /members of those workspaces can now be invited/i,
  /has added this channel to slack connect/i,
  /added this channel to slack connect/i,
  /is sharing this channel with/i,
  /has joined the channel/i,
  /has left the channel/i,
  /set the channel (topic|purpose|name)/i,
  /cleared the channel (topic|purpose)/i,
  /archived (the|this) channel/i,
  /unarchived (the|this) channel/i,
  /converted this channel/i,
  /made this channel private/i,
  /добавил(?:а)? .+ во все .+/i,
  /участники этих рабочих пространств/i,
];

export function slackEventEnvelope(payload: any): any {
  if (!payload || typeof payload !== 'object') return {};
  return payload.event && typeof payload.event === 'object' ? payload.event : payload;
}

export function isSlackbotUser(userId: unknown): boolean {
  const id = String(userId ?? '').trim();
  if (!id) return false;
  return SLACKBOT_USER_IDS.has(id) || SLACKBOT_USER_IDS.has(id.toUpperCase());
}

export function isSlackSystemNoticeText(text: unknown): boolean {
  const raw = String(text ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  if (!raw) return false;
  return SYSTEM_NOTICE_PATTERNS.some((pattern) => pattern.test(raw));
}

function eventTypeOf(envelope: any, payload: any): string {
  return String(envelope?.type ?? payload?.type ?? '').trim();
}

function subtypeOf(message: any, envelope: any): string {
  return String(message?.subtype ?? envelope?.subtype ?? '').trim();
}

export function classifySlackInbound(payload: any): SlackInboundClassification {
  const envelope = slackEventEnvelope(payload);
  const eventType = eventTypeOf(envelope, payload);

  if (eventType && eventType !== 'message') {
    if (IGNORED_EVENT_TYPES.has(eventType)) {
      return { kind: 'ignore', reason: `ignored_event:${eventType}`, message: envelope, envelope };
    }
    // Unknown non-message event types must not become Telegram posts.
    return { kind: 'ignore', reason: `ignored_event:${eventType}`, message: envelope, envelope };
  }

  const subtype = String(envelope?.subtype ?? '').trim();

  if (subtype === 'message_changed') {
    const message = envelope.message ?? envelope;
    if (message?.bot_id || message?.subtype === 'bot_message') {
      return { kind: 'ignore', reason: 'ignored_subtype:bot_message', message, envelope };
    }
    if (isSlackbotUser(message?.user) || isSlackSystemNoticeText(message?.text)) {
      return { kind: 'ignore', reason: 'ignored_system_notice', message, envelope };
    }
    return { kind: 'edit', message, envelope };
  }

  if (subtype === 'message_deleted') {
    const message = envelope.previous_message ?? { ts: envelope.deleted_ts };
    if (message?.bot_id || message?.subtype === 'bot_message') {
      return { kind: 'ignore', reason: 'ignored_subtype:bot_message', message, envelope };
    }
    return { kind: 'delete', message, envelope };
  }

  const message = envelope;
  if (SYSTEM_MESSAGE_SUBTYPES.has(subtype)) {
    return { kind: 'ignore', reason: `ignored_subtype:${subtype}`, message, envelope };
  }
  if (subtype && !USER_MESSAGE_SUBTYPES.has(subtype)) {
    return { kind: 'ignore', reason: `ignored_subtype:${subtype}`, message, envelope };
  }

  if (envelope?.bot_id || message?.bot_id) {
    return { kind: 'ignore', reason: 'ignored_subtype:bot_message', message, envelope };
  }
  if (isSlackbotUser(envelope?.user ?? message?.user ?? payload?.userId)) {
    return { kind: 'ignore', reason: 'ignored_system_notice', message, envelope };
  }
  if (isSlackSystemNoticeText(envelope?.text ?? message?.text ?? payload?.text)) {
    return { kind: 'ignore', reason: 'ignored_system_notice', message, envelope };
  }

  return { kind: 'create', message, envelope };
}

export function slackMessageTs(message: any, envelope: any = {}, payload: any = {}): string {
  return String(
    message?.ts ??
      envelope?.deleted_ts ??
      envelope?.ts ??
      payload?.ts ??
      message?.event_ts ??
      '',
  ).trim();
}

export function slackThreadTs(message: any, envelope: any = {}): string {
  const ts = String(message?.thread_ts ?? envelope?.thread_ts ?? '').trim();
  const own = slackMessageTs(message, envelope);
  // A root message repeats thread_ts === ts; that is not a reply.
  if (ts && own && ts === own) return '';
  return ts;
}

export function slackPermalink(channelId: unknown, ts: unknown): string {
  const channel = String(channelId ?? '').trim();
  const rawTs = String(ts ?? '').trim();
  if (!channel || !rawTs) return '';
  const p = rawTs.replace('.', '');
  return `https://slack.com/archives/${channel}/p${p}`;
}
