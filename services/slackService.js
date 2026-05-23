import axios from 'axios';

import { env } from '../config/env.js';
import { SlackUser } from '../models/slackUser.js';

const FILE_RETRY_ATTEMPTS = 3;
const FILE_RETRY_DELAY_MS = 700;
const FILE_UPLOAD_CONCURRENCY = 2;
const TELEGRAM_AVATAR_CACHE_TTL_MS = 10 * 60 * 1000;
const telegramAvatarCache = new Map();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withRetry(task, { attempts = FILE_RETRY_ATTEMPTS, delayMs = FILE_RETRY_DELAY_MS } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await task(attempt);
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        await sleep(delayMs * attempt);
      }
    }
  }
  throw lastError;
}

async function processWithConcurrency(items, limit, handler) {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length) {
      const item = queue.shift();
      if (!item) break;
      await handler(item);
    }
  });

  await Promise.all(workers);
}

function extractError(error) {
  return error.response?.data?.error ?? error.message;
}

function formatText(message) {
  const header = `*${message.userName}*`;
  const body = message.forwardedText || message.text || '[Сообщение без текста]';
  const fileSuffix = message.files.length ? `\n\nВложения: ${message.files.map((file) => file.name || file.type).join(', ')}` : '';

  return `${header}\n${body}${fileSuffix}`;
}

async function resolveTelegramAvatarUrl(telegramUserId) {
  if (!telegramUserId || !env.telegramBotToken) {
    return '';
  }

  const cacheKey = String(telegramUserId);
  const cached = telegramAvatarCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < TELEGRAM_AVATAR_CACHE_TTL_MS) {
    return cached.url;
  }

  try {
    const photosRes = await axios.get(`https://api.telegram.org/bot${env.telegramBotToken}/getUserProfilePhotos`, {
      params: { user_id: telegramUserId, limit: 1 },
    });

    const firstPhoto = photosRes.data?.result?.photos?.[0];
    const largest = Array.isArray(firstPhoto) && firstPhoto.length ? firstPhoto[firstPhoto.length - 1] : null;
    if (!largest?.file_id) {
      telegramAvatarCache.set(cacheKey, { url: '', ts: Date.now() });
      return '';
    }

    const fileRes = await axios.get(`https://api.telegram.org/bot${env.telegramBotToken}/getFile`, {
      params: { file_id: largest.file_id },
    });

    const filePath = fileRes.data?.result?.file_path;
    if (!filePath) {
      telegramAvatarCache.set(cacheKey, { url: '', ts: Date.now() });
      return '';
    }

    const avatarUrl = `https://api.telegram.org/file/bot${env.telegramBotToken}/${filePath}`;
    telegramAvatarCache.set(cacheKey, { url: avatarUrl, ts: Date.now() });
    return avatarUrl;
  } catch {
    telegramAvatarCache.set(cacheKey, { url: '', ts: Date.now() });
    return '';
  }
}

async function buildSlackMessagePayload(message) {
  const forwardedText = message.forwardedText || message.text || '';
  const defaultText = formatText(message);

  if (message.source !== 'telegram') {
    return { text: defaultText, customizeFields: getSlackCustomizeFields() };
  }

  const tgUsername = message.metadata?.telegramUsername
    ? `@${String(message.metadata.telegramUsername).replace(/^@+/, '')}`
    : '';
  const avatarUrl = await resolveTelegramAvatarUrl(message.userId);

  // Имя и иконка бота — динамические (имя и фото Telegram-пользователя)
  const customizeFields = {
    username: message.userName || env.slackBridgeBotName || 'Telegram User',
  };
  if (avatarUrl) {
    customizeFields.icon_url = avatarUrl;
  } else if (env.slackBridgeBotIconEmoji) {
    customizeFields.icon_emoji = env.slackBridgeBotIconEmoji;
  }

  // Блоки: только подпись с username/telegram и текст
  const blocks = [];

  if (tgUsername) {
    blocks.push({
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `${tgUsername}  •  _Telegram_`,
        },
      ],
    });
  }

  if (forwardedText) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: forwardedText,
      },
    });
  }

  if (Array.isArray(message.files) && message.files.length) {
    blocks.push({
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `📎 Вложения: ${message.files.map((file) => file.name || file.type).join(', ')}`,
        },
      ],
    });
  }

  return {
    text: defaultText,
    blocks: blocks.length ? blocks : undefined,
    customizeFields,
  };
}

function getSlackCustomizeFields() {
  const fields = {};
  if (env.slackBridgeBotName) {
    fields.username = env.slackBridgeBotName;
  }
  if (env.slackBridgeBotIconEmoji) {
    fields.icon_emoji = env.slackBridgeBotIconEmoji;
  }
  return fields;
}

async function resolveIntegratorMentions(connection) {
  const integratorIds = Array.isArray(connection?.integrators) ? connection.integrators : [];
  if (!integratorIds.length) {
    return '';
  }

  const integrators = await SlackUser.find({
    _id: { $in: integratorIds },
    slackId: { $exists: true, $ne: '' },
    status: 'active',
  })
    .select('slackId')
    .lean();

  const mentions = integrators.map((item) => `<@${item.slackId}>`);
  return mentions.length ? mentions.join(' ') : '';
}

async function buildTelegramToSlackText(message) {
  const botTag = String(env.telegramBotName || '').trim();
  const original = String(message.text || '');
  let forwardedText = original;

  if (botTag && forwardedText.includes(botTag)) {
    forwardedText = forwardedText.split(botTag).join('').trim();
    const integratorMentions = await resolveIntegratorMentions(message.connection);
    if (integratorMentions) {
      forwardedText = `${forwardedText}\n\n${integratorMentions}`.trim();
    }
  }

  return forwardedText;
}

async function uploadTelegramFileToSlack({ file, channel }) {
  if (!file.fileId) {
    return null;
  }

  const getFileRes = await withRetry(() => axios.get(`https://api.telegram.org/bot${env.telegramBotToken}/getFile`, {
    params: { file_id: file.fileId },
  }));

  if (!getFileRes.data?.ok || !getFileRes.data?.result?.file_path) {
    throw new Error(`Telegram getFile failed for ${file.fileId}`);
  }

  const filePath = getFileRes.data.result.file_path;
  const downloadUrl = `https://api.telegram.org/file/bot${env.telegramBotToken}/${filePath}`;
  const fileData = await withRetry(() => axios.get(downloadUrl, { responseType: 'arraybuffer' }));

  const fileName = file.name || filePath.split('/').pop() || 'file.bin';

  // 1) Запрашиваем upload URL у Slack
  const getUploadUrlRes = await withRetry(() => axios.post(
    'https://slack.com/api/files.getUploadURLExternal',
    new URLSearchParams({
      filename: fileName,
      length: String(fileData.data.byteLength),
    }),
    {
      headers: {
        Authorization: `Bearer ${env.slackBotToken}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    },
  ));

  if (!getUploadUrlRes.data?.ok) {
    throw new Error(getUploadUrlRes.data?.error ?? 'Slack getUploadURLExternal failed');
  }

  const uploadUrl = getUploadUrlRes.data.upload_url;
  const uploadFileId = getUploadUrlRes.data.file_id;

  // 2) Загружаем бинарник в выданный URL
  await withRetry(() => axios.post(uploadUrl, fileData.data, {
    headers: {
      'Content-Type': file.mimeType || 'application/octet-stream',
    },
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
  }));

  // 3) Коммитим файл в канал
  const response = await withRetry(() => axios.post('https://slack.com/api/files.completeUploadExternal', {
    files: [{ id: uploadFileId, title: fileName }],
    channel_id: channel,
  }, {
    headers: {
      Authorization: `Bearer ${env.slackBotToken}`,
      'Content-Type': 'application/json',
    },
  }));

  if (!response.data?.ok) {
    throw new Error(response.data?.error ?? 'Slack file upload failed');
  }

  return uploadFileId;
}

export async function sendToSlack(message) {
  const channel = message.destinationChannelId || env.defaultSlackChannelId || message.channelId;

  if (!env.enableLiveForwarding || !env.slackBotToken || !channel) {
    return {
      status: 'mocked',
      mode: 'mock',
      target: channel || 'slack-channel-not-configured',
    };
  }

  try {
    const forwardedText = message.source === 'telegram'
      ? await buildTelegramToSlackText(message)
      : message.text;

    const hasFiles = Array.isArray(message.files) && message.files.length > 0;
    const payload = await buildSlackMessagePayload({ ...message, forwardedText });
    const customizeFields = payload.customizeFields ?? getSlackCustomizeFields();
    const baseBody = {
      channel,
      text: payload.text,
      ...(payload.blocks ? { blocks: payload.blocks } : {}),
    };

    let response = await axios.post(
      'https://slack.com/api/chat.postMessage',
      {
        ...baseBody,
        ...customizeFields,
      },
      {
        headers: {
          Authorization: `Bearer ${env.slackBotToken}`,
        },
      },
    );

    // Если нет chat:write.customize, повторяем отправку без username/icon.
    if (!response.data?.ok && response.data?.error === 'missing_scope' && Object.keys(customizeFields).length) {
      response = await axios.post(
        'https://slack.com/api/chat.postMessage',
        baseBody,
        {
          headers: {
            Authorization: `Bearer ${env.slackBotToken}`,
          },
        },
      );
    }

    if (!response.data?.ok) {
      return {
        status: 'failed',
        mode: 'live',
        target: channel,
        error: response.data?.error ?? 'Unknown Slack API error',
      };
    }

    // Пересылаем вложения из Telegram в Slack без сохранения на диск
    if (Array.isArray(message.files) && message.files.length) {
      console.log('[MediaBridge][TG->SL] Start files forwarding:', {
        sourceUser: message.userName,
        targetChannel: channel,
        totalFiles: message.files.length,
      });

      let missingScopeDetected = false;
      let successCount = 0;
      let failedCount = 0;
      await processWithConcurrency(message.files, FILE_UPLOAD_CONCURRENCY, async (file) => {
        try {
          await uploadTelegramFileToSlack({ file, channel });
          successCount += 1;
          console.log('[MediaBridge][TG->SL] File sent:', {
            name: file.name || file.type,
            type: file.type,
          });
        } catch (fileError) {
          failedCount += 1;
          console.warn('[MediaBridge][TG->SL] File send failed:', {
            name: file.name || file.type,
            type: file.type,
            error: fileError.message,
          });

          if (String(fileError.message).includes('missing_scope')) {
            missingScopeDetected = true;
            return;
          }

          await axios.post(
            'https://slack.com/api/chat.postMessage',
            {
              channel,
              text: `⚠️ Не удалось переслать файл: ${file.name || file.type} (${fileError.message})`,
            },
            {
              headers: {
                Authorization: `Bearer ${env.slackBotToken}`,
              },
            },
          );
        }
      });

      if (missingScopeDetected) {
        await axios.post(
          'https://slack.com/api/chat.postMessage',
          {
            channel,
            text: '⚠️ Вложения из Telegram не загружены: у Slack-бота нет scope `files:write`.',
          },
          {
            headers: {
              Authorization: `Bearer ${env.slackBotToken}`,
            },
          },
        );
      }

      console.log('[MediaBridge][TG->SL] Done files forwarding:', {
        sourceUser: message.userName,
        targetChannel: channel,
        totalFiles: message.files.length,
        successCount,
        failedCount,
        missingScopeDetected,
      });
    }

    return {
      status: 'sent',
      mode: 'live',
      target: channel,
      providerMessageId: response.data?.ts ?? null,
    };
  } catch (error) {
    return {
      status: 'failed',
      mode: 'live',
      target: channel,
      error: extractError(error),
    };
  }
}

