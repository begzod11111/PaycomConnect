import axios from 'axios';

import { env } from '../core/env';

// Faithful port of services/SlackApiService.js
export class SlackApiService {
  static baseUrl = 'https://slack.com/api';

  private static headers() {
    return { Authorization: `Bearer ${env.slackBotToken}`, 'Content-Type': 'application/json' };
  }

  private static async post(method: string, body: any = {}) {
    const res = await axios.post(`${SlackApiService.baseUrl}/${method}`, body, {
      headers: SlackApiService.headers(),
    });
    return res.data;
  }

  private static async get(method: string, params: any = {}) {
    const res = await axios.get(`${SlackApiService.baseUrl}/${method}`, {
      params,
      headers: SlackApiService.headers(),
    });
    return res.data;
  }

  private static assertOk(data: any, context: string) {
    if (!data.ok) throw new Error(`[SlackApiService] ${context}: ${data.error ?? 'unknown error'}`);
    return data;
  }

  static async createPrivateChannel(name: string) {
    const data = await SlackApiService.post('conversations.create', { name, is_private: true });
    return SlackApiService.assertOk(data, 'createPrivateChannel').channel;
  }

  static async inviteToChannel(channelId: string, userIds: string[]) {
    const data = await SlackApiService.post('conversations.invite', {
      channel: channelId,
      users: userIds.join(','),
    });
    return SlackApiService.assertOk(data, 'inviteToChannel').channel;
  }

  static async archiveChannel(channelId: string) {
    const data = await SlackApiService.post('conversations.archive', { channel: channelId });
    return SlackApiService.assertOk(data, 'archiveChannel');
  }

  static async getChannelMembers(channelId: string) {
    const data = await SlackApiService.get('conversations.members', { channel: channelId });
    return SlackApiService.assertOk(data, 'getChannelMembers').members;
  }

  static async sendMessage(channel: string, text: string, blocks?: any[]) {
    const payload: any = { channel, text };
    if (blocks?.length) payload.blocks = blocks;
    if (env.slackBridgeBotName) payload.username = env.slackBridgeBotName;
    if (env.slackBridgeBotIconEmoji) payload.icon_emoji = env.slackBridgeBotIconEmoji;

    let data = await SlackApiService.post('chat.postMessage', payload);
    if (!data.ok && data.error === 'missing_scope' && (payload.username || payload.icon_emoji)) {
      const fallbackPayload: any = { channel, text };
      if (blocks?.length) fallbackPayload.blocks = blocks;
      data = await SlackApiService.post('chat.postMessage', fallbackPayload);
    }
    return SlackApiService.assertOk(data, 'sendMessage');
  }

  static async openDirectMessage(userId: string) {
    const data = await SlackApiService.post('conversations.open', { users: userId });
    return SlackApiService.assertOk(data, 'openDirectMessage').channel.id;
  }

  static async sendDirectMessage(userId: string, text: string, blocks?: any[]) {
    const channelId = await SlackApiService.openDirectMessage(userId);
    return SlackApiService.sendMessage(channelId, text, blocks);
  }

  static async lookupUserByEmail(email: string) {
    const data = await SlackApiService.get('users.lookupByEmail', { email });
    if (!data.ok) return null;
    return data.user;
  }

  static async getUserInfo(userId: string) {
    const data = await SlackApiService.get('users.info', { user: userId });
    return SlackApiService.assertOk(data, 'getUserInfo').user;
  }

  static async listUsers(limit = 200) {
    const data = await SlackApiService.get('users.list', { limit });
    return SlackApiService.assertOk(data, 'listUsers').members;
  }
}
