#!/usr/bin/env node
// Читает публичный URL из локального ngrok API и настраивает Telegram-webhook на
// <ngrok>/api/telegram/webhook. Используется для тестов ДО реального деплоя.
//
// Требуется: запущенный ngrok (docker compose ... -f docker-compose.ngrok.yml up)
// и TELEGRAM_BOT_TOKEN в .env.
//
// Использование:
//   node ./scripts/ngrok-webhook.mjs            # определить URL и поставить webhook
//   node ./scripts/ngrok-webhook.mjs --print    # только показать публичный URL
//   node ./scripts/ngrok-webhook.mjs --delete   # удалить webhook
//
// Переменные окружения:
//   NGROK_API   — адрес ngrok API (по умолчанию http://127.0.0.1:4040/api/tunnels)
import dotenv from 'dotenv';

dotenv.config();

const NGROK_API = process.env.NGROK_API ?? 'http://127.0.0.1:4040/api/tunnels';
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? '';
const WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET ?? '';
const WEBHOOK_PATH = '/api/telegram/webhook';

async function getPublicUrl() {
  let res;
  try {
    res = await fetch(NGROK_API);
  } catch (error) {
    throw new Error(
      `Не удалось подключиться к ngrok API (${NGROK_API}). Запущен ли ngrok? ${error.message}`,
    );
  }
  if (!res.ok) throw new Error(`ngrok API ответил ${res.status}`);
  const data = await res.json();
  const tunnels = Array.isArray(data?.tunnels) ? data.tunnels : [];
  const https = tunnels.find((t) => String(t.public_url).startsWith('https://'));
  const chosen = https ?? tunnels[0];
  if (!chosen?.public_url) throw new Error('Активных ngrok-туннелей не найдено.');
  return chosen.public_url.replace(/\/+$/, '');
}

async function telegram(method, payload) {
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload ?? {}),
  });
  const data = await res.json();
  if (!data?.ok) throw new Error(`${method} failed: ${data?.description ?? 'unknown error'}`);
  return data.result;
}

async function main() {
  const args = new Set(process.argv.slice(2));

  if (args.has('--delete')) {
    if (!BOT_TOKEN) throw new Error('TELEGRAM_BOT_TOKEN не задан.');
    await telegram('deleteWebhook', { drop_pending_updates: false });
    console.log('✓ Webhook удалён.');
    return;
  }

  const publicUrl = await getPublicUrl();
  const webhookUrl = `${publicUrl}${WEBHOOK_PATH}`;
  console.log(`ngrok public URL: ${publicUrl}`);
  console.log(`webhook URL:      ${webhookUrl}`);

  if (args.has('--print')) return;

  if (!BOT_TOKEN) {
    console.error('\nTELEGRAM_BOT_TOKEN не задан — webhook не установлен. Добавьте токен в .env.');
    process.exit(1);
  }

  await telegram('setWebhook', {
    url: webhookUrl,
    secret_token: WEBHOOK_SECRET || undefined,
    allowed_updates: ['message', 'edited_message', 'channel_post', 'callback_query', 'my_chat_member'],
    drop_pending_updates: false,
  });
  console.log(`✓ Webhook установлен: ${webhookUrl}`);

  const info = await telegram('getWebhookInfo');
  console.log('\ngetWebhookInfo:', JSON.stringify(info, null, 2));
}

main().catch((error) => {
  console.error('Ошибка:', error.message);
  process.exit(1);
});
