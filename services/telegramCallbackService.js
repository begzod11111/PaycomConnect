import {
  answerCallbackQuery,
  editTelegramMessage,
  sendTelegramMessageWithKeyboard,
} from './telegramService.js';
import { activateTelegramByInn, normalizeInn } from './connectionService.js';
import { findConnectionBySourceChannel } from './persistenceService.js';

// In-memory хранилище состояний пользователей (можно заменить на Redis)
const userStates = new Map();

// Установить состояние пользователя
export function setUserState(userId, chatId, state, data = {}) {
  userStates.set(`${chatId}:${userId}`, {
    state,
    data,
    timestamp: Date.now(),
  });
}

// Получить состояние пользователя
export function getUserState(userId, chatId) {
  return userStates.get(`${chatId}:${userId}`) ?? null;
}

// Очистить состояние пользователя
export function clearUserState(userId, chatId) {
  userStates.delete(`${chatId}:${userId}`);
}

// Очистка старых состояний (старше 1 часа)
const userStateCleanupInterval = setInterval(() => {
  const now = Date.now();
  for (const [key, value] of userStates.entries()) {
    if (now - value.timestamp > 3600000) {
      userStates.delete(key);
    }
  }
}, 300000); // Каждые 5 минут
userStateCleanupInterval.unref?.();

// Генерация клавиатуры главного меню
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

// Генерация клавиатуры для подтверждения INN
export function getInnConfirmKeyboard(inn) {
  return [
    [
      { text: '✅ Подтвердить', callback_data: `inn_confirm:${inn}` },
      { text: '❌ Отмена', callback_data: 'inn_cancel' },
    ],
  ];
}

// Обработка команды /start
export async function handleStartCommand({ chatId, userId, userName, messageId }) {
    console.log('🚀 Handling /start command:', { chatId, userId, userName });
  const text = `👋 <b>Добро пожаловать в PaycomConnect!</b>

Я помогу связать Telegram группу со Slack каналом по ИНН компании.

<b>Как это работает:</b>
1️⃣ Нажмите "Активировать по INN"
2️⃣ Введите ИНН вашей компании
3️⃣ Подтвердите активацию
4️⃣ Дождитесь подключения Slack-стороны
5️⃣ Начните общение!

Выберите действие:`;

  await sendTelegramMessageWithKeyboard({
    chatId,
    text,
    keyboard: getMainMenuKeyboard(),
  });

  return { ok: true, type: 'start' };
}

// Обработка callback query
export async function handleTelegramCallback(callbackQuery) {
    console.log(callbackQuery);
  console.log('🔘 Received callback query:', {
    id: callbackQuery.id,
    data: callbackQuery.data,
    from: callbackQuery.from.username,
  });

  const {
    id: callbackQueryId,
    from,
    message,
    data: callbackData,
  } = callbackQuery;

  const chatId = message?.chat?.id;
  const messageId = message?.message_id;
  const userId = from?.id;
  const userName = [from?.first_name, from?.last_name].filter(Boolean).join(' ') || from?.username || 'User';

  // Гарантируем ответ на callback
  let answered = false;

  try {
    if (!chatId || !userId) {
      await answerCallbackQuery({
        callbackQueryId,
        text: 'Ошибка: не удалось определить чат или пользователя',
        showAlert: true,
      });
      return { ok: false, error: 'Missing chat or user ID' };
    }

    // Обработка разных callback'ов
    let result;

    if (callbackData === 'activate_start') {
      result = await handleActivateStart({ callbackQueryId, chatId, userId, userName, messageId });
      answered = true;
    } else if (callbackData === 'connection_status') {
      result = await handleConnectionStatus({ callbackQueryId, chatId, userId, messageId });
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
      // Неизвестный callback
      await answerCallbackQuery({
        callbackQueryId,
        text: 'Неизвестное действие',
      });
      answered = true;
      result = { ok: false, error: 'Unknown callback' };
    }

    console.log('✅ Callback handled:', result);
    return result;

  } catch (error) {
    console.error('❌ Callback error:', error);

    // Гарантируем ответ даже при ошибке
    if (!answered) {
      try {
        await answerCallbackQuery({
          callbackQueryId,
          text: `Ошибка: ${error.message}`,
          showAlert: true,
        });
      } catch (answerError) {
        console.error('❌ Failed to answer callback:', answerError);
      }
    }

    return { ok: false, error: error.message };
  }
}


// Начало активации по INN
async function handleActivateStart({ callbackQueryId, chatId, userId, userName, messageId }) {
    console.log('🔗 Starting activation by INN:', { chatId, userId, userName });
  const text = `🔗 <b>Активация связки по ИНН</b>

Отправьте ИНН вашей компании (9-14 цифр).

Например: <code>123456789</code>

Для отмены отправьте /cancel`;

  await editTelegramMessage({
    chatId,
    messageId,
    text,
    keyboard: [[{ text: '❌ Отмена', callback_data: 'back_to_menu' }]],
  });

  await answerCallbackQuery({
    callbackQueryId,
    text: 'Введите ИНН',
  });

  setUserState(userId, chatId, 'awaiting_inn', {
    originalMessageId: messageId,
  });

  return { ok: true, type: 'activate_start' };
}

// Проверка статуса связки
async function handleConnectionStatus({ callbackQueryId, chatId, userId, messageId }) {
  const connection = await findConnectionBySourceChannel('telegram', String(chatId));

  let text;
  let keyboard = [[{ text: '🔙 Назад', callback_data: 'back_to_menu' }]];

  if (!connection) {
    text = `❌ <b>Связка не найдена</b>

Этот чат еще не связан с Slack каналом.
Используйте кнопку "Активировать по INN" для создания связки.`;
  } else if (connection.status === 'linked') {
    text = `✅ <b>Связка активна</b>

<b>ИНН:</b> <code>${connection.inn}</code>
<b>Telegram чат:</b> ${connection.telegramChatTitle || chatId}
<b>Slack канал:</b> ${connection.slackChannelName || connection.slackChannelId}
<b>Статус:</b> Подключено
<b>Активировано:</b> ${new Date(connection.linkedAt).toLocaleString('ru-RU')}

Сообщения синхронизируются между платформами.`;
  } else {
    text = `⏳ <b>Ожидание подключения</b>

<b>ИНН:</b> <code>${connection.inn}</code>
<b>Telegram чат:</b> ${connection.telegramChatTitle || chatId}
<b>Статус:</b> ${connection.status === 'pending_slack' ? 'Ожидается Slack' : 'В процессе'}

Попросите коллегу из Slack выполнить команду:
<code>/connect ${connection.inn}</code>`;
  }

  await editTelegramMessage({
    chatId,
    messageId,
    text,
    keyboard,
  });

  await answerCallbackQuery({
    callbackQueryId,
    text: connection ? 'Статус обновлен' : 'Связка не найдена',
  });

  return { ok: true, type: 'connection_status', connection };
}

// Помощь
async function handleHelp({ callbackQueryId, chatId, messageId }) {
  const text = `📝 <b>Помощь по использованию бота</b>

<b>Команды:</b>
/start - Главное меню
/connect ИНН - Быстрая активация
/status - Статус связки
/cancel - Отмена текущей операции

<b>Как активировать связку:</b>
1. Добавьте бота в группу как администратора
2. Нажмите "Активировать по INN"
3. Введите ИНН компании (9-14 цифр)
4. Подтвердите активацию
5. В Slack выполните <code>/connect ИНН</code>
6. Готово! Сообщения синхронизируются

<b>Поддержка:</b>
При проблемах обратитесь к администратору.`;

  await editTelegramMessage({
    chatId,
    messageId,
    text,
    keyboard: [[{ text: '🔙 Назад', callback_data: 'back_to_menu' }]],
  });

  await answerCallbackQuery({
    callbackQueryId,
    text: 'Помощь',
  });

  return { ok: true, type: 'help' };
}

// О боте
async function handleAbout({ callbackQueryId, chatId, messageId }) {
  const text = `ℹ️ <b>О PaycomConnect</b>

<b>Версия:</b> 0.1.0
<b>Назначение:</b> Синхронизация Telegram ↔ Slack

<b>Возможности:</b>
✅ Связка чатов по ИНН
✅ Двусторонняя синхронизация сообщений
✅ Интеграция с JIRA
✅ CRM и аналитика
✅ Автоматическая обработка первого обращения

<b>Технологии:</b>
• Node.js + Express
• MongoDB
• Telegram Bot API
• Slack API
• JIRA API`;

  await editTelegramMessage({
    chatId,
    messageId,
    text,
    keyboard: [[{ text: '🔙 Назад', callback_data: 'back_to_menu' }]],
  });

  await answerCallbackQuery({
    callbackQueryId,
    text: 'О боте',
  });

  return { ok: true, type: 'about' };
}

// Подтверждение INN
async function handleInnConfirm({ callbackQueryId, chatId, userId, userName, messageId, inn, message }) {
  console.log('🔗 Confirming INN:', { inn, chatId, userId });

  try {
    // Получаем информацию о чате
    const chatTitle = message?.chat?.title || `Chat ${chatId}`;
    const chatType = message?.chat?.type || 'private';

    console.log('Chat info:', { chatTitle, chatType });

    const result = await activateTelegramByInn({
      inn,
      telegramChatId: String(chatId),
      telegramChatTitle: chatTitle,
      telegramChatType: chatType,  // ← Добавлено
      userId: String(userId),
      userName,
    });

    console.log('✅ Activation result:', result);

    const text =
      result.status === 'linked'
        ? `✅ <b>Связка активирована!</b>

<b>ИНН:</b> <code>${inn}</code>
<b>Статус:</b> Подключено к Slack

Сообщения будут синхронизироваться автоматически.`
        : `✅ <b>Связка создана!</b>

<b>ИНН:</b> <code>${inn}</code>
<b>Статус:</b> Ожидается Slack

Попросите коллегу из Slack выполнить:
<code>/connect ${inn}</code>

После этого сообщения начнут синхронизироваться.`;

    await editTelegramMessage({
      chatId,
      messageId,
      text,
      keyboard: [[{ text: '🔙 В меню', callback_data: 'back_to_menu' }]],
    });

    await answerCallbackQuery({
      callbackQueryId,
      text: 'Связка создана!',
    });

    clearUserState(userId, chatId);

    return { ok: true, type: 'inn_confirmed', result };

  } catch (error) {
    console.error('❌ INN confirmation error:', error);

    await answerCallbackQuery({
      callbackQueryId,
      text: `Ошибка: ${error.message}`,
      showAlert: true,
    });

    throw error;
  }
}


// Отмена ввода INN
async function handleInnCancel({ callbackQueryId, chatId, userId, messageId }) {
  await handleBackToMenu({ callbackQueryId, chatId, messageId });
  clearUserState(userId, chatId);

  return { ok: true, type: 'inn_cancelled' };
}

// Возврат в главное меню
async function handleBackToMenu({ callbackQueryId, chatId, messageId }) {
  const text = `🏠 <b>Главное меню</b>

Выберите действие:`;

  await editTelegramMessage({
    chatId,
    messageId,
    text,
    keyboard: getMainMenuKeyboard(),
  });

  await answerCallbackQuery({
    callbackQueryId,
    text: 'Главное меню',
  });

  return { ok: true, type: 'back_to_menu' };
}

// Обработка текстового сообщения (ввод INN)
export async function handleUserMessage({ message, userId, userName, chatId, messageText }) {
  const userState = getUserState(userId, chatId);

  // Обработка команды /cancel
  if (messageText === '/cancel') {
    if (userState) {
      clearUserState(userId, chatId);
      await sendTelegramMessageWithKeyboard({
        chatId,
        text: '❌ Операция отменена',
        keyboard: getMainMenuKeyboard(),
      });
      return { ok: true, type: 'cancelled' };
    }
    return { ok: true, type: 'no_operation' };
  }

  // Если пользователь вводит INN
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

    // Показываем подтверждение
    await sendTelegramMessageWithKeyboard({
      chatId,
      text: `Подтвердите активацию связки:\n\n<b>ИНН:</b> <code>${inn}</code>`,
      keyboard: getInnConfirmKeyboard(inn),
    });

    return { ok: true, type: 'inn_entered', inn };
  }

  // Обычное сообщение - пропускаем дальше в bridge
  return { ok: true, type: 'normal_message' };
}
