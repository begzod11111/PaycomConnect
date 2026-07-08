import axios from 'axios';

import { env } from '../core/env';
import { SlackUser } from './models';

// Faithful port of services/telegramService.js (with the authorText bug fixed).
const FILE_RETRY_ATTEMPTS = 3;
const FILE_RETRY_DELAY_MS = 700;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withRetry(task: any, { attempts = FILE_RETRY_ATTEMPTS, delayMs = FILE_RETRY_DELAY_MS }: any = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await task(attempt);
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await sleep(delayMs * attempt);
    }
  }
  throw lastError;
}

function extractError(error: any) {
  return error.response?.data?.description ?? error.response?.data?.error ?? error.message;
}

function escapeHtml(value: any) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function renderSlackMentionsToTelegramHtml(text: any) {
  const source = String(text || '');
  const mentionMatches = [...source.matchAll(/<@([A-Z0-9]+)(?:\|[^>]+)?>/g)];
  if (!mentionMatches.length) return escapeHtml(source);

  const slackIds = [...new Set(mentionMatches.map((match) => match[1]))];
  const mappedUsers = await SlackUser.find({
    slackId: { $in: slackIds },
    telegramId: { $exists: true, $ne: null },
  })
    .select('slackId telegramId displayName email')
    .lean();

  const mapBySlackId = new Map(
    mappedUsers.map((item: any) => [
      item.slackId,
      { telegramId: String(item.telegramId), displayName: item.displayName || item.email || item.slackId },
    ]),
  );

  let rendered = source;
  for (const slackId of slackIds) {
    const info: any = mapBySlackId.get(slackId);
    if (info?.telegramId) {
      const tgMention = `<a href="tg://user?id=${info.telegramId}">@${escapeHtml(info.displayName)}</a>`;
      rendered = rendered.replace(new RegExp(`<@${slackId}(?:\\|[^>]+)?>`, 'g'), tgMention);
    }
  }

  const parts = rendered.split(/(<a href="tg:\/\/user\?id=\d+">.*?<\/a>)/g);
  return parts.map((part) => (part.startsWith('<a href="tg://user?id=') ? part : escapeHtml(part))).join('');
}

function formatText(message: any) {
  const body = message.forwardedText || escapeHtml(message.text || '') || '[Сообщение без текста]';
  const normalizedBody = String(body || '').trim();
  const fileSuffix =
    Array.isArray(message.files) && message.files.length
      ? `\n\nВложения: ${message.files.map((file: any) => escapeHtml(file.name || file.type)).join(', ')}`
      : '';
  return `${normalizedBody}${fileSuffix}`;
}

function resolveTelegramMediaType(file: any) {
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

function methodAndFieldByMediaType(mediaType: string) {
  if (mediaType === 'photo') return { method: 'sendPhoto', field: 'photo' };
  if (mediaType === 'video') return { method: 'sendVideo', field: 'video' };
  if (mediaType === 'audio') return { method: 'sendAudio', field: 'audio' };
  if (mediaType === 'voice') return { method: 'sendVoice', field: 'voice' };
  if (mediaType === 'video_note') return { method: 'sendVideoNote', field: 'video_note' };
  return { method: 'sendDocument', field: 'document' };
}

function supportsCaption(mediaType: string) {
  return mediaType !== 'video_note';
}

function getTelegramApiUrl(method: string) {
  if (!env.telegramBotToken) throw new Error('TELEGRAM_BOT_TOKEN is not configured');
  return `https://api.telegram.org/bot${env.telegramBotToken}/${method}`;
}

async function sendSlackFileToTelegram({ file, chatId, caption = '' }: any) {
  const sourceUrl = file.slackPrivateUrl || file.url;
  if (!sourceUrl) throw new Error('Slack file url is missing');

  const fileResponse: any = await withRetry(() =>
    axios.get(sourceUrl, { responseType: 'arraybuffer', headers: { Authorization: `Bearer ${env.slackBotToken}` } }),
  );

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

  const response: any = await withRetry(() => axios.post(getTelegramApiUrl(method), form));
  if (!response.data?.ok) throw new Error(response.data?.description ?? 'Failed to send document');
  return response.data.result?.message_id ?? null;
}

async function downloadSlackFileBinary(file: any) {
  const sourceUrl = file.slackPrivateUrl || file.url;
  if (!sourceUrl) throw new Error('Slack file url is missing');
  const response = await axios.get(sourceUrl, {
    responseType: 'arraybuffer',
    headers: { Authorization: `Bearer ${env.slackBotToken}` },
  });
  const mediaType = resolveTelegramMediaType(file);
  const filename = file.name || `${mediaType}.bin`;
  return { filename, mediaType, binary: response.data };
}

async function sendSlackMediaGroupToTelegram({ files, chatId, caption = '' }: any) {
  const mediaItems: any[] = [];
  const form = new FormData();
  const downloadedFiles = await Promise.all(files.map((file: any) => withRetry(() => downloadSlackFileBinary(file))));

  for (let index = 0; index < downloadedFiles.length; index += 1) {
    const downloaded: any = downloadedFiles[index];
    const attachName = `file${index}`;
    mediaItems.push({
      type: downloaded.mediaType,
      media: `attach://${attachName}`,
      ...(index === 0 && caption ? { caption } : {}),
    });
    form.append(attachName, new Blob([downloaded.binary]), downloaded.filename);
  }

  form.append('chat_id', String(chatId));
  form.append('media', JSON.stringify(mediaItems));

  const response: any = await withRetry(() => axios.post(getTelegramApiUrl('sendMediaGroup'), form));
  if (!response.data?.ok) throw new Error(response.data?.description ?? 'Failed to send media group');
  return response.data.result?.[0]?.message_id ?? null;
}

export async function setTelegramWebhook({ url, secretToken }: any) {
  if (!env.telegramBotToken) throw new Error('TELEGRAM_BOT_TOKEN is required to set webhook');
  const response = await axios.post(getTelegramApiUrl('setWebhook'), {
    url,
    secret_token: secretToken,
    allowed_updates: ['message', 'edited_message', 'channel_post', 'callback_query', 'my_chat_member'],
    drop_pending_updates: false,
  });
  if (!response.data?.ok) throw new Error(`Failed to set Telegram webhook: ${response.data?.description ?? 'Unknown error'}`);
  return { ok: true, url, hasSecretToken: Boolean(secretToken), result: response.data.result };
}

export async function deleteTelegramWebhook() {
  if (!env.telegramBotToken) throw new Error('TELEGRAM_BOT_TOKEN is required');
  const response = await axios.post(getTelegramApiUrl('deleteWebhook'), { drop_pending_updates: false });
  if (!response.data?.ok) throw new Error(`Failed to delete webhook: ${response.data?.description}`);
  return { ok: true, result: response.data.result };
}

export async function getTelegramWebhookInfo() {
  if (!env.telegramBotToken) throw new Error('TELEGRAM_BOT_TOKEN is required');
  const response = await axios.get(getTelegramApiUrl('getWebhookInfo'));
  if (!response.data?.ok) throw new Error(`Failed to get webhook info: ${response.data?.description}`);
  return { ok: true, info: response.data.result };
}

export async function getTelegramBotInfo() {
  if (!env.telegramBotToken) return { ok: false, error: 'TELEGRAM_BOT_TOKEN is not configured' };
  try {
    const response = await axios.get(getTelegramApiUrl('getMe'));
    if (!response.data?.ok) return { ok: false, error: response.data?.description ?? 'Unknown error' };
    return { ok: true, bot: response.data.result };
  } catch (error: any) {
    return { ok: false, error: error.response?.data?.description ?? error.message };
  }
}

export function validateTelegramWebhookSecret(req: any, expectedSecret: string) {
  if (!expectedSecret) return true;
  const receivedSecret = req.headers['x-telegram-bot-api-secret-token'];
  return receivedSecret === expectedSecret;
}

export async function sendTelegramReply({ chatId, text, replyToMessageId }: any) {
  if (!env.telegramBotToken) throw new Error('TELEGRAM_BOT_TOKEN is required');
  const response = await axios.post(getTelegramApiUrl('sendMessage'), {
    chat_id: chatId,
    text,
    reply_to_message_id: replyToMessageId,
  });
  if (!response.data?.ok) throw new Error(`Failed to send message: ${response.data?.description}`);
  return { ok: true, messageId: response.data.result.message_id, result: response.data.result };
}

export async function sendTelegramDocumentByUrl({ chatId, documentUrl, caption = '' }: any) {
  if (!env.telegramBotToken) throw new Error('TELEGRAM_BOT_TOKEN is required');
  const response = await axios.post(getTelegramApiUrl('sendDocument'), { chat_id: chatId, document: documentUrl, caption });
  if (!response.data?.ok) throw new Error(`Failed to send document: ${response.data?.description ?? 'Unknown error'}`);
  return { ok: true, messageId: response.data.result.message_id, result: response.data.result };
}

export async function sendToTelegram(message: any) {
  const chatId = message.destinationChannelId || env.defaultTelegramChatId || message.channelId;

  if (!env.enableLiveForwarding || !env.telegramBotToken || !chatId) {
    return { status: 'mocked', mode: 'mock', target: chatId || 'telegram-chat-not-configured' };
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
    let response: any = null;
    const authorCaption = forwardedText;

    if (!hasFiles) {
      response = await axios.post(getTelegramApiUrl('sendMessage'), {
        chat_id: chatId,
        text: formatText({ ...message, forwardedText }),
        parse_mode: 'HTML',
      });
    }

    if (Array.isArray(message.files) && message.files.length) {
      const photoVideoFiles = message.files.filter((file: any) => {
        const mediaType = resolveTelegramMediaType(file);
        return mediaType === 'photo' || mediaType === 'video';
      });
      const otherFiles = message.files.filter((file: any) => {
        const mediaType = resolveTelegramMediaType(file);
        return mediaType !== 'photo' && mediaType !== 'video';
      });

      let captionSent = false;

      if (photoVideoFiles.length >= 2) {
        try {
          response = await sendSlackMediaGroupToTelegram({ files: photoVideoFiles, chatId, caption: authorCaption });
          captionSent = true;
        } catch (groupError) {
          for (let index = 0; index < photoVideoFiles.length; index += 1) {
            const file = photoVideoFiles[index];
            try {
              const caption = !captionSent && index === 0 ? authorCaption : '';
              response = await sendSlackFileToTelegram({ file, chatId, caption });
              if (caption) captionSent = true;
            } catch (fileError: any) {
              await axios.post(getTelegramApiUrl('sendMessage'), {
                chat_id: chatId,
                text: `⚠️ Не удалось переслать файл: ${file.name || file.type} (${fileError.message})`,
              });
            }
          }
        }
      } else if (photoVideoFiles.length === 1) {
        try {
          response = await sendSlackFileToTelegram({ file: photoVideoFiles[0], chatId, caption: authorCaption });
          captionSent = true;
        } catch (singleMediaError: any) {
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
            response = await axios.post(getTelegramApiUrl('sendMessage'), { chat_id: chatId, text: caption, parse_mode: 'HTML' });
            captionSent = true;
          }
          response = await sendSlackFileToTelegram({ file, chatId, caption });
          if (caption) captionSent = true;
        } catch (fileError: any) {
          await axios.post(getTelegramApiUrl('sendMessage'), {
            chat_id: chatId,
            text: `⚠️ Не удалось переслать файл: ${file.name || file.type} (${fileError.message})`,
          });
        }
      }

      if (!captionSent && !message.text) {
        response = await axios.post(getTelegramApiUrl('sendMessage'), { chat_id: chatId, text: authorCaption, parse_mode: 'HTML' });
      }
    }

    return {
      status: 'sent',
      mode: 'live',
      target: chatId,
      providerMessageId: typeof response === 'number' ? response : response?.data?.result?.message_id ?? null,
    };
  } catch (error) {
    return { status: 'failed', mode: 'live', target: chatId, error: extractError(error) };
  }
}
