import axios from 'axios';
import dotenv from "dotenv";

dotenv.config();

import { env } from '../config/env.js';
import { SlackUser } from '../models/slackUser.js';

const FILE_RETRY_ATTEMPTS = 3;
const FILE_RETRY_DELAY_MS = 700;

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


function extractError(error) {
  return error.response?.data?.description ?? error.response?.data?.error ?? error.message;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function renderSlackMentionsToTelegramHtml(text) {
  const source = String(text || '');
  const mentionMatches = [...source.matchAll(/<@([A-Z0-9]+)(?:\|[^>]+)?>/g)];
  if (!mentionMatches.length) {
    return escapeHtml(source);
  }

  const slackIds = [...new Set(mentionMatches.map((match) => match[1]))];
  const mappedUsers = await SlackUser.find({
    slackId: { $in: slackIds },
    telegramId: { $exists: true, $ne: null },
  })
    .select('slackId telegramId displayName email')
    .lean();

  const mapBySlackId = new Map(
    mappedUsers.map((item) => [
      item.slackId,
      {
        telegramId: String(item.telegramId),
        displayName: item.displayName || item.email || item.slackId,
      },
    ]),
  );

  let rendered = source;
  for (const slackId of slackIds) {
    const info = mapBySlackId.get(slackId);
    if (info?.telegramId) {
      const tgMention = `<a href="tg://user?id=${info.telegramId}">@${escapeHtml(info.displayName)}</a>`;
      rendered = rendered.replace(new RegExp(`<@${slackId}(?:\\|[^>]+)?>`, 'g'), tgMention);
    }
  }

  // Экранируем только те части, которые не являются уже вставленными <a ...>...</a>
  const parts = rendered.split(/(<a href="tg:\/\/user\?id=\d+">.*?<\/a>)/g);
  return parts
    .map((part) => (part.startsWith('<a href="tg://user?id=') ? part : escapeHtml(part)))
    .join('');
}

function formatText(message) {
  const body = message.forwardedText || escapeHtml(message.text || '') || '[Сообщение без текста]';
  const normalizedBody = String(body || '').trim();

  const fileSuffix = Array.isArray(message.files) && message.files.length
    ? `\n\nВложения: ${message.files.map((file) => escapeHtml(file.name || file.type)).join(', ')}`
    : '';

  return `${normalizedBody}${fileSuffix}`;
}

function composeAuthorBody(authorText, renderedText) {
  const author = String(authorText || '').trim();
  const body = String(renderedText || '').trim();

  if (!author) return body;
  if (!body) return author;
  if (body.startsWith(author)) return body;

  return `${author}\n${body}`;
}

async function sendSlackFileToTelegram({ file, chatId, caption = '' }) {
  const sourceUrl = file.slackPrivateUrl || file.url;
  if (!sourceUrl) {
    throw new Error('Slack file url is missing');
  }

  const fileResponse = await withRetry(() => axios.get(sourceUrl, {
    responseType: 'arraybuffer',
    headers: {
      Authorization: `Bearer ${env.slackBotToken}`,
    },
  }));

  const form = new FormData();
  const filename = file.name || `${file.type || 'file'}.bin`;
  const mediaType = resolveTelegramMediaType(file);
  const { method, field } = methodAndFieldByMediaType(mediaType);

  form.append('chat_id', String(chatId));
  if (caption && supportsCaption(mediaType)) {
    form.append('caption', caption);
    form.append('parse_mode', 'HTML');
  }
  form.append(field, new Blob([fileResponse.data]), filename);

  const response = await withRetry(() => axios.post(getTelegramApiUrl(method), form));
  if (!response.data?.ok) {
    throw new Error(response.data?.description ?? 'Failed to send document');
  }

  return response.data.result?.message_id ?? null;
}

function resolveTelegramMediaType(file) {
  const mime = String(file.mimeType || '').toLowerCase();
  const type = String(file.type || '').toLowerCase();
  const name = String(file.name || '').toLowerCase();
  const width = Number(file.width || 0);
  const height = Number(file.height || 0);

  if (type.includes('video_note') || name.includes('video_note') || (mime === 'video/mp4' && width > 0 && width === height)) return 'video_note';
  if (type.includes('voice') || name.endsWith('.ogg') || name.endsWith('.opus') || mime === 'audio/ogg') return 'voice';

  if (type.includes('photo') || mime.startsWith('image/')) return 'photo';
  if (type.includes('video') || mime.startsWith('video/')) return 'video';
  if (type.includes('audio') || type.includes('voice') || mime.startsWith('audio/')) return 'audio';
  return 'document';
}

function methodAndFieldByMediaType(mediaType) {
  if (mediaType === 'photo') return { method: 'sendPhoto', field: 'photo' };
  if (mediaType === 'video') return { method: 'sendVideo', field: 'video' };
  if (mediaType === 'audio') return { method: 'sendAudio', field: 'audio' };
  if (mediaType === 'voice') return { method: 'sendVoice', field: 'voice' };
  if (mediaType === 'video_note') return { method: 'sendVideoNote', field: 'video_note' };
  return { method: 'sendDocument', field: 'document' };
}

function supportsCaption(mediaType) {
  return mediaType !== 'video_note';
}

async function downloadSlackFileBinary(file) {
  const sourceUrl = file.slackPrivateUrl || file.url;
  if (!sourceUrl) {
    throw new Error('Slack file url is missing');
  }

  const response = await axios.get(sourceUrl, {
    responseType: 'arraybuffer',
    headers: {
      Authorization: `Bearer ${env.slackBotToken}`,
    },
  });

  const mediaType = resolveTelegramMediaType(file);
  const filename = file.name || `${mediaType}.bin`;

  return {
    filename,
    mediaType,
    binary: response.data,
  };
}

async function sendSlackMediaGroupToTelegram({ files, chatId, caption = '' }) {
  const mediaItems = [];
  const form = new FormData();

  const downloadedFiles = await Promise.all(files.map((file) => withRetry(() => downloadSlackFileBinary(file))));

  for (let index = 0; index < downloadedFiles.length; index += 1) {
    const downloaded = downloadedFiles[index];
    const attachName = `file${index}`;

    mediaItems.push({
      type: downloaded.mediaType,
      media: `attach://${attachName}`,
      ...(index === 0 && caption ? { caption } : {}),
    });

    const fieldName = downloaded.mediaType === 'photo'
      ? attachName
      : attachName;
    form.append(fieldName, new Blob([downloaded.binary]), downloaded.filename);
  }

  form.append('chat_id', String(chatId));
  form.append('media', JSON.stringify(mediaItems));

  const response = await withRetry(() => axios.post(getTelegramApiUrl('sendMediaGroup'), form));
  if (!response.data?.ok) {
    throw new Error(response.data?.description ?? 'Failed to send media group');
  }

  return response.data.result?.[0]?.message_id ?? null;
}

function getTelegramApiUrl(method) {
  if (!env.telegramBotToken) {
    throw new Error('TELEGRAM_BOT_TOKEN is not configured');
  }
  return `https://api.telegram.org/bot${env.telegramBotToken}/${method}`;
}

export async function setTelegramWebhook({ url, secretToken }) {
  if (!env.telegramBotToken) {
    throw new Error('TELEGRAM_BOT_TOKEN is required to set webhook');
  }

  const response = await axios.post(getTelegramApiUrl('setWebhook'), {
    url,
    secret_token: secretToken,
    allowed_updates: ['message', 'edited_message', 'channel_post', 'my_chat_member'],
    drop_pending_updates: false,
  });

  if (!response.data?.ok) {
    throw new Error(`Failed to set Telegram webhook: ${response.data?.description ?? 'Unknown error'}`);
  }

  return {
    ok: true,
    url,
    hasSecretToken: Boolean(secretToken),
    result: response.data.result,
  };
}

export async function deleteTelegramWebhook() {
  if (!env.telegramBotToken) {
    throw new Error('TELEGRAM_BOT_TOKEN is required');
  }

  const response = await axios.post(getTelegramApiUrl('deleteWebhook'), {
    drop_pending_updates: false,
  });

  if (!response.data?.ok) {
    throw new Error(`Failed to delete webhook: ${response.data?.description}`);
  }

  return { ok: true, result: response.data.result };
}

export async function getTelegramWebhookInfo() {
  if (!env.telegramBotToken) {
    throw new Error('TELEGRAM_BOT_TOKEN is required');
  }

  const response = await axios.get(getTelegramApiUrl('getWebhookInfo'));

  if (!response.data?.ok) {
    throw new Error(`Failed to get webhook info: ${response.data?.description}`);
  }

  return { ok: true, info: response.data.result };
}

export async function getTelegramBotInfo() {
  if (!env.telegramBotToken) {
    return { ok: false, error: 'TELEGRAM_BOT_TOKEN is not configured' };
  }

  try {
    const response = await axios.get(getTelegramApiUrl('getMe'));
    if (!response.data?.ok) {
      return { ok: false, error: response.data?.description ?? 'Unknown error' };
    }
    return { ok: true, bot: response.data.result };
  } catch (error) {
    return { ok: false, error: error.response?.data?.description ?? error.message };
  }
}

export function validateTelegramWebhookSecret(req, expectedSecret) {
  if (!expectedSecret) {
    return true;
  }
  const receivedSecret = req.headers['x-telegram-bot-api-secret-token'];
  return receivedSecret === expectedSecret;
}

export async function sendTelegramReply({ chatId, text, replyToMessageId }) {
  if (!env.telegramBotToken) {
    throw new Error('TELEGRAM_BOT_TOKEN is required');
  }

  const response = await axios.post(getTelegramApiUrl('sendMessage'), {
    chat_id: chatId,
    text,
    reply_to_message_id: replyToMessageId,
  });

  if (!response.data?.ok) {
    throw new Error(`Failed to send message: ${response.data?.description}`);
  }

  return {
    ok: true,
    messageId: response.data.result.message_id,
    result: response.data.result,
  };
}

export async function sendTelegramDocumentByUrl({ chatId, documentUrl, caption = '' }) {
  if (!env.telegramBotToken) {
    throw new Error('TELEGRAM_BOT_TOKEN is required');
  }

  const response = await axios.post(getTelegramApiUrl('sendDocument'), {
    chat_id: chatId,
    document: documentUrl,
    caption,
  });

  if (!response.data?.ok) {
    throw new Error(`Failed to send document: ${response.data?.description ?? 'Unknown error'}`);
  }

  return {
    ok: true,
    messageId: response.data.result.message_id,
    result: response.data.result,
  };
}



export async function sendToTelegram(message) {
  const chatId = message.destinationChannelId || env.defaultTelegramChatId || message.channelId;

  if (!env.enableLiveForwarding || !env.telegramBotToken || !chatId) {
    return {
      status: 'mocked',
      mode: 'mock',
      target: chatId || 'telegram-chat-not-configured',
    };
  }

  try {
    const renderedText = await renderSlackMentionsToTelegramHtml(message.text || '');
    const authorName = escapeHtml(String(message.userName || ''));
    const forwardedText = authorName && renderedText
      ? `<b>[${authorName}]</b> : ${renderedText}`
      : authorName
        ? `<b>[${authorName}]</b>`
        : renderedText;

    const hasFiles = Array.isArray(message.files) && message.files.length > 0;
    let response = null;
    const authorCaption = forwardedText;

    if (!hasFiles) {
      response = await axios.post(`https://api.telegram.org/bot${env.telegramBotToken}/sendMessage`, {
        chat_id: chatId,
        text: formatText({ ...message, forwardedText }),
        parse_mode: 'HTML',
      });
    }

    // Пересылаем вложения из Slack в Telegram без сохранения на диск
    if (Array.isArray(message.files) && message.files.length) {
      const photoVideoFiles = message.files.filter((file) => {
        const mediaType = resolveTelegramMediaType(file);
        return mediaType === 'photo' || mediaType === 'video';
      });
      const otherFiles = message.files.filter((file) => {
        const mediaType = resolveTelegramMediaType(file);
        return mediaType !== 'photo' && mediaType !== 'video';
      });

      let captionSent = false;

      if (photoVideoFiles.length >= 2) {
        try {
          response = await sendSlackMediaGroupToTelegram({
            files: photoVideoFiles,
            chatId,
            caption: authorCaption,
          });
          captionSent = true;
        } catch (groupError) {
          // Fallback: если альбом не ушёл, отправляем каждый файл по одному,
          // чтобы ни одно вложение не потерялось.
          for (let index = 0; index < photoVideoFiles.length; index += 1) {
            const file = photoVideoFiles[index];
            try {
              const caption = !captionSent && index === 0 ? authorCaption : '';
              response = await sendSlackFileToTelegram({ file, chatId, caption });
              if (caption) {
                captionSent = true;
              }
            } catch (fileError) {
              await axios.post(getTelegramApiUrl('sendMessage'), {
                chat_id: chatId,
                text: `⚠️ Не удалось переслать файл: ${file.name || file.type} (${fileError.message})`,
              });
            }
          }
        }
      } else if (photoVideoFiles.length === 1) {
        try {
          response = await sendSlackFileToTelegram({
            file: photoVideoFiles[0],
            chatId,
            caption: authorCaption,
          });
          captionSent = true;
        } catch (singleMediaError) {
          await axios.post(getTelegramApiUrl('sendMessage'), {
            chat_id: chatId,
            text: `⚠️ Не удалось переслать файл: ${photoVideoFiles[0].name || photoVideoFiles[0].type} (${singleMediaError.message})`,
          });
        }
      }

      for (let index = 0; index < otherFiles.length; index += 1) {
        const file = otherFiles[index];
        try {
          const caption = !captionSent && index === 0 ? authorCaption : '';

          if (caption && !supportsCaption(resolveTelegramMediaType(file))) {
            response = await axios.post(`https://api.telegram.org/bot${env.telegramBotToken}/sendMessage`, {
              chat_id: chatId,
              text: caption,
              parse_mode: 'HTML',
            });
            captionSent = true;
          }

          response = await sendSlackFileToTelegram({ file, chatId, caption });
          if (caption) {
            captionSent = true;
          }
        } catch (fileError) {
          await axios.post(getTelegramApiUrl('sendMessage'), {
            chat_id: chatId,
            text: `⚠️ Не удалось переслать файл: ${file.name || file.type} (${fileError.message})`,
          });
        }
      }

      if (!captionSent && !message.text) {
        // Если по какой-то причине все вложения упали, оставим хотя бы сообщение с автором.
        response = await axios.post(`https://api.telegram.org/bot${env.telegramBotToken}/sendMessage`, {
          chat_id: chatId,
          text: authorText,
          parse_mode: 'HTML',
        });
      }
    }

    return {
      status: 'sent',
      mode: 'live',
      target: chatId,
      providerMessageId: typeof response === 'number'
        ? response
        : response?.data?.result?.message_id ?? null,
    };
  } catch (error) {
    return {
      status: 'failed',
      mode: 'live',
      target: chatId,
      error: extractError(error),
    };
  }
}

// Отправка сообщения с inline клавиатурой
export async function sendTelegramMessageWithKeyboard({ chatId, text, keyboard, replyToMessageId }) {
  if (!env.telegramBotToken) {
    throw new Error('TELEGRAM_BOT_TOKEN is required');
  }

  console.log(`Sending message to Telegram (chatId: ${chatId}, text: ${text}, keyboard: ${JSON.stringify(keyboard)}, replyToMessageId: ${replyToMessageId})`);

  const response = await axios.post(getTelegramApiUrl('sendMessage'), {
    chat_id: chatId,
    text,
    reply_markup: {
      inline_keyboard: keyboard,
    },
    reply_to_message_id: replyToMessageId,
    parse_mode: 'HTML',
  });

  if (!response.data?.ok) {
    throw new Error(`Failed to send message: ${response.data?.description ?? 'Unknown error'}`);
  }

  return {
    ok: true,
    messageId: response.data.result.message_id,
    result: response.data.result,
  };
}

// Ответ на callback query
export async function answerCallbackQuery({ callbackQueryId, text, showAlert = false }) {
  if (!env.telegramBotToken) {
    throw new Error('TELEGRAM_BOT_TOKEN is required');
  }

  const response = await axios.post(getTelegramApiUrl('answerCallbackQuery'), {
    callback_query_id: callbackQueryId,
    text,
    show_alert: showAlert,
  });

  if (!response.data?.ok) {
    throw new Error(`Failed to answer callback: ${response.data?.description ?? 'Unknown error'}`);
  }

  return { ok: true };
}

// Редактирование сообщения
export async function editTelegramMessage({ chatId, messageId, text, keyboard }) {
  if (!env.telegramBotToken) {
    throw new Error('TELEGRAM_BOT_TOKEN is required');
  }

  const payload = {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: 'HTML',
  };

  if (keyboard) {
    payload.reply_markup = {
      inline_keyboard: keyboard,
    };
  }

  const response = await axios.post(getTelegramApiUrl('editMessageText'), payload);

  if (!response.data?.ok) {
    throw new Error(`Failed to edit message: ${response.data?.description ?? 'Unknown error'}`);
  }

  return { ok: true, result: response.data.result };
}

// Удаление сообщения
export async function deleteTelegramMessage({ chatId, messageId }) {
  if (!env.telegramBotToken) {
    throw new Error('TELEGRAM_BOT_TOKEN is required');
  }

  const response = await axios.post(getTelegramApiUrl('deleteMessage'), {
    chat_id: chatId,
    message_id: messageId,
  });

  if (!response.data?.ok) {
    throw new Error(`Failed to delete message: ${response.data?.description ?? 'Unknown error'}`);
  }

  return { ok: true };
}


