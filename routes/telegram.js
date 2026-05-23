import express from 'express';

import { env } from '../config/env.js';
import { activateTelegramByInn, createTelegramConnectDraft, getConnectionOverview, normalizeInn } from '../services/connectionService.js';
import { processInboundMessage } from '../services/bridgeService.js';
import { findConnectionByInn, findConnectionBySourceChannel } from '../services/persistenceService.js';
import {
  deleteTelegramWebhook,
  getTelegramBotInfo,
  getTelegramWebhookInfo,
  setTelegramWebhook,
  validateTelegramWebhookSecret,
  answerCallbackQuery,
  deleteTelegramMessage,
  sendTelegramMessageWithKeyboard,
  sendTelegramReply,
  editTelegramMessage,
} from '../services/telegramService.js';
import {
  handleTelegramCallback,
  handleUserMessage,
} from '../services/telegramCallbackService.js';
import { TelegramOnboardingService } from '../services/TelegramOnboardingService.js';
import { SlackUser } from '../models/slackUser.js';

const router = express.Router();
const CONNECT_ALLOWED_ROLES = ['manager', 'owner', 'teamlead', 'cx_manager'];
const CONNECT_SESSION_TTL_MS = 10 * 60 * 1000;
const GROUP_COMMAND_DELETE_MS = 45 * 1000;
const groupConnectSessions = new Map();

const groupConnectSessionCleanupInterval = setInterval(() => {
  const now = Date.now();
  for (const [chatId, session] of groupConnectSessions.entries()) {
    if (now - session.createdAt > CONNECT_SESSION_TTL_MS) {
      groupConnectSessions.delete(chatId);
    }
  }
}, 60 * 1000);
groupConnectSessionCleanupInterval.unref?.();

function isConnectStartCommand(text) {
  return /^\/connect(?:@\w+)?$/i.test(String(text ?? '').trim());
}

function parseActivationInput(text, sessionInn = '') {
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

async function findActiveManagerByTelegramId(userId) {
  return SlackUser.findOne({
    telegramId: String(userId),
    status: 'active',
    role: { $in: CONNECT_ALLOWED_ROLES },
  }).lean();
}

function buildManagerStatusText(connection) {
  if (!connection) {
    return '❌ <b>Связка не найдена</b>\n\nДля этого чата еще не создан connect.';
  }

  const keys = Array.isArray(connection.jiraTaskKeys) ? connection.jiraTaskKeys : [];
  const lastKey = connection.jiraIssueKey || (keys.length ? keys[keys.length - 1] : '—');

  return (
    `📊 <b>Статус connect</b>\n\n` +
    `<b>ИНН:</b> ${connection.inn}\n` +
    `<b>Статус:</b> ${connection.status}\n` +
    `<b>Последний Jira key:</b> ${lastKey}\n` +
    `<b>Всего Jira keys:</b> ${keys.length}`
  );
}

function buildManagerStatusKeyboard(connection) {
  const rows = [];
  const keys = Array.isArray(connection?.jiraTaskKeys) ? connection.jiraTaskKeys.slice(-5).reverse() : [];

  if (keys.length) {
    for (const key of keys) {
      const jiraUrl = env.jiraBaseUrl ? `${env.jiraBaseUrl.replace(/\/$/, '')}/browse/${key}` : '';
      rows.push([
        jiraUrl
          ? { text: `🔗 ${key}`, url: jiraUrl }
          : { text: `🔗 ${key}`, callback_data: 'mgr_status_no_jira_url' },
      ]);
    }
  } else {
    rows.push([{ text: 'ℹ️ Jira keys пока нет', callback_data: 'mgr_status_no_keys' }]);
  }

  rows.push([{ text: '🔄 Обновить статус', callback_data: 'mgr_status_refresh' }]);
  return rows;
}

function buildConnectStatusText(connection) {
  if (!connection) {
    return '❌ Connect не найден для этой группы.';
  }

  if (connection.status === 'linked') {
    return `✅ Connect уже активен.\n\nИНН: ${connection.inn}\nSlack: ${connection.slackChannelName || connection.slackChannelId}`;
  }

  const lastKey = connection.jiraIssueKey || '—';
  return `⏳ Connect создан, но не активен.\n\nИНН: ${connection.inn}\nТекущий статус: ${connection.status}\nПоследний Jira key: ${lastKey}`;
}

function buildConnectActivationKeyboard(inn) {
  return [[{ text: '⚡ Активировать connect', callback_data: `connect_activate:${inn}` }]];
}

const ROLE_LABELS = {
  manager: 'Менеджер',
  integrator: 'Интегратор',
  b2b_support: 'B2B Support',
  owner: 'Owner',
  teamlead: 'Team Lead',
  cx_manager: 'CX Manager',
};

const STATUS_LABELS = {
  active: '✅ Активен',
  pending: '⏳ На рассмотрении',
  rejected: '❌ Отклонён',
};

function buildProfileText(user) {
  const role = ROLE_LABELS[user.role] ?? user.role ?? '—';
  const status = STATUS_LABELS[user.status] ?? user.status ?? '—';
  const connectCount = Array.isArray(user.connects) ? user.connects.length : 0;

  return (
    `👤 <b>Ваш профиль</b>\n\n` +
    `<b>Имя:</b> ${user.displayName || '—'}\n` +
    `<b>Email:</b> ${user.email || '—'}\n` +
    `<b>Роль:</b> ${role}\n` +
    `<b>Статус:</b> ${status}\n` +
    `<b>Connect'ов:</b> ${connectCount}`
  );
}

function buildProfileKeyboard(user) {
  const rows = [];
  const connectCount = Array.isArray(user.connects) ? user.connects.length : 0;
  if (connectCount > 0) {
    rows.push([{ text: `📋 Мои connect'ы (${connectCount})`, callback_data: 'profile_connects' }]);
  }
  rows.push([{ text: '🔄 Обновить', callback_data: 'profile_back' }]);
  return rows;
}

// ── Builders для /tasks ────────────────────────────────────────────────────────

function buildTasksText(connects) {
  if (!connects.length) return '📭 <b>Нет активных connect\'ов с task\'ами</b>';
  const lines = connects.slice(-10).reverse().map((c) => {
    const keys = Array.isArray(c.jiraTaskKeys) ? c.jiraTaskKeys : [];
    const last = c.jiraIssueKey || (keys.length ? keys[keys.length - 1] : '—');
    const icon = c.status === 'linked' ? '✅' : '⏳';
    return `${icon} <b>${c.inn}</b>\n  Jira: <code>${last}</code>  [всего: ${keys.length}]`;
  }).join('\n\n');
  return `🧩 <b>Jira tasks по вашим connect\'ам</b>\n\n${lines}`;
}

function buildTasksKeyboard(connects) {
  const rows = [];
  const withJira = connects.filter((c) => c.jiraIssueKey || (Array.isArray(c.jiraTaskKeys) && c.jiraTaskKeys.length));
  for (const c of withJira.slice(0, 5)) {
    const key = c.jiraIssueKey || c.jiraTaskKeys?.slice(-1)[0];
    if (key && env.jiraBaseUrl) {
      rows.push([{ text: `🔗 ${c.inn} → ${key}`, url: `${env.jiraBaseUrl.replace(/\/$/, '')}/browse/${key}` }]);
    }
  }
  rows.push([{ text: '🔄 Обновить', callback_data: 'tasks_refresh' }]);
  return rows;
}

// ── Builders для /connects ─────────────────────────────────────────────────────

function buildConnectsText(all) {
  const linked = all.filter((c) => c.status === 'linked');
  const pending = all.filter((c) => c.status === 'pending_slack' || c.status === 'pending_telegram');
  const suspended = all.filter((c) => c.status === 'suspended');

  const linkedLines = linked.slice(0, 5).map((c) =>
    `✅ <b>${c.inn}</b>${c.slackChannelName ? ` → #${c.slackChannelName}` : ''}${c.jiraIssueKey ? `\n  Jira: <code>${c.jiraIssueKey}</code>` : ''}`
  ).join('\n');

  const pendingLines = pending.slice(0, 3).map((c) =>
    `⏳ <b>${c.inn}</b> — ${c.status === 'pending_slack' ? 'ждёт Slack' : 'ждёт TG'}`
  ).join('\n');

  return (
    `📊 <b>Мониторинг connect\'ов</b>\n\n` +
    `✅ Linked: <b>${linked.length}</b>   ⏳ Pending: <b>${pending.length}</b>   ⏸️ Suspended: <b>${suspended.length}</b>   Всего: <b>${all.length}</b>\n\n` +
    (linkedLines ? `<b>Активные:</b>\n${linkedLines}\n\n` : '') +
    (pendingLines ? `<b>Ожидают:</b>\n${pendingLines}` : '')
  );
}

function buildConnectsKeyboard(all) {
  const linked = all.filter((c) => c.status === 'linked');
  const pending = all.filter((c) => c.status === 'pending_slack' || c.status === 'pending_telegram');
  const rows = [];
  if (linked.length && pending.length) {
    rows.push([
      { text: `✅ Linked (${linked.length})`, callback_data: 'connects_show_linked' },
      { text: `⏳ Pending (${pending.length})`, callback_data: 'connects_show_pending' },
    ]);
  }
  rows.push([{ text: '🔄 Обновить', callback_data: 'connects_refresh' }]);
  return rows;
}

async function sendPrivateCommandResponse({ chatId, replyToMessageId, text, keyboard }) {
  let sent;

  if (keyboard?.length) {
    sent = await sendTelegramMessageWithKeyboard({
      chatId,
      text,
      keyboard,
      replyToMessageId,
    });
  } else {
    sent = await sendTelegramReply({
      chatId,
      text,
      replyToMessageId,
    });
  }

  // Удаляем команду пользователя, чтобы команда не оставалась в чате.
  if (replyToMessageId) {
    try {
      await deleteTelegramMessage({ chatId, messageId: replyToMessageId });
    } catch (error) {
      console.warn('Failed to delete command message in group:', error.message);
    }
  }

  // Автоудаляем ответ бота для чистоты группы.
  if (sent?.messageId) {
    setTimeout(async () => {
      try {
        await deleteTelegramMessage({ chatId, messageId: sent.messageId });
      } catch (deleteError) {
        console.warn('Failed to auto-delete bot command response:', deleteError.message);
      }
    }, GROUP_COMMAND_DELETE_MS);
  }

  return { mode: 'group_hidden' };
}

// ========== Управление ботом ==========

// Получить информацию о боте
router.get('/bot', async (req, res, next) => {
  try {
    const botInfo = await getTelegramBotInfo();
    res.json(botInfo);
  } catch (error) {
    next(error);
  }
});

// ========== Управление webhook ==========

// Получить статус webhook
router.get('/webhooks', async (req, res, next) => {
  try {
    const webhookInfo = await getTelegramWebhookInfo();
    res.json(webhookInfo);
  } catch (error) {
    next(error);
  }
});

// Установить webhook
router.post('/webhooks', async (req, res, next) => {
  try {
    const webhookUrl = req.body.url || `${req.protocol}://${req.get('host')}/api/telegram/webhook`;
    const secretToken = req.body.secretToken || env.telegramWebhookSecret;

    const result = await setTelegramWebhook({
      url: webhookUrl,
      secretToken,
    });

    res.status(201).json(result);
  } catch (error) {
    next(error);
  }
});

// Удалить webhook
router.delete('/webhooks', async (req, res, next) => {
  try {
    const result = await deleteTelegramWebhook();
    res.json(result);
  } catch (error) {
    next(error);
  }
});

// ========== Webhook endpoint (входящие обновления) ==========

router.post('/webhook', async (req, res, next) => {
    console.log('[Telegram Webhook] Received update:', JSON.stringify(req.body));
  // Валидация secret token
  if (env.telegramWebhookSecret && !validateTelegramWebhookSecret(req, env.telegramWebhookSecret)) {
    return res.status(403).json({ ok: false, error: 'Invalid secret token' });
  }

  try {
    const update = req.body;

    // Обработка callback_query (inline кнопки)
    if (update.callback_query) {
      const callbackData = update.callback_query.data || '';

      if (callbackData.startsWith('mgr_status_')) {
        const callbackUserId = update.callback_query.from?.id;
        const callbackChatId = update.callback_query.message?.chat?.id;
        const callbackMessageId = update.callback_query.message?.message_id;

        const manager = await findActiveManagerByTelegramId(callbackUserId);
        if (!manager) {
          await answerCallbackQuery({
            callbackQueryId: update.callback_query.id,
            text: 'Недостаточно прав',
            showAlert: true,
          });
          return res.status(200).json({ ok: true });
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
          return res.status(200).json({ ok: true });
        }

        await answerCallbackQuery({ callbackQueryId: update.callback_query.id, text: 'Ок' });
        return res.status(200).json({ ok: true });
      }

      if (callbackData.startsWith('connect_activate:')) {
        const callbackUserId = update.callback_query.from?.id;
        const callbackChatId = update.callback_query.message?.chat?.id;
        const targetInn = callbackData.split(':')[1] || '';

        const manager = await findActiveManagerByTelegramId(callbackUserId);
        if (!manager) {
          await answerCallbackQuery({
            callbackQueryId: update.callback_query.id,
            text: 'Недостаточно прав',
            showAlert: true,
          });
          return res.status(200).json({ ok: true });
        }

        groupConnectSessions.set(String(callbackChatId), {
          managerUserId: String(callbackUserId),
          managerName: manager.displayName || manager.email,
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
        return res.status(200).json({ ok: true });
      }

      const onboardingHandled = await TelegramOnboardingService.handleCallback(update.callback_query);
      if (!onboardingHandled) {
        // ── profile_connects ────────────────────────────────────────────────
        if (callbackData === 'profile_connects') {
          const cbUserId = update.callback_query.from?.id;
          const cbChatId = update.callback_query.message?.chat?.id;
          const cbMessageId = update.callback_query.message?.message_id;
          await answerCallbackQuery({ callbackQueryId: update.callback_query.id, text: 'Загружаю...' });

          const managerDoc = await SlackUser.findOne({ telegramId: String(cbUserId) })
            .populate({ path: 'connects', select: 'inn status slackChannelName jiraIssueKey' })
            .lean();

          const connects = Array.isArray(managerDoc?.connects) ? managerDoc.connects : [];
          const lines = connects.length
            ? connects.slice(-10).reverse().map((c) => {
                const icon = c.status === 'linked' ? '✅' : c.status === 'suspended' ? '⏸️' : '⏳';
                return `${icon} ${c.inn}${c.jiraIssueKey ? ' · <code>' + c.jiraIssueKey + '</code>' : ''}${c.slackChannelName ? ' → #' + c.slackChannelName : ''}`;
              }).join('\n')
            : 'Connectов пока нет';

          await editTelegramMessage({
            chatId: cbChatId, messageId: cbMessageId,
            text: `📋 <b>Мои connect\'ы</b> (последние 10)\n\n${lines}`,
            keyboard: [[{ text: '◀️ Назад к профилю', callback_data: 'profile_back' }]],
          });
          return res.status(200).json({ ok: true });
        }

        // ── profile_back ───────────────────────────────────────────────────
        if (callbackData === 'profile_back') {
          const cbUserId = update.callback_query.from?.id;
          const cbChatId = update.callback_query.message?.chat?.id;
          const cbMessageId = update.callback_query.message?.message_id;
          await answerCallbackQuery({ callbackQueryId: update.callback_query.id, text: '' });

          const managerDoc = await SlackUser.findOne({ telegramId: String(cbUserId) }).lean();
          if (managerDoc) {
            await editTelegramMessage({
              chatId: cbChatId, messageId: cbMessageId,
              text: buildProfileText(managerDoc),
              keyboard: buildProfileKeyboard(managerDoc),
            });
          }
          return res.status(200).json({ ok: true });
        }

        // ── tasks_refresh ──────────────────────────────────────────────────
        if (callbackData === 'tasks_refresh') {
          const cbUserId = update.callback_query.from?.id;
          const cbChatId = update.callback_query.message?.chat?.id;
          const cbMessageId = update.callback_query.message?.message_id;
          await answerCallbackQuery({ callbackQueryId: update.callback_query.id, text: 'Обновлено' });

          const userDoc = await SlackUser.findOne({ telegramId: String(cbUserId) })
            .populate({ path: 'connects', select: 'inn status jiraTaskKeys jiraIssueKey slackChannelName' })
            .lean();
          const connects = Array.isArray(userDoc?.connects) ? userDoc.connects : [];
          await editTelegramMessage({
            chatId: cbChatId, messageId: cbMessageId,
            text: buildTasksText(connects),
            keyboard: buildTasksKeyboard(connects),
          });
          return res.status(200).json({ ok: true });
        }

        // ── connects_refresh / connects_show_linked / connects_show_pending ─
        if (callbackData === 'connects_refresh' || callbackData === 'connects_show_linked' || callbackData === 'connects_show_pending') {
          const cbUserId = update.callback_query.from?.id;
          const cbChatId = update.callback_query.message?.chat?.id;
          const cbMessageId = update.callback_query.message?.message_id;

          const manager = await findActiveManagerByTelegramId(cbUserId);
          if (!manager) {
            await answerCallbackQuery({ callbackQueryId: update.callback_query.id, text: 'Нет прав', showAlert: true });
            return res.status(200).json({ ok: true });
          }
          await answerCallbackQuery({ callbackQueryId: update.callback_query.id, text: 'Обновлено' });

          const all = await getConnectionOverview();
          let showList = all;
          let titleExtra = '';
          if (callbackData === 'connects_show_linked') {
            showList = all.filter((c) => c.status === 'linked');
            titleExtra = ' — только активные';
          } else if (callbackData === 'connects_show_pending') {
            showList = all.filter((c) => c.status === 'pending_slack' || c.status === 'pending_telegram');
            titleExtra = ' — только pending';
          }

          const text = callbackData === 'connects_refresh'
            ? buildConnectsText(all)
            : `📊 <b>Connect\'ы${titleExtra}</b>\n\n` +
              (showList.length
                ? showList.slice(0, 10).map((c) => {
                    const icon = c.status === 'linked' ? '✅' : '⏳';
                    return `${icon} <b>${c.inn}</b>${c.slackChannelName ? ` → #${c.slackChannelName}` : ''}`;
                  }).join('\n')
                : 'Нет записей');

          await editTelegramMessage({
            chatId: cbChatId, messageId: cbMessageId,
            text,
            keyboard: callbackData === 'connects_refresh'
              ? buildConnectsKeyboard(all)
              : [[{ text: '◀️ Назад', callback_data: 'connects_refresh' }]],
          });
          return res.status(200).json({ ok: true });
        }

        await handleTelegramCallback(update.callback_query);
      }
      return res.status(200).json({ ok: true });
    }


    // Обработка обычных сообщений
    const message = update.message || update.edited_message;

    if (message) {
      const chatId = message.chat?.id;
      const userId = message.from?.id;
      const chatType = message.chat?.type; // 'private' | 'group' | 'supergroup' | 'channel'
      const userName =
        [message.from?.first_name, message.from?.last_name].filter(Boolean).join(' ') ||
        message.from?.username ||
        'User';
      const messageText = message.text || '';

      // ── Приватный чат (DM с ботом) — онбординг и профиль ───────────────────
      if (chatType === 'private') {
        // /start — начало регистрации
        if (messageText === '/start' || messageText === `/start${env.telegramBotName}`) {
          await TelegramOnboardingService.handleStart({ chatId, userId, userName });
          return res.status(200).json({ ok: true });
        }

        // /profile — профиль менеджера с inline-кнопками
        if (messageText === '/profile' || messageText === `/profile${env.telegramBotName}`) {
          const userDoc = await SlackUser.findOne({ telegramId: String(userId) }).lean();

          if (!userDoc) {
            await sendTelegramReply({
              chatId,
              text: '❌ Вы не зарегистрированы в системе. Используйте /start для регистрации.',
            });
            return res.status(200).json({ ok: true });
          }

          await sendTelegramMessageWithKeyboard({
            chatId,
            text: buildProfileText(userDoc),
            keyboard: buildProfileKeyboard(userDoc),
          });
          return res.status(200).json({ ok: true });
        }

        // /tasks — задачи с inline-кнопками
        if (messageText === '/tasks' || messageText === `/tasks${env.telegramBotName}`) {
          const manager = await findActiveManagerByTelegramId(userId);
          if (!manager) {
            await sendTelegramReply({ chatId, text: '❌ Команда доступна только активным менеджерам.' });
            return res.status(200).json({ ok: true });
          }
          const userDoc = await SlackUser.findOne({ telegramId: String(userId) })
            .populate({ path: 'connects', select: 'inn status jiraTaskKeys jiraIssueKey slackChannelName' })
            .lean();
          const connects = Array.isArray(userDoc?.connects) ? userDoc.connects : [];
          await sendTelegramMessageWithKeyboard({
            chatId,
            text: buildTasksText(connects),
            keyboard: buildTasksKeyboard(connects),
          });
          return res.status(200).json({ ok: true });
        }

        // /connects — сводка с inline-кнопками
        if (messageText === '/connects' || messageText === `/connects${env.telegramBotName}`) {
          const manager = await findActiveManagerByTelegramId(userId);
          if (!manager) {
            await sendTelegramReply({ chatId, text: '❌ Команда доступна только активным менеджерам.' });
            return res.status(200).json({ ok: true });
          }
          const all = await getConnectionOverview();
          await sendTelegramMessageWithKeyboard({
            chatId,
            text: buildConnectsText(all),
            keyboard: buildConnectsKeyboard(all),
          });
          return res.status(200).json({ ok: true });
        }

        // Все остальные сообщения в DM — пробуем обработать как шаг онбординга
        const onboarding = await TelegramOnboardingService.handleMessage({
          chatId,
          userId,
          userName,
          text: messageText,
        });
        if (onboarding.handled) {
          return res.status(200).json({ ok: true });
        }

        // DM — всё что не распознано: игнорируем
        return res.status(200).json({ ok: true });
      }

      // ── Групповой чат — только /connect ──────────────────────────────────

      // Команда /start в группе — игнорируем (онбординг только в ЛС)
      if (messageText === `/start${env.telegramBotName}` || messageText === '/start') {
        // Тихо удаляем сообщение с командой
        try { await deleteTelegramMessage({ chatId, messageId: message.message_id }); } catch (_) {}
        return res.status(200).json({ ok: true });
      }

      // Команды /connect@Bot и /integration@Bot запускают режим ожидания INN + PTI только от менеджера
      if (isConnectStartCommand(messageText)) {
        const manager = await SlackUser.findOne({
          telegramId: String(userId),
          status: 'active',
          role: { $in: CONNECT_ALLOWED_ROLES },
        }).lean();

        if (!manager) {
          await sendPrivateCommandResponse({
            chatId,
            userId,
            text: '❌ Команда доступна только активным зарегистрированным менеджерам.',
            replyToMessageId: message.message_id,
          });
          return res.status(200).json({ ok: true });
        }

        const existingByChat = await findConnectionBySourceChannel('telegram', String(chatId));
        if (existingByChat) {
          const text = buildConnectStatusText(existingByChat);
          const keyboard = existingByChat.status === 'linked' ? undefined : buildConnectActivationKeyboard(existingByChat.inn);
          await sendPrivateCommandResponse({
            chatId,
            text,
            keyboard,
            replyToMessageId: message.message_id,
          });
          return res.status(200).json({ ok: true });
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
        return res.status(200).json({ ok: true });
      }

      // Если в группе есть активная сессия connect — слушаем только инициатора
      const connectSession = groupConnectSessions.get(String(chatId));
      if (connectSession) {
        if (String(userId) !== connectSession.managerUserId) {
          // Игнорируем сообщения других участников
          return res.status(200).json({ ok: true });
        }

        if (messageText === '/cancel') {
          groupConnectSessions.delete(String(chatId));
          await sendPrivateCommandResponse({
            chatId,
            userId,
            text: '❌ Режим connect отменен.',
            replyToMessageId: message.message_id,
          });
          return res.status(200).json({ ok: true });
        }

        if (connectSession.mode === 'awaiting_inn') {
          const inn = normalizeInn(messageText);
          if (!inn) {
            await sendPrivateCommandResponse({
              chatId,
              text: '⚠️ Неверный ИНН. Введите только ИНН (9-14 цифр).\nПример: 123456789\nДля отмены: /cancel',
              replyToMessageId: message.message_id,
            });
            return res.status(200).json({ ok: true });
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
            await sendPrivateCommandResponse({
              chatId,
              text,
              keyboard,
              replyToMessageId: message.message_id,
            });
            return res.status(200).json({ ok: true });
          }

          const draft = await createTelegramConnectDraft({
            inn,
            telegramChatId: String(chatId),
            telegramChatTitle: message.chat?.title ?? String(chatId),
            telegramChatType: chatType,
            userId: String(userId),
            userName,
          });

          groupConnectSessions.set(String(chatId), {
            ...connectSession,
            mode: 'awaiting_activation',
            inn,
            createdAt: Date.now(),
          });

          await sendPrivateCommandResponse({
            chatId,
            text: `${draft.message}\n\nДля активации отправьте:\n/activate ${inn} PTI-12345`,
            keyboard: buildConnectActivationKeyboard(inn),
            replyToMessageId: message.message_id,
          });
          return res.status(200).json({ ok: true });
        }

        const parsedActivation = parseActivationInput(messageText, connectSession.inn);
        if (!parsedActivation) {
          await sendPrivateCommandResponse({
            chatId,
            text: `⚠️ Неверный формат активации.\nОтправьте:\n/activate ${connectSession.inn || '<INN>'} PTI-12345\nили просто PTI-12345`,
            replyToMessageId: message.message_id,
          });
          return res.status(200).json({ ok: true });
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

        await sendPrivateCommandResponse({
          chatId,
          text: activation.message,
          replyToMessageId: message.message_id,
        });

        if (activation.status === 'linked') {
          if (activation.integratorGreeting) {
            setTimeout(async () => {
              try {
                await sendTelegramReply({
                  chatId,
                  text: activation.integratorGreeting,
                });
              } catch (greetError) {
                console.warn('Failed to send delayed integrator greeting:', greetError.message);
              }
            }, 60 * 1000);
          }
          groupConnectSessions.delete(String(chatId));
        }

        return res.status(200).json({ ok: true });
      }


      // В группах все команды кроме /connect — скрываем (тихо удаляем)
      if (messageText.startsWith('/')) {
        try { await deleteTelegramMessage({ chatId, messageId: message.message_id }); } catch (_) {}
        return res.status(200).json({ ok: true });
      }

      // Обработка обычных сообщений через bridge
      const userMessageResult = await handleUserMessage({
        message,
        userId,
        userName,
        chatId,
        messageText,
      });

      // Если это обычное сообщение (не INN), обрабатываем через bridge
      if (userMessageResult.type === 'normal_message') {
        const bridgeResult = await processInboundMessage('telegram', update);

        // Ответ по /connect прямо в группу
        if (bridgeResult?.onboarding && bridgeResult?.command?.action === 'connect') {
          await sendPrivateCommandResponse({
            chatId,
            userId,
            text: bridgeResult.activation?.message ?? 'Команда обработана',
            replyToMessageId: message.message_id,
          });
        }
      }
    }

    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error('Telegram webhook error:', error);
    return res.status(200).json({ ok: true });
  }
});

// ========== Управление связками ==========

// Создать/обновить связку по INN
router.post('/connections', async (req, res, next) => {
  try {
    const inn = normalizeInn(req.body.inn);

    if (!inn) {
      res.status(400).json({ error: 'Valid INN is required' });
      return;
    }

    const result = await activateTelegramByInn({
      inn,
      jiraTaskKey: req.body.jiraTaskKey,
      telegramChatId: req.body.telegramChatId ?? req.body.chatId,
      telegramChatTitle: req.body.telegramChatTitle ?? req.body.chatTitle,
      telegramChatType: req.body.telegramChatType ?? req.body.chatType,
      userId: req.body.userId,
      userName: req.body.userName,
    });

    res.status(201).json(result);
  } catch (error) {
    next(error);
  }
});

// ========== Mock endpoint для тестирования ==========

router.post('/mock', async (req, res, next) => {
  try {
    const result = await processInboundMessage('telegram', req.body);
    res.status(result.duplicate ? 200 : 201).json(result);
  } catch (error) {
    next(error);
  }
});

export default router;
