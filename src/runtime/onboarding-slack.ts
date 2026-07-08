import axios from 'axios';
import * as crypto from 'crypto';

import { env } from '../core/env';
import { SlackUser } from './models';
import { TelegramOnboardingService } from './onboarding-telegram';

// Faithful port of services/onboardingService.js (Slack-DM onboarding + /approve).
const ALLOWED_DOMAINS = ['payme.uz', 'tbcbank.uz'];
const sessionState = new Map<string, string>();

function slackPost(method: string, body: any) {
  return axios.post(`https://slack.com/api/${method}`, body, {
    headers: { Authorization: `Bearer ${env.slackBotToken}`, 'Content-Type': 'application/json' },
  });
}

async function sendDM(channel: string, text: string | null, blocks?: any[]) {
  const payload: any = { channel, text };
  if (blocks) payload.blocks = blocks;
  const res = await slackPost('chat.postMessage', payload);
  if (!res.data.ok) throw new Error(`Slack DM error: ${res.data.error}`);
  return res.data;
}

function generatePassword(length = 12) {
  return crypto.randomBytes(length).toString('base64').slice(0, length);
}

function generateVerificationCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

function isAllowedEmail(email: string) {
  const lower = email.toLowerCase().trim();
  return ALLOWED_DOMAINS.some((d) => lower.endsWith(`@${d}`));
}

async function lookupSlackUserByEmail(email: string) {
  const res = await axios.get('https://slack.com/api/users.lookupByEmail', {
    params: { email },
    headers: { Authorization: `Bearer ${env.slackBotToken}` },
  });
  if (!res.data.ok) return null;
  return res.data.user;
}

export async function handleDirectMessage(event: any) {
  const { channel, user, text } = event;
  if (event.bot_id || event.subtype === 'bot_message') return;

  const state = sessionState.get(channel);

  if (!state) {
    const existing = await SlackUser.findOne({ slackId: user });
    if (existing && existing.status === 'active') {
      await sendDM(channel, `✅ Вы уже зарегистрированы как *${existing.role}*. Добро пожаловать, ${existing.displayName}!`);
      return;
    }
    if (existing && existing.status === 'pending') {
      await sendDM(channel, '⏳ Ваша заявка уже отправлена и ожидает проверки модератора. Мы сообщим вам о решении.');
      return;
    }
    sessionState.set(channel, 'awaiting_email');
    await sendDM(channel, null, [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: '👋 Добро пожаловать в *PaycomConnect*!\n\nДля регистрации введите вашу корпоративную почту:\n`@payme.uz` или `@tbcbank.uz`',
        },
      },
    ]);
    return;
  }

  if (state === 'awaiting_email') {
    const email = (text || '').trim();
    if (!isAllowedEmail(email)) {
      await sendDM(channel, '❌ Неверный формат почты. Принимаются только адреса *@payme.uz* или *@tbcbank.uz*.\nПопробуйте ещё раз:');
      return;
    }
    const slackUser = await lookupSlackUserByEmail(email);
    if (!slackUser) {
      await sendDM(channel, `❌ Пользователь с почтой *${email}* не найден в Slack.\nПроверьте адрес и попробуйте ещё раз:`);
      return;
    }
    const dup = await SlackUser.findOne({ slackId: slackUser.id });
    if (dup) {
      sessionState.delete(channel);
      if (dup.status === 'pending') await sendDM(channel, '⏳ Ваша заявка уже отправлена и ожидает проверки модератора.');
      else await sendDM(channel, `✅ Вы уже зарегистрированы как *${dup.role}*.`);
      return;
    }
    const newUser = await SlackUser.create({
      slackId: slackUser.id,
      email: email.toLowerCase().trim(),
      displayName: slackUser.profile?.real_name || slackUser.name,
      status: 'pending',
      role: null,
    });
    sessionState.set(channel, 'done');
    await sendDM(channel, null, [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `✅ Заявка принята!\n\n*Email:* ${email}\n*Имя:* ${newUser.displayName}\n\nВаша заявка отправлена на проверку модератору. После апрува вы получите уведомление в личку.`,
        },
      },
    ]);
    await notifyOnboardingChannel(newUser, slackUser.id);
    return;
  }

  if (state === 'done') {
    await sendDM(channel, '⏳ Ваша заявка уже на рассмотрении. Ожидайте уведомления.');
  }
}

async function notifyOnboardingChannel(user: any, slackUserId: string) {
  const channelId = env.onboardingChannelId;
  if (!channelId) {
    console.warn('[Onboarding] ONBOARDING_CHANNEL_ID не задан в .env');
    return;
  }
  await sendDM(channelId, null, [
    { type: 'header', text: { type: 'plain_text', text: '🆕 Новый запрос на регистрацию' } },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Имя:*\n${user.displayName}` },
        { type: 'mrkdwn', text: `*Email:*\n${user.email}` },
        { type: 'mrkdwn', text: `*Slack ID:*\n<@${slackUserId}>` },
        { type: 'mrkdwn', text: `*Статус:*\nPending ⏳` },
      ],
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `Для апрува используйте команду:\n\`/approve ${slackUserId} <role>\`\nГде role: \`manager\` | \`integrator\` | \`b2b_support\``,
      },
    },
    { type: 'divider' },
  ]);
}

const VALID_ROLES = ['manager', 'integrator', 'b2b_support'];
const ADMIN_ROLES = ['owner', 'teamlead', 'cx_manager'];

export async function handleApproveCommand({ text, response_url, user_id }: any) {
  const parts = (text || '').trim().split(/\s+/);
  const rawTarget = parts[0] || '';
  const role = parts[1] || '';
  const targetId = rawTarget.replace(/^<@([A-Z0-9]+)(\|[^>]*)?>$/, '$1');

  if (!targetId || !VALID_ROLES.includes(role)) {
    return {
      response_type: 'ephemeral',
      text: `❌ Использование: \`/approve @user role\`\nРоли: \`manager\`, \`integrator\`, \`b2b_support\``,
    };
  }

  const moderator = await SlackUser.findOne({ slackId: user_id });
  if (!moderator || !ADMIN_ROLES.includes(moderator.role)) {
    return {
      response_type: 'ephemeral',
      text: `❌ У вас нет прав для апрува. Только админы (owner, teamlead, cx_manager) могут апрувить заявки.`,
    };
  }

  const user = await SlackUser.findOne({ slackId: targetId });
  if (!user) {
    return {
      response_type: 'ephemeral',
      text: `❌ Пользователь <@${targetId}> не найден в базе. Возможно, он ещё не прошёл регистрацию.`,
    };
  }
  if (user.status === 'active') {
    return { response_type: 'ephemeral', text: `ℹ️ Пользователь <@${targetId}> уже активен с ролью *${user.role}*.` };
  }

  const password = generatePassword();
  const verificationCode = generateVerificationCode();
  const verificationCodeExpiresAt = new Date(Date.now() + 12 * 60 * 60 * 1000);

  user.role = role;
  user.status = 'active';
  user.verificationCode = verificationCode;
  user.verificationCodeExpiresAt = verificationCodeExpiresAt;
  user.verificationCodeUsed = false;
  user.metadata = { ...user.metadata, approvedBy: user_id, approvedAt: new Date(), password };
  await user.save();

  let credentialsDelivered = false;
  let deliveryError = '';
  try {
    const dmRes = await slackPost('conversations.open', { users: targetId });
    if (!dmRes.data.ok) throw new Error(dmRes.data.error ?? 'failed_to_open_dm');
    const dmChannel = dmRes.data.channel.id;
    for (const [ch] of sessionState.entries()) {
      if (ch === dmChannel) sessionState.delete(ch);
    }
    await sendDM(dmChannel, null, [
      { type: 'header', text: { type: 'plain_text', text: '🎉 Ваша заявка одобрена!' } },
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `Добро пожаловать в команду, *${user.displayName}*!\n\nВам назначена роль: *${role}*` },
      },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*Логин (email):*\n\`${user.email}\`` },
          { type: 'mrkdwn', text: `*Пароль:*\n\`${password}\`` },
          { type: 'mrkdwn', text: `*Верификационный код:*\n\`${verificationCode}\`` },
          { type: 'mrkdwn', text: `*Срок действия кода:*\n12 часов` },
        ],
      },
      {
        type: 'context',
        elements: [{ type: 'mrkdwn', text: '🔒 Сохраните эти данные. Код нужно ввести в Telegram для подтверждения регистрации.' }],
      },
    ]);
    credentialsDelivered = true;
  } catch (error: any) {
    deliveryError = error.message;
  }

  const onbCh = env.onboardingChannelId;
  if (onbCh) {
    const deliveryStatus = credentialsDelivered
      ? `📩 Логин, пароль и верификационный код отправлены в личный Slack чат.\n🔐 Код: \`${verificationCode}\` (действителен 12 часов, одноразовый)`
      : `⚠️ Не удалось отправить логин/пароль/код в личку: ${deliveryError}`;
    await sendDM(onbCh, `✅ <@${targetId}> (${user.email}) апрувнут администратором <@${user_id}> с ролью *${role}*.\n${deliveryStatus}`);
  }

  if (!credentialsDelivered) {
    return {
      response_type: 'ephemeral',
      text: `⚠️ Пользователь <@${targetId}> апрувнут, но отправка логина/пароля/кода в личный Slack чат не удалась: ${deliveryError}`,
    };
  }

  if (user.telegramId) {
    try {
      await TelegramOnboardingService.notifyApproved({
        telegramId: user.telegramId,
        displayName: user.displayName,
        role,
        email: user.email,
        password,
        verificationCode,
      });
    } catch (tgError: any) {
      console.warn(`Failed to notify user ${user.telegramId} in Telegram:`, tgError.message);
    }
  }

  return {
    response_type: 'ephemeral',
    text: `✅ Пользователь <@${targetId}> апрувнут с ролью *${role}*. Логин, пароль и верификационный код (действителен 12 часов) отправлены в личный Slack чат.`,
  };
}
