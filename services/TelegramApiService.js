/**
 * TelegramApiService
 * Работа с Telegram Bot API: сообщения, файлы, клавиатуры, вебхуки.
 * Все методы — статические.
 */

import axios from 'axios';
import { env } from '../config/env.js';

export class TelegramApiService {
  // ── Internal ────────────────────────────────────────────────────────────────

  static #url(method) {
    if (!env.telegramBotToken) throw new Error('[TelegramApiService] TELEGRAM_BOT_TOKEN not set');
    return `https://api.telegram.org/bot${env.telegramBotToken}/${method}`;
  }

  static async #post(method, body = {}) {
    const res = await axios.post(TelegramApiService.#url(method), body);
    if (!res.data?.ok) {
      throw new Error(`[TelegramApiService] ${method}: ${res.data?.description ?? 'unknown error'}`);
    }
    return res.data.result;
  }

  static async #get(method, params = {}) {
    const res = await axios.get(TelegramApiService.#url(method), { params });
    if (!res.data?.ok) {
      throw new Error(`[TelegramApiService] ${method}: ${res.data?.description ?? 'unknown error'}`);
    }
    return res.data.result;
  }

  // ── Бот ──────────────────────────────────────────────────────────────────────

  /**
   * Получить информацию о боте.
   */
  static async getMe() {
    return TelegramApiService.#get('getMe');
  }

  // ── Вебхук ───────────────────────────────────────────────────────────────────

  /**
   * Установить вебхук.
   * @param {string} url
   * @param {string} [secretToken]
   */
  static async setWebhook(url, secretToken) {
    return TelegramApiService.#post('setWebhook', {
      url,
      secret_token: secretToken,
      allowed_updates: ['message', 'edited_message', 'callback_query', 'channel_post', 'my_chat_member'],
      drop_pending_updates: false,
    });
  }

  /**
   * Удалить вебхук.
   */
  static async deleteWebhook() {
    return TelegramApiService.#post('deleteWebhook', { drop_pending_updates: false });
  }

  /**
   * Получить информацию о текущем вебхуке.
   */
  static async getWebhookInfo() {
    return TelegramApiService.#get('getWebhookInfo');
  }

  // ── Сообщения ────────────────────────────────────────────────────────────────

  /**
   * Отправить текстовое сообщение.
   * @param {string|number} chatId
   * @param {string}        text
   * @param {{ parseMode?: 'HTML'|'Markdown'|'MarkdownV2', replyToMessageId?: number, disablePreview?: boolean }} [opts]
   */
  static async sendMessage(chatId, text, opts = {}) {
    return TelegramApiService.#post('sendMessage', {
      chat_id: chatId,
      text,
      parse_mode: opts.parseMode ?? 'HTML',
      reply_to_message_id: opts.replyToMessageId,
      disable_web_page_preview: opts.disablePreview ?? false,
    });
  }

  /**
   * Отправить сообщение с inline-клавиатурой.
   * @param {string|number} chatId
   * @param {string}        text
   * @param {Array[]}       inlineKeyboard  - массив рядов кнопок
   * @param {{ parseMode?: string, replyToMessageId?: number }} [opts]
   */
  static async sendMessageWithKeyboard(chatId, text, inlineKeyboard, opts = {}) {
    return TelegramApiService.#post('sendMessage', {
      chat_id: chatId,
      text,
      parse_mode: opts.parseMode ?? 'HTML',
      reply_to_message_id: opts.replyToMessageId,
      reply_markup: { inline_keyboard: inlineKeyboard },
    });
  }

  /**
   * Отправить сообщение с reply-клавиатурой (обычные кнопки внизу).
   * @param {string|number} chatId
   * @param {string}        text
   * @param {string[][]}    keyboard  - массив рядов с текстами кнопок
   * @param {{ oneTime?: boolean, resize?: boolean }} [opts]
   */
  static async sendMessageWithReplyKeyboard(chatId, text, keyboard, opts = {}) {
    return TelegramApiService.#post('sendMessage', {
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      reply_markup: {
        keyboard: keyboard.map((row) => row.map((btn) => ({ text: btn }))),
        one_time_keyboard: opts.oneTime ?? true,
        resize_keyboard: opts.resize ?? true,
      },
    });
  }

  /**
   * Убрать reply-клавиатуру.
   * @param {string|number} chatId
   * @param {string}        text
   */
  static async sendMessageRemoveKeyboard(chatId, text) {
    return TelegramApiService.#post('sendMessage', {
      chat_id: chatId,
      text,
      reply_markup: { remove_keyboard: true },
    });
  }

  /**
   * Отредактировать текст сообщения.
   * @param {string|number} chatId
   * @param {number}        messageId
   * @param {string}        text
   * @param {Array[]|null}  [inlineKeyboard]
   */
  static async editMessage(chatId, messageId, text, inlineKeyboard) {
    const payload = {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: 'HTML',
    };
    if (inlineKeyboard) payload.reply_markup = { inline_keyboard: inlineKeyboard };
    return TelegramApiService.#post('editMessageText', payload);
  }

  /**
   * Удалить сообщение.
   * @param {string|number} chatId
   * @param {number}        messageId
   */
  static async deleteMessage(chatId, messageId) {
    return TelegramApiService.#post('deleteMessage', {
      chat_id: chatId,
      message_id: messageId,
    });
  }

  /**
   * Переслать сообщение.
   * @param {string|number} toChatId
   * @param {string|number} fromChatId
   * @param {number}        messageId
   */
  static async forwardMessage(toChatId, fromChatId, messageId) {
    return TelegramApiService.#post('forwardMessage', {
      chat_id: toChatId,
      from_chat_id: fromChatId,
      message_id: messageId,
    });
  }

  // ── Callback Query ────────────────────────────────────────────────────────────

  /**
   * Ответить на callback query (убирает индикатор загрузки на кнопке).
   * @param {string}  callbackQueryId
   * @param {string}  [text]
   * @param {boolean} [showAlert]
   */
  static async answerCallbackQuery(callbackQueryId, text, showAlert = false) {
    return TelegramApiService.#post('answerCallbackQuery', {
      callback_query_id: callbackQueryId,
      text,
      show_alert: showAlert,
    });
  }

  // ── Файлы ────────────────────────────────────────────────────────────────────

  /**
   * Отправить фото.
   * @param {string|number} chatId
   * @param {string}        photoUrlOrFileId
   * @param {string}        [caption]
   */
  static async sendPhoto(chatId, photoUrlOrFileId, caption) {
    return TelegramApiService.#post('sendPhoto', {
      chat_id: chatId,
      photo: photoUrlOrFileId,
      caption,
      parse_mode: 'HTML',
    });
  }

  /**
   * Отправить документ.
   * @param {string|number} chatId
   * @param {string}        documentUrlOrFileId
   * @param {string}        [caption]
   */
  static async sendDocument(chatId, documentUrlOrFileId, caption) {
    return TelegramApiService.#post('sendDocument', {
      chat_id: chatId,
      document: documentUrlOrFileId,
      caption,
      parse_mode: 'HTML',
    });
  }

  /**
   * Получить информацию о файле.
   * @param {string} fileId
   */
  static async getFile(fileId) {
    return TelegramApiService.#get('getFile', { file_id: fileId });
  }

  /**
   * Вернуть прямую ссылку на скачивание файла по fileId.
   * @param {string} fileId
   */
  static async getFileUrl(fileId) {
    const file = await TelegramApiService.getFile(fileId);
    return `https://api.telegram.org/file/bot${env.telegramBotToken}/${file.file_path}`;
  }

  // ── Чаты ─────────────────────────────────────────────────────────────────────

  /**
   * Получить информацию о чате.
   * @param {string|number} chatId
   */
  static async getChat(chatId) {
    return TelegramApiService.#get('getChat', { chat_id: chatId });
  }

  /**
   * Получить участников чата (только для супергрупп/каналов).
   * @param {string|number} chatId
   */
  static async getChatMemberCount(chatId) {
    return TelegramApiService.#get('getChatMemberCount', { chat_id: chatId });
  }

  /**
   * Получить информацию об участнике чата.
   * @param {string|number} chatId
   * @param {number}        userId
   */
  static async getChatMember(chatId, userId) {
    return TelegramApiService.#get('getChatMember', { chat_id: chatId, user_id: userId });
  }
}

