#!/usr/bin/env node
// Настройка Telegram-бота: команды, описание, короткое описание и (опционально) webhook.
//
// Требуется TELEGRAM_BOT_TOKEN в окружении (или в .env).
// Использование:
//   node ./scripts/setup-telegram.js               # команды + описания
//   node ./scripts/setup-telegram.js --webhook      # + установить webhook из TELEGRAM_WEBHOOK_URL
//   node ./scripts/setup-telegram.js --info         # только показать текущее состояние
//
// Тексты команд/описаний можно править прямо здесь, в блоках ниже.
import axios from 'axios';

import { env } from '../config/env.js';

// ── Что показывать в меню бота ───────────────────────────────────────────────
// Команды в личке (регистрация/онбординг).
const PRIVATE_COMMANDS = [
  { command: 'start', description: 'Регистрация и помощь' },
];

// Команды в группах (мост Telegram ↔ Slack).
const GROUP_COMMANDS = [
  { command: 'connect', description: 'Активировать связку: /connect <ИНН> <JIRA-KEY>' },
];

const BOT_SHORT_DESCRIPTION = 'PaycomConnect — мост между Telegram и Slack для поддержки клиентов.';
const BOT_DESCRIPTION =
  'PaycomConnect связывает Telegram-группу клиента со Slack-каналом команды Payme. ' +
  'Менеджеры активируют связку командой /connect <ИНН> <JIRA-KEY>, после чего сообщения ' +
  'пересылаются между площадками автоматически.';

function apiUrl(method) {
  return `https://api.telegram.org/bot${env.telegramBotToken}/${method}`;
}

async function call(method, payload) {
  const response = await axios.post(apiUrl(method), payload);
  if (!response.data?.ok) {
    throw new Error(`${method} failed: ${response.data?.description ?? 'unknown error'}`);
  }
  return response.data.result;
}

async function showInfo() {
  const me = await axios.get(apiUrl('getMe'));
  console.log('Bot:', me.data?.result?.username ? `@${me.data.result.username}` : me.data?.result);

  const webhook = await axios.get(apiUrl('getWebhookInfo'));
  console.log('Webhook:', JSON.stringify(webhook.data?.result, null, 2));
}

async function main() {
  const args = new Set(process.argv.slice(2));

  if (!env.telegramBotToken) {
    console.error('TELEGRAM_BOT_TOKEN is not set. Add it to your environment or .env and retry.');
    process.exit(1);
  }

  if (args.has('--info')) {
    await showInfo();
    return;
  }

  await call('setMyCommands', {
    commands: PRIVATE_COMMANDS,
    scope: { type: 'all_private_chats' },
  });
  console.log('✓ Private-chat commands set:', PRIVATE_COMMANDS.map((c) => `/${c.command}`).join(', '));

  await call('setMyCommands', {
    commands: GROUP_COMMANDS,
    scope: { type: 'all_group_chats' },
  });
  console.log('✓ Group-chat commands set:', GROUP_COMMANDS.map((c) => `/${c.command}`).join(', '));

  await call('setMyShortDescription', { short_description: BOT_SHORT_DESCRIPTION });
  console.log('✓ Short description set');

  await call('setMyDescription', { description: BOT_DESCRIPTION });
  console.log('✓ Description set');

  if (args.has('--webhook')) {
    if (!env.telegramWebhookUrl) {
      console.error('TELEGRAM_WEBHOOK_URL is not set; skipping webhook setup.');
    } else {
      await call('setWebhook', {
        url: env.telegramWebhookUrl,
        secret_token: env.telegramWebhookSecret || undefined,
        allowed_updates: ['message', 'edited_message', 'channel_post', 'callback_query', 'my_chat_member'],
        drop_pending_updates: false,
      });
      console.log(`✓ Webhook set to ${env.telegramWebhookUrl}`);
    }
  }

  console.log('\nDone. Run with --info to verify.');
}

main().catch((error) => {
  console.error('Setup failed:', error.message);
  process.exit(1);
});
