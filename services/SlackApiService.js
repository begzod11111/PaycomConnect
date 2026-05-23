/**
 * SlackApiService
 * Работа со Slack API: каналы, пользователи, сообщения.
 * Все методы — статические.
 */

import axios from 'axios';
import { env } from '../config/env.js';

export class SlackApiService {
  // ── Internal ────────────────────────────────────────────────────────────────

  static #baseUrl = 'https://slack.com/api';

  static #headers() {
    return {
      Authorization: `Bearer ${env.slackBotToken}`,
      'Content-Type': 'application/json',
    };
  }

  static async #post(method, body = {}) {
    const res = await axios.post(`${SlackApiService.#baseUrl}/${method}`, body, {
      headers: SlackApiService.#headers(),
    });
    return res.data;
  }

  static async #get(method, params = {}) {
    const res = await axios.get(`${SlackApiService.#baseUrl}/${method}`, {
      params,
      headers: SlackApiService.#headers(),
    });
    return res.data;
  }

  static #assertOk(data, context) {
    if (!data.ok) throw new Error(`[SlackApiService] ${context}: ${data.error ?? 'unknown error'}`);
    return data;
  }

  // ── Каналы ──────────────────────────────────────────────────────────────────

  /**
   * Создать приватный канал.
   * @param {string} name - Название канала (без #)
   * @returns {object} channel
   */
  static async createPrivateChannel(name) {
    const data = await SlackApiService.#post('conversations.create', {
      name,
      is_private: true,
    });
    return SlackApiService.#assertOk(data, 'createPrivateChannel').channel;
  }

  /**
   * Получить информацию о канале.
   * @param {string} channelId
   */
  static async getChannel(channelId) {
    const data = await SlackApiService.#get('conversations.info', { channel: channelId });
    return SlackApiService.#assertOk(data, 'getChannel').channel;
  }

  /**
   * Список каналов воркспейса.
   * @param {{ types?: string, limit?: number }} opts
   * types: 'public_channel' | 'private_channel' | 'mpim' | 'im'
   */
  static async listChannels({ types = 'private_channel', limit = 100 } = {}) {
    const data = await SlackApiService.#get('conversations.list', { types, limit });
    return SlackApiService.#assertOk(data, 'listChannels').channels;
  }

  /**
   * Пригласить пользователей в канал.
   * @param {string} channelId
   * @param {string[]} userIds
   */
  static async inviteToChannel(channelId, userIds) {
    const data = await SlackApiService.#post('conversations.invite', {
      channel: channelId,
      users: userIds.join(','),
    });
    return SlackApiService.#assertOk(data, 'inviteToChannel').channel;
  }

  /**
   * Исключить пользователя из канала.
   * @param {string} channelId
   * @param {string} userId
   */
  static async kickFromChannel(channelId, userId) {
    const data = await SlackApiService.#post('conversations.kick', {
      channel: channelId,
      user: userId,
    });
    return SlackApiService.#assertOk(data, 'kickFromChannel');
  }

  /**
   * Переименовать канал.
   * @param {string} channelId
   * @param {string} newName
   */
  static async renameChannel(channelId, newName) {
    const data = await SlackApiService.#post('conversations.rename', {
      channel: channelId,
      name: newName,
    });
    return SlackApiService.#assertOk(data, 'renameChannel').channel;
  }

  /**
   * Установить тему канала.
   * @param {string} channelId
   * @param {string} topic
   */
  static async setChannelTopic(channelId, topic) {
    const data = await SlackApiService.#post('conversations.setTopic', {
      channel: channelId,
      topic,
    });
    return SlackApiService.#assertOk(data, 'setChannelTopic');
  }

  /**
   * Установить описание канала (purpose).
   * @param {string} channelId
   * @param {string} purpose
   */
  static async setChannelPurpose(channelId, purpose) {
    const data = await SlackApiService.#post('conversations.setPurpose', {
      channel: channelId,
      purpose,
    });
    return SlackApiService.#assertOk(data, 'setChannelPurpose');
  }

  /**
   * Архивировать канал.
   * @param {string} channelId
   */
  static async archiveChannel(channelId) {
    const data = await SlackApiService.#post('conversations.archive', { channel: channelId });
    return SlackApiService.#assertOk(data, 'archiveChannel');
  }

  /**
   * Разархивировать канал.
   * @param {string} channelId
   */
  static async unarchiveChannel(channelId) {
    const data = await SlackApiService.#post('conversations.unarchive', { channel: channelId });
    return SlackApiService.#assertOk(data, 'unarchiveChannel');
  }

  /**
   * Получить список участников канала.
   * @param {string} channelId
   */
  static async getChannelMembers(channelId) {
    const data = await SlackApiService.#get('conversations.members', { channel: channelId });
    return SlackApiService.#assertOk(data, 'getChannelMembers').members;
  }

  // ── Сообщения ───────────────────────────────────────────────────────────────

  /**
   * Отправить сообщение в канал / DM.
   * @param {string} channel
   * @param {string} text
   * @param {Array}  [blocks]
   */
  static async sendMessage(channel, text, blocks) {
    const payload = { channel, text };
    if (blocks?.length) payload.blocks = blocks;

    if (env.slackBridgeBotName) {
      payload.username = env.slackBridgeBotName;
    }
    if (env.slackBridgeBotIconEmoji) {
      payload.icon_emoji = env.slackBridgeBotIconEmoji;
    }

    let data = await SlackApiService.#post('chat.postMessage', payload);

    // Если нет chat:write.customize, пробуем отправить без username/icon.
    if (!data.ok && data.error === 'missing_scope' && (payload.username || payload.icon_emoji)) {
      const fallbackPayload = { channel, text };
      if (blocks?.length) fallbackPayload.blocks = blocks;
      data = await SlackApiService.#post('chat.postMessage', fallbackPayload);
    }

    return SlackApiService.#assertOk(data, 'sendMessage');
  }

  /**
   * Обновить существующее сообщение.
   * @param {string} channel
   * @param {string} ts       - timestamp сообщения
   * @param {string} text
   * @param {Array}  [blocks]
   */
  static async updateMessage(channel, ts, text, blocks) {
    const payload = { channel, ts, text };
    if (blocks?.length) payload.blocks = blocks;
    const data = await SlackApiService.#post('chat.update', payload);
    return SlackApiService.#assertOk(data, 'updateMessage');
  }

  /**
   * Удалить сообщение.
   * @param {string} channel
   * @param {string} ts
   */
  static async deleteMessage(channel, ts) {
    const data = await SlackApiService.#post('chat.delete', { channel, ts });
    return SlackApiService.#assertOk(data, 'deleteMessage');
  }

  /**
   * Открыть DM-канал с пользователем и вернуть channelId.
   * @param {string} userId
   */
  static async openDirectMessage(userId) {
    const data = await SlackApiService.#post('conversations.open', { users: userId });
    return SlackApiService.#assertOk(data, 'openDirectMessage').channel.id;
  }

  /**
   * Отправить личное сообщение пользователю.
   * @param {string} userId
   * @param {string} text
   * @param {Array}  [blocks]
   */
  static async sendDirectMessage(userId, text, blocks) {
    const channelId = await SlackApiService.openDirectMessage(userId);
    return SlackApiService.sendMessage(channelId, text, blocks);
  }

  // ── Пользователи ────────────────────────────────────────────────────────────

  /**
   * Найти пользователя Slack по email.
   * @param {string} email
   * @returns {object|null} user или null если не найден
   */
  static async lookupUserByEmail(email) {
    const data = await SlackApiService.#get('users.lookupByEmail', { email });
    if (!data.ok) return null;
    return data.user;
  }

  /**
   * Получить информацию о пользователе по slackId.
   * @param {string} userId
   */
  static async getUserInfo(userId) {
    const data = await SlackApiService.#get('users.info', { user: userId });
    return SlackApiService.#assertOk(data, 'getUserInfo').user;
  }

  /**
   * Список всех пользователей воркспейса.
   * @param {number} [limit=200]
   */
  static async listUsers(limit = 200) {
    const data = await SlackApiService.#get('users.list', { limit });
    return SlackApiService.#assertOk(data, 'listUsers').members;
  }
}

