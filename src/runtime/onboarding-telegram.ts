import axios from 'axios';

import { env } from '../core/env';
import { SlackUser } from './models';

// Faithful port of services/TelegramOnboardingService.js
const ALLOWED_DOMAINS = ['payme.uz', 'tbcbank.uz'];
const ONBOARDING_SLACK_CHANNEL = env.onboardingChannelId || 'C0ATQNJ153Q';
const TEST_EMAIL_PREFIXES = ['begzod0426_test'];

const sessions = new Map<string, any>();
const telegramOnboardingSessionCleanupInterval = setInterval(() => {
  const cutoff = Date.now() - 30 * 60 * 1000;
  for (const [key, val] of sessions.entries()) {
    if (val.ts < cutoff) sessions.delete(key);
  }
}, 5 * 60 * 1000);
telegramOnboardingSessionCleanupInterval.unref?.();

export class TelegramOnboardingService {
  private static async tgPost(method: string, body: any) {
    const url = `https://api.telegram.org/bot${env.telegramBotToken}/${method}`;
    const res = await axios.post(url, body);
    return res.data;
  }

  private static async sendTg(chatId: any, text: string) {
    return TelegramOnboardingService.tgPost('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML' });
  }

  private static async sendTgWithButtons(chatId: any, text: string, buttons: any[]) {
    return TelegramOnboardingService.tgPost('sendMessage', {
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: buttons },
    });
  }

  static async answerCallback(callbackQueryId: string, text = '') {
    return TelegramOnboardingService.tgPost('answerCallbackQuery', { callback_query_id: callbackQueryId, text });
  }

  static async handleCallback(callbackQuery: any): Promise<boolean> {
    const { id: callbackId, from, data } = callbackQuery;
    const chatId = from.id;
    const telegramId = String(from.id);

    if (data === 'check_status') {
      await TelegramOnboardingService.answerCallback(callbackId);
      const user = await SlackUser.findOne({ telegramId });
      if (!user) {
        await TelegramOnboardingService.sendTg(chatId, `❓ Заявка не найдена. Напишите /start чтобы начать регистрацию.`);
        return true;
      }
      const statusMap: any = {
        pending: `⏳ <b>На рассмотрении</b> — ваша заявка ожидает проверки модератора.`,
        active: `✅ <b>Активна</b> — вы зарегистрированы с ролью <b>${user.role}</b>.`,
        rejected: `❌ <b>Отклонена</b> — обратитесь к администратору.`,
      };
      const statusText = statusMap[user.status] ?? `❓ Неизвестный статус: ${user.status}`;
      await TelegramOnboardingService.sendTgWithButtons(
        chatId,
        `🔖 <b>Статус вашей заявки</b>\n\n👤 ${user.displayName}\n📧 ${user.email}\n\n${statusText}`,
        [[{ text: '🔄 Обновить', callback_data: 'check_status' }]],
      );
      return true;
    }
    return false;
  }

  private static slackHeaders() {
    return { Authorization: `Bearer ${env.slackBotToken}`, 'Content-Type': 'application/json' };
  }

  private static async sendSlack(channel: string, text: string, blocks?: any[]) {
    const payload: any = { channel, text };
    if (blocks?.length) payload.blocks = blocks;
    const res = await axios.post('https://slack.com/api/chat.postMessage', payload, {
      headers: TelegramOnboardingService.slackHeaders(),
    });
    return res.data;
  }

  private static async lookupSlackUser(email: string) {
    const res = await axios.get('https://slack.com/api/users.lookupByEmail', {
      params: { email },
      headers: TelegramOnboardingService.slackHeaders(),
    });
    if (!res.data.ok) return null;
    return res.data.user;
  }

  static isAllowedEmail(email: string) {
    const lower = (email || '').toLowerCase().trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(lower)) return false;
    return ALLOWED_DOMAINS.some((d) => lower.endsWith(`@${d}`));
  }

  static isTestEmail(email: string) {
    const lower = (email || '').toLowerCase().trim();
    return TEST_EMAIL_PREFIXES.some((prefix) => lower.startsWith(prefix));
  }

  private static getSession(telegramId: any) {
    return sessions.get(String(telegramId)) ?? null;
  }

  private static setSession(telegramId: any, step: string, data: any = {}) {
    sessions.set(String(telegramId), { step, data, ts: Date.now() });
  }

  private static clearSession(telegramId: any) {
    sessions.delete(String(telegramId));
  }

  static async handleStart({ chatId, userId, userName }: any) {
    const telegramId = String(userId);
    const existing = await SlackUser.findOne({ telegramId });

    if (existing) {
      if (existing.status === 'active') {
        await TelegramOnboardingService.sendTg(
          chatId,
          `👋 С возвращением, <b>${existing.displayName}</b>!\n\nВы уже зарегистрированы с ролью <b>${existing.role}</b>.`,
        );
        return { ok: true, step: 'already_active' };
      }
      if (existing.status === 'pending') {
        await TelegramOnboardingService.sendTgWithButtons(
          chatId,
          `⏳ Ваша заявка уже отправлена и ожидает проверки модератора.\nМы сообщим вам о решении в этом чате.`,
          [[{ text: '🔍 Проверить статус заявки', callback_data: 'check_status' }]],
        );
        return { ok: true, step: 'already_pending' };
      }
    }

    TelegramOnboardingService.setSession(telegramId, 'awaiting_email', { chatId, userName });
    await TelegramOnboardingService.sendTg(
      chatId,
      `👋 Добро пожаловать в <b>PaycomConnect</b>!\n\nЭто корпоративный ресурс для сотрудников <b>Payme</b>.\nДля регистрации введите вашу корпоративную почту.\n\n📧 Формат: <code>name@payme.uz</code>`,
    );
    return { ok: true, step: 'awaiting_email' };
  }

  static async handleMessage({ chatId, userId, userName, text }: any) {
    const telegramId = String(userId);
    const session = TelegramOnboardingService.getSession(telegramId);
    if (!session) return { handled: false };

    if (session.step === 'awaiting_email') {
      await TelegramOnboardingService.processEmail({ chatId, userId, userName, email: text.trim() });
      return { handled: true };
    }
    if (session.step === 'awaiting_verification_code') {
      await TelegramOnboardingService.processVerificationCode({ chatId, userId, verificationCode: text.trim() });
      return { handled: true };
    }
    if (session.step === 'done') {
      await TelegramOnboardingService.sendTg(chatId, `⏳ Ваша регистрация завершена. Вы можете начинать работу!`);
      return { handled: true };
    }
    return { handled: false };
  }

  static async notifyApproved({ telegramId, displayName, role, email, password, verificationCode }: any) {
    if (!telegramId) return;
    TelegramOnboardingService.setSession(telegramId, 'awaiting_verification_code', { email, role });
    await TelegramOnboardingService.sendTg(
      telegramId,
      `🎉 <b>Ваша заявка одобрена!</b>\n\nДобро пожаловать, <b>${displayName}</b>!\nВам назначена роль: <b>${role}</b>\n\n🔐 <b>Данные для входа:</b>\nЛогин: <code>${email}</code>\nПароль: <code>${password}</code>\n\n✅ <b>Для завершения регистрации:</b>\nНапишите 6-значный верификационный код из личного Slack-чата (действителен 12 часов).`,
    );
  }

  private static async processEmail({ chatId, userId, userName, email }: any) {
    const telegramId = String(userId);
    try {
      const existingByEmail = await SlackUser.findOne({ email: email.toLowerCase() });
      if (existingByEmail) {
        TelegramOnboardingService.clearSession(telegramId);
        const msg =
          existingByEmail.status === 'active'
            ? `✅ Этот email уже зарегистрирован и активен.`
            : `⏳ Заявка с этим email уже существует и ожидает проверки.`;
        await TelegramOnboardingService.sendTg(chatId, msg);
        return;
      }

      let slackUser: any;
      const isTest = TelegramOnboardingService.isTestEmail(email);
      if (isTest) {
        slackUser = {
          id: `TEST_${email.replace(/[^a-z0-9]/gi, '_').toUpperCase()}`,
          name: email.split('@')[0],
          profile: { real_name: `Test User (${email})` },
        };
      } else {
        slackUser = await TelegramOnboardingService.lookupSlackUser(email);
      }

      if (!slackUser) {
        await TelegramOnboardingService.sendTg(
          chatId,
          `❌ <b>ОШИБКА:</b> Пользователь с почтой <code>${email}</code> не найден в Slack workspace.\n\nУбедитесь что:\n• Email написан верно\n• Вы добавлены в Slack workspace\n\nПопробуйте ещё раз:`,
        );
        return;
      }

      const newUser = await SlackUser.create({
        slackId: slackUser.id,
        telegramId,
        email: email.toLowerCase().trim(),
        displayName: slackUser.profile?.real_name || slackUser.real_name || userName,
        status: 'pending',
        role: null,
      });

      TelegramOnboardingService.setSession(telegramId, 'done', { email });
      await TelegramOnboardingService.sendTgWithButtons(
        chatId,
        `✅ <b>ЗАЯВКА УСПЕШНО ПРИНЯТА</b>\n\nСпасибо, <b>${newUser.displayName}</b>!\nВаша заявка на регистрацию принята и обрабатывается.\n\n📧 Email: <code>${email}</code>\n🔖 Статус: ⏳ На рассмотрении у модератора\n\n⏱️ Мы свяжемся с вами в этом чате с логином и паролем после апрува.`,
        [[{ text: '🔍 Проверить статус заявки', callback_data: 'check_status' }]],
      );

      await TelegramOnboardingService.notifySlackPendingUser({ user: newUser, slackUserId: slackUser.id });
      return { ok: true, status: 'created' };
    } catch (error: any) {
      console.error('[TelegramOnboardingService] Error processing email:', error);
      await TelegramOnboardingService.sendTg(
        chatId,
        `❌ <b>ОШИБКА ОБРАБОТКИ</b>\n\nПри обработке вашей заявки произошла ошибка системы.\nПожалуйста, попробуйте позже или обратитесь к администратору.\n\nОшибка: <code>${error.message}</code>`,
      );
      return { ok: false, error: error.message };
    }
  }

  private static async notifySlackPendingUser({ user, slackUserId }: any) {
    const isTest = TelegramOnboardingService.isTestEmail(user.email);
    const displaySlack = isTest ? `_тестовый аккаунт_` : `<@${slackUserId}>`;
    await TelegramOnboardingService.sendSlack(
      ONBOARDING_SLACK_CHANNEL,
      `🆕 Новая заявка на регистрацию от ${user.displayName}`,
      [
        { type: 'header', text: { type: 'plain_text', text: '🆕 Новая заявка на регистрацию' } },
        {
          type: 'section',
          fields: [
            { type: 'mrkdwn', text: `*Имя:*\n${user.displayName}` },
            { type: 'mrkdwn', text: `*Email:*\n${user.email}` },
            { type: 'mrkdwn', text: `*Slack:*\n${displaySlack}` },
            { type: 'mrkdwn', text: `*Telegram:*\n${user.telegramId}${isTest ? '  🧪 тест' : ''}` },
          ],
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*Для апрува* используйте команду в формате:\n/approve ${slackUserId} manager\n\nДоступные роли: manager, integrator, b2b_support`,
          },
        },
        { type: 'divider' },
      ],
    );
  }

  private static async processVerificationCode({ chatId, userId, verificationCode }: any) {
    const telegramId = String(userId);
    try {
      const user = await SlackUser.findOne({ telegramId });
      if (!user) {
        await TelegramOnboardingService.sendTg(chatId, `❌ Пользователь не найден. Попробуйте повторить регистрацию.`);
        TelegramOnboardingService.clearSession(telegramId);
        return;
      }
      if (!user.verificationCode) {
        await TelegramOnboardingService.sendTg(
          chatId,
          `❌ <b>ОШИБКА:</b> Верификационный код не установлен. Пожалуйста, обратитесь к администратору.`,
        );
        return;
      }
      if (user.verificationCodeExpiresAt && new Date() > user.verificationCodeExpiresAt) {
        await TelegramOnboardingService.sendTg(
          chatId,
          `❌ <b>КОД ИСТЁК</b>\nВерификационный код больше не действителен (истекла 12-часовая давность). Обратитесь к администратору для повторного апрува.`,
        );
        TelegramOnboardingService.clearSession(telegramId);
        return;
      }
      if (user.verificationCodeUsed) {
        await TelegramOnboardingService.sendTg(chatId, `❌ Этот код уже был использован. Регистрация завершена.`);
        TelegramOnboardingService.setSession(telegramId, 'done');
        return;
      }
      if (verificationCode !== user.verificationCode) {
        await TelegramOnboardingService.sendTg(
          chatId,
          `❌ <b>НЕВЕРНЫЙ КОД</b>\nПроверьте и попробуйте ещё раз (осталось попыток: ∞).`,
        );
        return;
      }

      user.verificationCodeUsed = true;
      await user.save();
      TelegramOnboardingService.setSession(telegramId, 'done');
      await TelegramOnboardingService.sendTg(
        chatId,
        `✅ <b>РЕГИСТРАЦИЯ ЗАВЕРШЕНА!</b>\n\nВас приветствует система <b>PaycomConnect</b>.\nВаша роль: <b>${user.role}</b>\n\n🎉 Добро пожаловать! Теперь вы можете начинать работу.`,
      );
      return { ok: true, status: 'verified' };
    } catch (error: any) {
      console.error('[TelegramOnboardingService] Error processing verification code:', error);
      await TelegramOnboardingService.sendTg(
        chatId,
        `❌ <b>ОШИБКА ОБРАБОТКИ</b>\n\nПри проверке кода произошла ошибка. Обратитесь к администратору.\n\nОшибка: <code>${error.message}</code>`,
      );
      return { ok: false, error: error.message };
    }
  }
}
