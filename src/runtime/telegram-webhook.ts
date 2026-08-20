import { env } from '../core/env';
import {
  activateTelegramByInn,
  createTelegramConnectDraft,
  getConnectionOverview,
  normalizeInn,
} from './connections';
import { processInboundMessage, recordSkippedInbound, telegramExternalId } from './bridge';
import { findConnectionByInn, findConnectionBySourceChannel, remapTelegramChatId } from './persistence';
import {
  answerCallbackQuery,
  deleteTelegramMessage,
  editTelegramMessage,
  isActiveSyncBufferChat,
  sendTelegramMessageWithKeyboard,
  sendTelegramReply,
} from './telegram';
import { handleTelegramCallback, handleUserMessage } from './telegram-callback';
import { TelegramOnboardingService } from './onboarding-telegram';
import { SlackUser } from './models';
import { formatTelegramMembershipNotice, isTelegramServiceMessage, telegramMessageAuthorName } from './membership';
import { SlackApiService } from './slack-api';
import { logAction } from './action-log';

// Faithful port of the routes/telegram.js webhook orchestration.
const CONNECT_ALLOWED_ROLES = ['manager', 'owner', 'teamlead', 'cx_manager'];
const CONNECT_SESSION_TTL_MS = 10 * 60 * 1000;
const GROUP_COMMAND_DELETE_MS = 45 * 1000;
const groupConnectSessions = new Map<string, any>();

const groupConnectSessionCleanupInterval = setInterval(() => {
  const now = Date.now();
  for (const [chatId, session] of groupConnectSessions.entries()) {
    if (now - session.createdAt > CONNECT_SESSION_TTL_MS) groupConnectSessions.delete(chatId);
  }
}, 60 * 1000);
groupConnectSessionCleanupInterval.unref?.();

export function resetGroupConnectSessions() {
  groupConnectSessions.clear();
}

export function putGroupConnectSession(chatId: string, session: any) {
  groupConnectSessions.set(String(chatId), { createdAt: Date.now(), ...session });
}

function extractTelegramMessage(update: any) {
  return update.message || update.edited_message || update.channel_post || update.edited_channel_post || null;
}

function logTelegramGroupReceipt(update: any, message: any, extra: { action?: string; reason?: string; level?: 'info' | 'warn' | 'error'; text?: string } = {}) {
  void logAction({
    action: extra.action || 'telegram.update.received',
    category: 'message',
    level: extra.level || 'info',
    source: 'telegram',
    message: extra.text || 'Telegram group/channel update received',
    actor: {
      userId: String(message?.from?.id ?? message?.sender_chat?.id ?? ''),
      userName: telegramMessageAuthorName(message),
    },
    externalId: telegramExternalId(message?.chat?.id, message?.message_id),
    context: {
      channelId: String(message?.chat?.id ?? ''),
      chatTitle: message?.chat?.title ?? '',
      chatType: message?.chat?.type ?? '',
      telegramMessageId: message?.message_id ?? null,
      updateId: update?.update_id ?? null,
      reason: extra.reason ?? null,
      hasText: Boolean(message?.text || message?.caption),
      hasMedia: Boolean(
        message?.photo ||
          message?.document ||
          message?.video ||
          message?.sticker ||
          message?.animation ||
          message?.voice ||
          message?.video_note ||
          message?.audio,
      ),
      textPreview: String(message?.text || message?.caption || '').slice(0, 180),
    },
  });
}

function isConnectStartCommand(text: any) {
  return /^\/connect(?:@\w+)?$/i.test(String(text ?? '').trim());
}

function parseActivationInput(text: any, sessionInn = '') {
  const normalized = String(text ?? '').trim();
  let match = normalized.match(/^\/activate(?:@\w+)?\s+(\d{9,14})\s+(PTI-\d+)$/i);
  if (match) return { inn: match[1], jiraTaskKey: match[2].toUpperCase() };
  match = normalized.match(/^(\d{9,14})\s+(PTI-\d+)$/i);
  if (match) return { inn: match[1], jiraTaskKey: match[2].toUpperCase() };
  match = normalized.match(/^\/activate(?:@\w+)?\s+(PTI-\d+)$/i);
  if (match && sessionInn) return { inn: sessionInn, jiraTaskKey: match[1].toUpperCase() };
  match = normalized.match(/^(PTI-\d+)$/i);
  if (match && sessionInn) return { inn: sessionInn, jiraTaskKey: match[1].toUpperCase() };
  return null;
}

async function findActiveManagerByTelegramId(userId: any) {
  return SlackUser.findOne({
    telegramId: String(userId),
    status: 'active',
    role: { $in: CONNECT_ALLOWED_ROLES },
  }).lean();
}

function buildManagerStatusText(connection: any) {
  if (!connection) return '❌ <b>Связка не найдена</b>\n\nДля этого чата еще не создан connect.';
  const keys = Array.isArray(connection.jiraTaskKeys) ? connection.jiraTaskKeys : [];
  const lastKey = connection.jiraIssueKey || (keys.length ? keys[keys.length - 1] : '—');
  return `📊 <b>Статус connect</b>\n\n<b>ИНН:</b> ${connection.inn}\n<b>Статус:</b> ${connection.status}\n<b>Последний Jira key:</b> ${lastKey}\n<b>Всего Jira keys:</b> ${keys.length}`;
}

function buildManagerStatusKeyboard(connection: any) {
  const rows: any[] = [];
  const keys = Array.isArray(connection?.jiraTaskKeys) ? connection.jiraTaskKeys.slice(-5).reverse() : [];
  if (keys.length) {
    for (const key of keys) {
      const jiraUrl = env.jiraBaseUrl ? `${env.jiraBaseUrl.replace(/\/$/, '')}/browse/${key}` : '';
      rows.push([jiraUrl ? { text: `🔗 ${key}`, url: jiraUrl } : { text: `🔗 ${key}`, callback_data: 'mgr_status_no_jira_url' }]);
    }
  } else {
    rows.push([{ text: 'ℹ️ Jira keys пока нет', callback_data: 'mgr_status_no_keys' }]);
  }
  rows.push([{ text: '🔄 Обновить статус', callback_data: 'mgr_status_refresh' }]);
  return rows;
}

function buildConnectStatusText(connection: any) {
  if (!connection) return '❌ Connect не найден для этой группы.';
  if (connection.status === 'linked') {
    return `✅ Connect уже активен.\n\nИНН: ${connection.inn}\nSlack: ${connection.slackChannelName || connection.slackChannelId}`;
  }
  const lastKey = connection.jiraIssueKey || '—';
  return `⏳ Connect создан, но не активен.\n\nИНН: ${connection.inn}\nТекущий статус: ${connection.status}\nПоследний Jira key: ${lastKey}`;
}

function buildConnectActivationKeyboard(inn: string) {
  return [[{ text: '⚡ Активировать connect', callback_data: `connect_activate:${inn}` }]];
}

const ROLE_LABELS: any = {
  manager: 'Менеджер',
  integrator: 'Интегратор',
  b2b_support: 'B2B Support',
  owner: 'Owner',
  teamlead: 'Team Lead',
  cx_manager: 'CX Manager',
};
const STATUS_LABELS: any = { active: '✅ Активен', pending: '⏳ На рассмотрении', rejected: '❌ Отклонён' };

function buildProfileText(user: any) {
  const role = ROLE_LABELS[user.role] ?? user.role ?? '—';
  const status = STATUS_LABELS[user.status] ?? user.status ?? '—';
  const connectCount = Array.isArray(user.connects) ? user.connects.length : 0;
  return `👤 <b>Ваш профиль</b>\n\n<b>Имя:</b> ${user.displayName || '—'}\n<b>Email:</b> ${user.email || '—'}\n<b>Роль:</b> ${role}\n<b>Статус:</b> ${status}\n<b>Connect'ов:</b> ${connectCount}`;
}

function buildProfileKeyboard(user: any) {
  const rows: any[] = [];
  const connectCount = Array.isArray(user.connects) ? user.connects.length : 0;
  if (connectCount > 0) rows.push([{ text: `📋 Мои connect'ы (${connectCount})`, callback_data: 'profile_connects' }]);
  rows.push([{ text: '🔄 Обновить', callback_data: 'profile_back' }]);
  return rows;
}

function buildTasksText(connects: any[]) {
  if (!connects.length) return "📭 <b>Нет активных connect'ов с task'ами</b>";
  const lines = connects
    .slice(-10)
    .reverse()
    .map((c) => {
      const keys = Array.isArray(c.jiraTaskKeys) ? c.jiraTaskKeys : [];
      const last = c.jiraIssueKey || (keys.length ? keys[keys.length - 1] : '—');
      const icon = c.status === 'linked' ? '✅' : '⏳';
      return `${icon} <b>${c.inn}</b>\n  Jira: <code>${last}</code>  [всего: ${keys.length}]`;
    })
    .join('\n\n');
  return `🧩 <b>Jira tasks по вашим connect'ам</b>\n\n${lines}`;
}

function buildTasksKeyboard(connects: any[]) {
  const rows: any[] = [];
  const withJira = connects.filter((c) => c.jiraIssueKey || (Array.isArray(c.jiraTaskKeys) && c.jiraTaskKeys.length));
  for (const c of withJira.slice(0, 5)) {
    const key = c.jiraIssueKey || c.jiraTaskKeys?.slice(-1)[0];
    if (key && env.jiraBaseUrl) rows.push([{ text: `🔗 ${c.inn} → ${key}`, url: `${env.jiraBaseUrl.replace(/\/$/, '')}/browse/${key}` }]);
  }
  rows.push([{ text: '🔄 Обновить', callback_data: 'tasks_refresh' }]);
  return rows;
}

function buildConnectsText(all: any[]) {
  const linked = all.filter((c) => c.status === 'linked');
  const pending = all.filter((c) => c.status === 'pending_slack' || c.status === 'pending_telegram');
  const suspended = all.filter((c) => c.status === 'suspended');
  const linkedLines = linked
    .slice(0, 5)
    .map((c) => `✅ <b>${c.inn}</b>${c.slackChannelName ? ` → #${c.slackChannelName}` : ''}${c.jiraIssueKey ? `\n  Jira: <code>${c.jiraIssueKey}</code>` : ''}`)
    .join('\n');
  const pendingLines = pending
    .slice(0, 3)
    .map((c) => `⏳ <b>${c.inn}</b> — ${c.status === 'pending_slack' ? 'ждёт Slack' : 'ждёт TG'}`)
    .join('\n');
  return (
    `📊 <b>Мониторинг connect'ов</b>\n\n` +
    `✅ Linked: <b>${linked.length}</b>   ⏳ Pending: <b>${pending.length}</b>   ⏸️ Suspended: <b>${suspended.length}</b>   Всего: <b>${all.length}</b>\n\n` +
    (linkedLines ? `<b>Активные:</b>\n${linkedLines}\n\n` : '') +
    (pendingLines ? `<b>Ожидают:</b>\n${pendingLines}` : '')
  );
}

function buildConnectsKeyboard(all: any[]) {
  const linked = all.filter((c) => c.status === 'linked');
  const pending = all.filter((c) => c.status === 'pending_slack' || c.status === 'pending_telegram');
  const rows: any[] = [];
  if (linked.length && pending.length) {
    rows.push([
      { text: `✅ Linked (${linked.length})`, callback_data: 'connects_show_linked' },
      { text: `⏳ Pending (${pending.length})`, callback_data: 'connects_show_pending' },
    ]);
  }
  rows.push([{ text: '🔄 Обновить', callback_data: 'connects_refresh' }]);
  return rows;
}

async function sendPrivateCommandResponse({ chatId, replyToMessageId, text, keyboard }: any) {
  let sent: any;
  if (keyboard?.length) {
    sent = await sendTelegramMessageWithKeyboard({ chatId, text, keyboard, replyToMessageId });
  } else {
    sent = await sendTelegramReply({ chatId, text, replyToMessageId });
  }
  if (replyToMessageId) {
    try {
      await deleteTelegramMessage({ chatId, messageId: replyToMessageId });
    } catch (error: any) {
      console.warn('Failed to delete command message in group:', error.message);
    }
  }
  if (sent?.messageId) {
    setTimeout(async () => {
      try {
        await deleteTelegramMessage({ chatId, messageId: sent.messageId });
      } catch (deleteError: any) {
        console.warn('Failed to auto-delete bot command response:', deleteError.message);
      }
    }, GROUP_COMMAND_DELETE_MS);
  }
  return { mode: 'group_hidden' };
}

// Telegram membership changes (join/leave) are mirrored to Slack as a clean,
// Slack-only notice. Nothing is sent back to Telegram, so the event is visible
// only on the Slack side (as requested). Other service messages are dropped by
// the caller without any Slack output.
async function announceTelegramMembershipToSlack(message: any): Promise<void> {
  const chatId = message?.chat?.id;
  if (!chatId) return;

  const notice = formatTelegramMembershipNotice(message);
  if (!notice) return;

  const connection: any = await findConnectionBySourceChannel('telegram', String(chatId));
  if (!connection || connection.status !== 'linked' || !connection.slackChannelId) return;

  if (env.enableLiveForwarding && env.slackBotToken) {
    try {
      await SlackApiService.sendMessage(connection.slackChannelId, notice);
    } catch (error: any) {
      console.warn('Failed to announce Telegram membership change in Slack:', error.message);
    }
  }

  void logAction({
    action: 'membership.changed',
    category: 'message',
    source: 'telegram',
    message: notice,
    connectionInn: String(connection.inn ?? ''),
    context: { direction: 'telegram_to_slack', kind: 'membership', channelId: String(chatId) },
  });
}

// Main entry: process a Telegram update (called in background after fast ACK).
export async function handleTelegramUpdate(update: any): Promise<void> {
  // ── callback_query ──────────────────────────────────────────────────────────
  if (update.callback_query) {
    const callbackData = update.callback_query.data || '';

    if (callbackData.startsWith('mgr_status_')) {
      const callbackUserId = update.callback_query.from?.id;
      const callbackChatId = update.callback_query.message?.chat?.id;
      const callbackMessageId = update.callback_query.message?.message_id;
      const manager = await findActiveManagerByTelegramId(callbackUserId);
      if (!manager) {
        await answerCallbackQuery({ callbackQueryId: update.callback_query.id, text: 'Недостаточно прав', showAlert: true });
        return;
      }
      if (callbackData === 'mgr_status_refresh') {
        const connection = await findConnectionBySourceChannel('telegram', String(callbackChatId));
        await answerCallbackQuery({ callbackQueryId: update.callback_query.id, text: 'Обновлено' });
        await sendTelegramMessageWithKeyboard({
          chatId: callbackChatId,
          text: buildManagerStatusText(connection),
          keyboard: buildManagerStatusKeyboard(connection),
          replyToMessageId: callbackMessageId,
        });
        return;
      }
      await answerCallbackQuery({ callbackQueryId: update.callback_query.id, text: 'Ок' });
      return;
    }

    if (callbackData.startsWith('connect_activate:')) {
      const callbackUserId = update.callback_query.from?.id;
      const callbackChatId = update.callback_query.message?.chat?.id;
      const targetInn = callbackData.split(':')[1] || '';
      const manager = await findActiveManagerByTelegramId(callbackUserId);
      if (!manager) {
        await answerCallbackQuery({ callbackQueryId: update.callback_query.id, text: 'Недостаточно прав', showAlert: true });
        return;
      }
      groupConnectSessions.set(String(callbackChatId), {
        managerUserId: String(callbackUserId),
        managerName: (manager as any).displayName || (manager as any).email,
        createdAt: Date.now(),
        mode: 'awaiting_activation',
        inn: targetInn,
      });
      await answerCallbackQuery({ callbackQueryId: update.callback_query.id, text: 'Введите PTI ключ' });
      await sendPrivateCommandResponse({
        chatId: callbackChatId,
        text: `⚡ Режим активации включен для ИНН ${targetInn}.\nОтправьте:\n/activate ${targetInn} PTI-12345\nили просто PTI-12345`,
        replyToMessageId: update.callback_query.message?.message_id,
      });
      return;
    }

    const onboardingHandled = await TelegramOnboardingService.handleCallback(update.callback_query);
    if (!onboardingHandled) {
      if (callbackData === 'profile_connects') {
        const cbUserId = update.callback_query.from?.id;
        const cbChatId = update.callback_query.message?.chat?.id;
        const cbMessageId = update.callback_query.message?.message_id;
        await answerCallbackQuery({ callbackQueryId: update.callback_query.id, text: 'Загружаю...' });
        const managerDoc: any = await SlackUser.findOne({ telegramId: String(cbUserId) })
          .populate({ path: 'connects', select: 'inn status slackChannelName jiraIssueKey' })
          .lean();
        const connects = Array.isArray(managerDoc?.connects) ? managerDoc.connects : [];
        const lines = connects.length
          ? connects
              .slice(-10)
              .reverse()
              .map((c: any) => {
                const icon = c.status === 'linked' ? '✅' : c.status === 'suspended' ? '⏸️' : '⏳';
                return `${icon} ${c.inn}${c.jiraIssueKey ? ' · <code>' + c.jiraIssueKey + '</code>' : ''}${c.slackChannelName ? ' → #' + c.slackChannelName : ''}`;
              })
              .join('\n')
          : 'Connectов пока нет';
        await editTelegramMessage({
          chatId: cbChatId,
          messageId: cbMessageId,
          text: `📋 <b>Мои connect'ы</b> (последние 10)\n\n${lines}`,
          keyboard: [[{ text: '◀️ Назад к профилю', callback_data: 'profile_back' }]],
        });
        return;
      }

      if (callbackData === 'profile_back') {
        const cbUserId = update.callback_query.from?.id;
        const cbChatId = update.callback_query.message?.chat?.id;
        const cbMessageId = update.callback_query.message?.message_id;
        await answerCallbackQuery({ callbackQueryId: update.callback_query.id, text: '' });
        const managerDoc: any = await SlackUser.findOne({ telegramId: String(cbUserId) }).lean();
        if (managerDoc) {
          await editTelegramMessage({
            chatId: cbChatId,
            messageId: cbMessageId,
            text: buildProfileText(managerDoc),
            keyboard: buildProfileKeyboard(managerDoc),
          });
        }
        return;
      }

      if (callbackData === 'tasks_refresh') {
        const cbUserId = update.callback_query.from?.id;
        const cbChatId = update.callback_query.message?.chat?.id;
        const cbMessageId = update.callback_query.message?.message_id;
        await answerCallbackQuery({ callbackQueryId: update.callback_query.id, text: 'Обновлено' });
        const userDoc: any = await SlackUser.findOne({ telegramId: String(cbUserId) })
          .populate({ path: 'connects', select: 'inn status jiraTaskKeys jiraIssueKey slackChannelName' })
          .lean();
        const connects = Array.isArray(userDoc?.connects) ? userDoc.connects : [];
        await editTelegramMessage({
          chatId: cbChatId,
          messageId: cbMessageId,
          text: buildTasksText(connects),
          keyboard: buildTasksKeyboard(connects),
        });
        return;
      }

      if (callbackData === 'connects_refresh' || callbackData === 'connects_show_linked' || callbackData === 'connects_show_pending') {
        const cbUserId = update.callback_query.from?.id;
        const cbChatId = update.callback_query.message?.chat?.id;
        const cbMessageId = update.callback_query.message?.message_id;
        const manager = await findActiveManagerByTelegramId(cbUserId);
        if (!manager) {
          await answerCallbackQuery({ callbackQueryId: update.callback_query.id, text: 'Нет прав', showAlert: true });
          return;
        }
        await answerCallbackQuery({ callbackQueryId: update.callback_query.id, text: 'Обновлено' });
        const all = await getConnectionOverview();
        let showList = all;
        let titleExtra = '';
        if (callbackData === 'connects_show_linked') {
          showList = all.filter((c: any) => c.status === 'linked');
          titleExtra = ' — только активные';
        } else if (callbackData === 'connects_show_pending') {
          showList = all.filter((c: any) => c.status === 'pending_slack' || c.status === 'pending_telegram');
          titleExtra = ' — только pending';
        }
        const text =
          callbackData === 'connects_refresh'
            ? buildConnectsText(all)
            : `📊 <b>Connect'ы${titleExtra}</b>\n\n` +
              (showList.length
                ? showList
                    .slice(0, 10)
                    .map((c: any) => `${c.status === 'linked' ? '✅' : '⏳'} <b>${c.inn}</b>${c.slackChannelName ? ` → #${c.slackChannelName}` : ''}`)
                    .join('\n')
                : 'Нет записей');
        await editTelegramMessage({
          chatId: cbChatId,
          messageId: cbMessageId,
          text,
          keyboard: callbackData === 'connects_refresh' ? buildConnectsKeyboard(all) : [[{ text: '◀️ Назад', callback_data: 'connects_refresh' }]],
        });
        return;
      }

      await handleTelegramCallback(update.callback_query);
    }
    return;
  }

  // ── messages ─────────────────────────────────────────────────────────────────
  const message = extractTelegramMessage(update);
  if (!message) return;

  const chatId = message.chat?.id;
  if (isActiveSyncBufferChat(chatId)) return;
  if (message.chat?.type === 'private' && (message.forward_origin || message.forward_from || message.forward_date)) {
    return;
  }

  // Group → supergroup upgrades change the chat id. Remap the connection so
  // subsequent messages still find the Slack channel.
  if (message.migrate_to_chat_id && chatId) {
    try {
      await remapTelegramChatId(String(chatId), String(message.migrate_to_chat_id));
    } catch (error: any) {
      console.warn('Failed to remap Telegram chat id after migration:', error.message);
    }
    return;
  }

  // Service messages (join/leave/title change/pin/…) are never real user
  // messages. Announce join/leave to Slack only, and drop the rest so they do
  // not turn into an empty bridged message.
  if (isTelegramServiceMessage(message)) {
    await announceTelegramMembershipToSlack(message);
    return;
  }

  // Bot-authored edits (including our own far-side copy) must not loop back.
  if ((update.edited_message || update.edited_channel_post) && message.from?.is_bot) return;

  const userId = message.from?.id ?? message.sender_chat?.id ?? message.chat?.id;
  const chatType = message.chat?.type;
  const userName = telegramMessageAuthorName(message);
  const messageText = message.text || message.caption || '';

  // ── private chat: onboarding & profile ──────────────────────────────────────
  if (chatType === 'private') {
    if (messageText === '/start' || messageText === `/start${env.telegramBotName}`) {
      await TelegramOnboardingService.handleStart({ chatId, userId, userName });
      return;
    }
    if (messageText === '/profile' || messageText === `/profile${env.telegramBotName}`) {
      const userDoc: any = await SlackUser.findOne({ telegramId: String(userId) }).lean();
      if (!userDoc) {
        await sendTelegramReply({ chatId, text: '❌ Вы не зарегистрированы в системе. Используйте /start для регистрации.' });
        return;
      }
      await sendTelegramMessageWithKeyboard({ chatId, text: buildProfileText(userDoc), keyboard: buildProfileKeyboard(userDoc) });
      return;
    }
    if (messageText === '/tasks' || messageText === `/tasks${env.telegramBotName}`) {
      const manager = await findActiveManagerByTelegramId(userId);
      if (!manager) {
        await sendTelegramReply({ chatId, text: '❌ Команда доступна только активным менеджерам.' });
        return;
      }
      const userDoc: any = await SlackUser.findOne({ telegramId: String(userId) })
        .populate({ path: 'connects', select: 'inn status jiraTaskKeys jiraIssueKey slackChannelName' })
        .lean();
      const connects = Array.isArray(userDoc?.connects) ? userDoc.connects : [];
      await sendTelegramMessageWithKeyboard({ chatId, text: buildTasksText(connects), keyboard: buildTasksKeyboard(connects) });
      return;
    }
    if (messageText === '/connects' || messageText === `/connects${env.telegramBotName}`) {
      const manager = await findActiveManagerByTelegramId(userId);
      if (!manager) {
        await sendTelegramReply({ chatId, text: '❌ Команда доступна только активным менеджерам.' });
        return;
      }
      const all = await getConnectionOverview();
      await sendTelegramMessageWithKeyboard({ chatId, text: buildConnectsText(all), keyboard: buildConnectsKeyboard(all) });
      return;
    }
    const onboarding = await TelegramOnboardingService.handleMessage({ chatId, userId, userName, text: messageText });
    if (onboarding.handled) return;
    return;
  }

  logTelegramGroupReceipt(update, message);

  if (update.edited_message || update.edited_channel_post) {
    logTelegramGroupReceipt(update, message, {
      action: 'telegram.update.edit',
      text: 'Telegram edited group message received',
    });
    await processInboundMessage('telegram', update);
    return;
  }

  // ── group chat: /connect two-step session ────────────────────────────────────
  if (messageText === `/start${env.telegramBotName}` || messageText === '/start') {
    try {
      await deleteTelegramMessage({ chatId, messageId: message.message_id });
    } catch (_) {}
    return;
  }

  if (isConnectStartCommand(messageText)) {
    const manager = await SlackUser.findOne({
      telegramId: String(userId),
      status: 'active',
      role: { $in: CONNECT_ALLOWED_ROLES },
    }).lean();
    if (!manager) {
      await sendPrivateCommandResponse({
        chatId,
        text: '❌ Команда доступна только активным зарегистрированным менеджерам.',
        replyToMessageId: message.message_id,
      });
      return;
    }
    const existingByChat = await findConnectionBySourceChannel('telegram', String(chatId));
    if (existingByChat) {
      const text = buildConnectStatusText(existingByChat);
      const keyboard = existingByChat.status === 'linked' ? undefined : buildConnectActivationKeyboard(existingByChat.inn);
      await sendPrivateCommandResponse({ chatId, text, keyboard, replyToMessageId: message.message_id });
      return;
    }
    groupConnectSessions.set(String(chatId), {
      managerUserId: String(userId),
      managerName: userName,
      createdAt: Date.now(),
      mode: 'awaiting_inn',
    });
    await sendPrivateCommandResponse({
      chatId,
      text: '✅ Команда принята. Введите ИНН для создания connect (пример: 123456789).',
      replyToMessageId: message.message_id,
    });
    return;
  }

  let connectSession = groupConnectSessions.get(String(chatId));
  if (connectSession) {
    const existingLink: any = await findConnectionBySourceChannel('telegram', String(chatId));
    // Slack may finish /connect while this in-memory wizard is still open.
    // Once the pair is linked the session must not intercept group traffic —
    // that is how a customer's Telegram message vanished while a later
    // manager message (or a Slack→Telegram test) still appeared.
    if (existingLink?.status === 'linked') {
      groupConnectSessions.delete(String(chatId));
      connectSession = undefined;
    }
  }

  if (connectSession && String(userId) === connectSession.managerUserId) {

    if (messageText === '/cancel') {
      groupConnectSessions.delete(String(chatId));
      await sendPrivateCommandResponse({ chatId, text: '❌ Режим connect отменен.', replyToMessageId: message.message_id });
      return;
    }

    if (connectSession.mode === 'awaiting_inn') {
      const inn = normalizeInn(messageText);
      if (!inn) {
        await sendPrivateCommandResponse({
          chatId,
          text: '⚠️ Неверный ИНН. Введите только ИНН (9-14 цифр).\nПример: 123456789\nДля отмены: /cancel',
          replyToMessageId: message.message_id,
        });
        await recordSkippedInbound('telegram', update, 'wizard:invalid_inn');
        return;
      }
      const existingByInn = await findConnectionByInn(inn);
      if (existingByInn) {
        const text = buildConnectStatusText(existingByInn);
        const keyboard = existingByInn.status === 'linked' ? undefined : buildConnectActivationKeyboard(existingByInn.inn);
        groupConnectSessions.set(String(chatId), {
          ...connectSession,
          mode: existingByInn.status === 'linked' ? 'awaiting_inn' : 'awaiting_activation',
          inn: existingByInn.inn,
          createdAt: Date.now(),
        });
        await sendPrivateCommandResponse({ chatId, text, keyboard, replyToMessageId: message.message_id });
        return;
      }
      const draft = await createTelegramConnectDraft({
        inn,
        telegramChatId: String(chatId),
        telegramChatTitle: message.chat?.title ?? String(chatId),
        telegramChatType: chatType,
        userId: String(userId),
        userName,
      });
      groupConnectSessions.set(String(chatId), { ...connectSession, mode: 'awaiting_activation', inn, createdAt: Date.now() });
      await sendPrivateCommandResponse({
        chatId,
        text: `${draft.message}\n\nДля активации отправьте:\n/activate ${inn} PTI-12345`,
        keyboard: buildConnectActivationKeyboard(inn),
        replyToMessageId: message.message_id,
      });
      return;
    }

    const parsedActivation = parseActivationInput(messageText, connectSession.inn);
    if (!parsedActivation) {
        await sendPrivateCommandResponse({
          chatId,
          text: `⚠️ Неверный формат активации.\nОтправьте:\n/activate ${connectSession.inn || '<INN>'} PTI-12345\nили просто PTI-12345`,
          replyToMessageId: message.message_id,
        });
        await recordSkippedInbound('telegram', update, 'wizard:invalid_activation');
        return;
    }
    const activation = await activateTelegramByInn({
      inn: parsedActivation.inn,
      jiraTaskKey: parsedActivation.jiraTaskKey,
      telegramChatId: String(chatId),
      telegramChatTitle: message.chat?.title ?? String(chatId),
      telegramChatType: chatType,
      userId: String(userId),
      userName,
      requireExisting: true,
    });
    await sendPrivateCommandResponse({ chatId, text: activation.message, replyToMessageId: message.message_id });
    if (activation.status === 'linked') {
      if (activation.integratorGreeting) {
        setTimeout(async () => {
          try {
            await sendTelegramReply({ chatId, text: activation.integratorGreeting });
          } catch (greetError: any) {
            console.warn('Failed to send delayed integrator greeting:', greetError.message);
          }
        }, 60 * 1000);
      }
      groupConnectSessions.delete(String(chatId));
    }
    return;
  }

  // Hide other slash commands in groups
  if (messageText.startsWith('/')) {
    logTelegramGroupReceipt(update, message, {
      action: 'telegram.update.skipped',
      reason: 'slash_command',
      level: 'info',
      text: 'Slash command in group was not bridged',
    });
    try {
      await deleteTelegramMessage({ chatId, messageId: message.message_id });
    } catch (_) {}
    return;
  }

  // Normal group message -> bridge. If a leftover wizard state eats the text,
  // still store a skipped row so the chat history in Mongo is complete.
  const userMessageResult = await handleUserMessage({ userId, userName, chatId, messageText });
  if (userMessageResult.type === 'normal_message') {
    await processInboundMessage('telegram', update);
    return;
  }
  await recordSkippedInbound('telegram', update, `wizard:${userMessageResult.type || userMessageResult.error || 'held'}`);
}
