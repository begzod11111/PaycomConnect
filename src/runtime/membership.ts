import { escapeSlackText } from './message-format';

// Telegram "service messages" (a user joining/leaving a group, the title being
// changed, a chat being created, a message pinned, …) arrive as normal updates
// but carry no `text`/media. If they are pushed through the bridge they surface
// on the far side as an empty, meaningless message. We intercept them here:
// join/leave are turned into a clean Slack-only notice, everything else is
// silently dropped.

// Telegram uses these bot identities when a human posts anonymously or a
// channel writes into a group. The real name lives on `sender_chat`.
const TELEGRAM_PROXY_SENDER_IDS = new Set([
  '1087968824', // GroupAnonymousBot
  '136817688', // Channel_Bot
  '777000', // Telegram (linked-channel auto-forwards)
]);

// Human-friendly name for a Telegram user object.
export function telegramUserDisplayName(user: any): string {
  if (!user) return '';
  const full = [user.first_name, user.last_name].filter(Boolean).join(' ').trim();
  if (full) return full;
  if (user.username) return `@${String(user.username).replace(/^@+/, '')}`;
  return user.id ? `id${user.id}` : '';
}

export function isTelegramProxySender(user: any): boolean {
  if (!user) return true;
  if (TELEGRAM_PROXY_SENDER_IDS.has(String(user.id))) return true;
  const username = String(user.username || '');
  return username === 'GroupAnonymousBot' || username === 'Channel_Bot';
}

// Display name for a Telegram message, including anonymous-admin / channel posts.
export function telegramMessageAuthorName(message: any, fallback = 'Telegram user'): string {
  if (!message) return fallback;
  const from = message.from;
  const senderChat = message.sender_chat;
  if (senderChat && isTelegramProxySender(from)) {
    if (senderChat.title) return String(senderChat.title);
    if (senderChat.username) return `@${String(senderChat.username).replace(/^@+/, '')}`;
  }
  const fromName = telegramUserDisplayName(from);
  if (fromName) return fromName;
  if (senderChat?.title) return String(senderChat.title);
  if (message.chat?.type === 'channel' && message.chat?.title) return String(message.chat.title);
  return fallback;
}

// True for any Telegram update that is a service/system message rather than a
// real user message (so the bridge can skip it instead of forwarding an empty
// message).
export function isTelegramServiceMessage(message: any): boolean {
  if (!message) return false;
  return Boolean(
    message.new_chat_members ||
      message.left_chat_member ||
      message.new_chat_title ||
      message.new_chat_photo ||
      message.delete_chat_photo ||
      message.group_chat_created ||
      message.supergroup_chat_created ||
      message.channel_chat_created ||
      message.message_auto_delete_timer_changed ||
      message.pinned_message ||
      message.migrate_to_chat_id ||
      message.migrate_from_chat_id,
  );
}

// Build the Slack mrkdwn notice for a Telegram join/leave service message.
// Returns '' when there is nothing worth announcing (e.g. only bots joined, or
// the service message is not a membership change).
export function formatTelegramMembershipNotice(message: any): string {
  if (!message) return '';

  const actor = message.from;
  const actorName = telegramUserDisplayName(actor);

  if (Array.isArray(message.new_chat_members) && message.new_chat_members.length) {
    const humans = message.new_chat_members.filter((member: any) => !member?.is_bot);
    if (!humans.length) return '';
    const names = humans.map(telegramUserDisplayName).filter(Boolean);
    if (!names.length) return '';
    const joined = names.join(', ');

    // Someone was added by another member vs. joined on their own.
    const addedByOther = actor && humans.every((member: any) => String(member.id) !== String(actor.id));
    if (addedByOther && actorName) {
      return `➕ *${escapeSlackText(actorName)}* добавил(а) в Telegram-группу: *${escapeSlackText(joined)}*`;
    }
    const verb = humans.length > 1 ? 'присоединились' : 'присоединился(ась)';
    return `➕ *${escapeSlackText(joined)}* ${verb} к Telegram-группе`;
  }

  if (message.left_chat_member) {
    const member = message.left_chat_member;
    if (member?.is_bot) return '';
    const memberName = telegramUserDisplayName(member);
    if (!memberName) return '';

    const removedByOther = actor && String(member.id) !== String(actor.id);
    if (removedByOther && actorName) {
      return `➖ *${escapeSlackText(actorName)}* удалил(а) из Telegram-группы: *${escapeSlackText(memberName)}*`;
    }
    return `➖ *${escapeSlackText(memberName)}* покинул(а) Telegram-группу`;
  }

  return '';
}
