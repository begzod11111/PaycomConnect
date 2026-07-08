import {
  answerCallbackQuery,
  editTelegramMessage,
  sendTelegramMessageWithKeyboard,
} from './telegram';
import { activateTelegramByInn, normalizeInn } from './connections';
import { findConnectionBySourceChannel } from './persistence';

// Faithful port of services/telegramCallbackService.js (inline connect wizard).
const userStates = new Map<string, any>();

export function setUserState(userId: any, chatId: any, state: string, data: any = {}) {
  userStates.set(`${chatId}:${userId}`, { state, data, timestamp: Date.now() });
}

export function getUserState(userId: any, chatId: any) {
  return userStates.get(`${chatId}:${userId}`) ?? null;
}

export function clearUserState(userId: any, chatId: any) {
  userStates.delete(`${chatId}:${userId}`);
}

const userStateCleanupInterval = setInterval(() => {
  const now = Date.now();
  for (const [key, value] of userStates.entries()) {
    if (now - value.timestamp > 3600000) userStates.delete(key);
  }
}, 300000);
userStateCleanupInterval.unref?.();

export function getMainMenuKeyboard() {
  return [
    [
      { text: '🔗 Активировать по INN', callback_data: 'activate_start' },
      { text: '📊 Статус связки', callback_data: 'connection_status' },
    ],
    [
      { text: '📝 Помощь', callback_data: 'help' },
      { text: 'ℹ️ О боте', callback_data: 'about' },
    ],
  ];
}

export function getInnConfirmKeyboard(inn: string) {
  return [
    [
      { text: '✅ Подтвердить', callback_data: `inn_confirm:${inn}` },
      { text: '❌ Отмена', callback_data: 'inn_cancel' },
    ],
  ];
}

export async function handleStartCommand({ chatId }: any) {
  const text = `👋 <b>Добро пожаловать в PaycomConnect!</b>\n\nЯ помогу связать Telegram группу со Slack каналом по ИНН компании.\n\n<b>Как это работает:</b>\n1️⃣ Нажмите "Активировать по INN"\n2️⃣ Введите ИНН вашей компании\n3️⃣ Подтвердите активацию\n4️⃣ Дождитесь подключения Slack-стороны\n5️⃣ Начните общение!\n\nВыберите действие:`;
  await sendTelegramMessageWithKeyboard({ chatId, text, keyboard: getMainMenuKeyboard() });
  return { ok: true, type: 'start' };
}

export async function handleTelegramCallback(callbackQuery: any): Promise<any> {
  const { id: callbackQueryId, from, message, data: callbackData } = callbackQuery;
  const chatId = message?.chat?.id;
  const messageId = message?.message_id;
  const userId = from?.id;
  const userName = [from?.first_name, from?.last_name].filter(Boolean).join(' ') || from?.username || 'User';

  let answered = false;
  try {
    if (!chatId || !userId) {
      await answerCallbackQuery({ callbackQueryId, text: 'Ошибка: не удалось определить чат или пользователя', showAlert: true });
      return { ok: false, error: 'Missing chat or user ID' };
    }

    let result: any;
    if (callbackData === 'activate_start') {
      result = await handleActivateStart({ callbackQueryId, chatId, userId, userName, messageId });
      answered = true;
    } else if (callbackData === 'connection_status') {
      result = await handleConnectionStatus({ callbackQueryId, chatId, messageId });
      answered = true;
    } else if (callbackData === 'help') {
      result = await handleHelp({ callbackQueryId, chatId, messageId });
      answered = true;
    } else if (callbackData === 'about') {
      result = await handleAbout({ callbackQueryId, chatId, messageId });
      answered = true;
    } else if (callbackData.startsWith('inn_confirm:')) {
      const inn = callbackData.replace('inn_confirm:', '');
      result = await handleInnConfirm({ callbackQueryId, chatId, userId, userName, messageId, inn, message });
      answered = true;
    } else if (callbackData === 'inn_cancel') {
      result = await handleInnCancel({ callbackQueryId, chatId, userId, messageId });
      answered = true;
    } else if (callbackData === 'back_to_menu') {
      result = await handleBackToMenu({ callbackQueryId, chatId, messageId });
      answered = true;
    } else {
      await answerCallbackQuery({ callbackQueryId, text: 'Неизвестное действие' });
      answered = true;
      result = { ok: false, error: 'Unknown callback' };
    }
    return result;
  } catch (error: any) {
    if (!answered) {
      try {
        await answerCallbackQuery({ callbackQueryId, text: `Ошибка: ${error.message}`, showAlert: true });
      } catch (answerError) {
        console.error('❌ Failed to answer callback:', answerError);
      }
    }
    return { ok: false, error: error.message };
  }
}

async function handleActivateStart({ callbackQueryId, chatId, userId, messageId }: any) {
  const text = `🔗 <b>Активация связки по ИНН</b>\n\nОтправьте ИНН вашей компании (9-14 цифр).\n\nНапример: <code>123456789</code>\n\nДля отмены отправьте /cancel`;
  await editTelegramMessage({ chatId, messageId, text, keyboard: [[{ text: '❌ Отмена', callback_data: 'back_to_menu' }]] });
  await answerCallbackQuery({ callbackQueryId, text: 'Введите ИНН' });
  setUserState(userId, chatId, 'awaiting_inn', { originalMessageId: messageId });
  return { ok: true, type: 'activate_start' };
}

async function handleConnectionStatus({ callbackQueryId, chatId, messageId }: any) {
  const connection: any = await findConnectionBySourceChannel('telegram', String(chatId));
  let text: string;
  const keyboard = [[{ text: '🔙 Назад', callback_data: 'back_to_menu' }]];

  if (!connection) {
    text = `❌ <b>Связка не найдена</b>\n\nЭтот чат еще не связан с Slack каналом.\nИспользуйте кнопку "Активировать по INN" для создания связки.`;
  } else if (connection.status === 'linked') {
    text = `✅ <b>Связка активна</b>\n\n<b>ИНН:</b> <code>${connection.inn}</code>\n<b>Telegram чат:</b> ${connection.telegramChatTitle || chatId}\n<b>Slack канал:</b> ${connection.slackChannelName || connection.slackChannelId}\n<b>Статус:</b> Подключено\n<b>Активировано:</b> ${new Date(connection.linkedAt).toLocaleString('ru-RU')}\n\nСообщения синхронизируются между платформами.`;
  } else {
    text = `⏳ <b>Ожидание подключения</b>\n\n<b>ИНН:</b> <code>${connection.inn}</code>\n<b>Telegram чат:</b> ${connection.telegramChatTitle || chatId}\n<b>Статус:</b> ${connection.status === 'pending_slack' ? 'Ожидается Slack' : 'В процессе'}\n\nПопросите коллегу из Slack выполнить команду:\n<code>/connect ${connection.inn}</code>`;
  }

  await editTelegramMessage({ chatId, messageId, text, keyboard });
  await answerCallbackQuery({ callbackQueryId, text: connection ? 'Статус обновлен' : 'Связка не найдена' });
  return { ok: true, type: 'connection_status', connection };
}

async function handleHelp({ callbackQueryId, chatId, messageId }: any) {
  const text = `📝 <b>Помощь по использованию бота</b>\n\n<b>Команды:</b>\n/start - Главное меню\n/connect ИНН - Быстрая активация\n/status - Статус связки\n/cancel - Отмена текущей операции\n\n<b>Как активировать связку:</b>\n1. Добавьте бота в группу как администратора\n2. Нажмите "Активировать по INN"\n3. Введите ИНН компании (9-14 цифр)\n4. Подтвердите активацию\n5. В Slack выполните <code>/connect ИНН</code>\n6. Готово! Сообщения синхронизируются\n\n<b>Поддержка:</b>\nПри проблемах обратитесь к администратору.`;
  await editTelegramMessage({ chatId, messageId, text, keyboard: [[{ text: '🔙 Назад', callback_data: 'back_to_menu' }]] });
  await answerCallbackQuery({ callbackQueryId, text: 'Помощь' });
  return { ok: true, type: 'help' };
}

async function handleAbout({ callbackQueryId, chatId, messageId }: any) {
  const text = `ℹ️ <b>О PaycomConnect</b>\n\n<b>Версия:</b> 0.1.0\n<b>Назначение:</b> Синхронизация Telegram ↔ Slack\n\n<b>Возможности:</b>\n✅ Связка чатов по ИНН\n✅ Двусторонняя синхронизация сообщений\n✅ Интеграция с JIRA\n✅ CRM и аналитика\n✅ Автоматическая обработка первого обращения`;
  await editTelegramMessage({ chatId, messageId, text, keyboard: [[{ text: '🔙 Назад', callback_data: 'back_to_menu' }]] });
  await answerCallbackQuery({ callbackQueryId, text: 'О боте' });
  return { ok: true, type: 'about' };
}

async function handleInnConfirm({ callbackQueryId, chatId, userId, userName, messageId, inn, message }: any) {
  try {
    const chatTitle = message?.chat?.title || `Chat ${chatId}`;
    const chatType = message?.chat?.type || 'private';
    const result = await activateTelegramByInn({
      inn,
      telegramChatId: String(chatId),
      telegramChatTitle: chatTitle,
      telegramChatType: chatType,
      userId: String(userId),
      userName,
    });

    const text =
      result.status === 'linked'
        ? `✅ <b>Связка активирована!</b>\n\n<b>ИНН:</b> <code>${inn}</code>\n<b>Статус:</b> Подключено к Slack\n\nСообщения будут синхронизироваться автоматически.`
        : `✅ <b>Связка создана!</b>\n\n<b>ИНН:</b> <code>${inn}</code>\n<b>Статус:</b> Ожидается Slack\n\nПопросите коллегу из Slack выполнить:\n<code>/connect ${inn}</code>\n\nПосле этого сообщения начнут синхронизироваться.`;

    await editTelegramMessage({ chatId, messageId, text, keyboard: [[{ text: '🔙 В меню', callback_data: 'back_to_menu' }]] });
    await answerCallbackQuery({ callbackQueryId, text: 'Связка создана!' });
    clearUserState(userId, chatId);
    return { ok: true, type: 'inn_confirmed', result };
  } catch (error: any) {
    await answerCallbackQuery({ callbackQueryId, text: `Ошибка: ${error.message}`, showAlert: true });
    throw error;
  }
}

async function handleInnCancel({ callbackQueryId, chatId, userId, messageId }: any) {
  await handleBackToMenu({ callbackQueryId, chatId, messageId });
  clearUserState(userId, chatId);
  return { ok: true, type: 'inn_cancelled' };
}

async function handleBackToMenu({ callbackQueryId, chatId, messageId }: any) {
  const text = `🏠 <b>Главное меню</b>\n\nВыберите действие:`;
  await editTelegramMessage({ chatId, messageId, text, keyboard: getMainMenuKeyboard() });
  await answerCallbackQuery({ callbackQueryId, text: 'Главное меню' });
  return { ok: true, type: 'back_to_menu' };
}

export async function handleUserMessage({ userId, userName, chatId, messageText }: any) {
  const userState = getUserState(userId, chatId);

  if (messageText === '/cancel') {
    if (userState) {
      clearUserState(userId, chatId);
      await sendTelegramMessageWithKeyboard({ chatId, text: '❌ Операция отменена', keyboard: getMainMenuKeyboard() });
      return { ok: true, type: 'cancelled' };
    }
    return { ok: true, type: 'no_operation' };
  }

  if (userState?.state === 'awaiting_inn') {
    const inn = normalizeInn(messageText);
    if (!inn) {
      await sendTelegramMessageWithKeyboard({
        chatId,
        text: '❌ Неверный формат ИНН. Введите 9-14 цифр.\n\nНапример: <code>123456789</code>',
        keyboard: [[{ text: '❌ Отмена', callback_data: 'back_to_menu' }]],
      });
      return { ok: false, error: 'Invalid INN format' };
    }
    await sendTelegramMessageWithKeyboard({
      chatId,
      text: `Подтвердите активацию связки:\n\n<b>ИНН:</b> <code>${inn}</code>`,
      keyboard: getInnConfirmKeyboard(inn),
    });
    return { ok: true, type: 'inn_entered', inn };
  }

  return { ok: true, type: 'normal_message' };
}
