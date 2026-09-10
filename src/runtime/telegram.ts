import axios from 'axios';

import { env } from '../core/env';
import {
  escapeTelegramHtml,
  extractSlackMentionIds,
  slackTextToTelegramHtml,
  TelegramMentionInfo,
} from './message-format';
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

// Convert Slack message text to Telegram HTML: resolve `<@U..>` mentions to real
// Telegram user links where possible, and translate links/channels/commands.
async function renderSlackMentionsToTelegramHtml(text: any) {
  const source = String(text || '');
  const slackIds = extractSlackMentionIds(source);
  const mentions = new Map<string, TelegramMentionInfo>();

  if (slackIds.length) {
    const mappedUsers = await SlackUser.find({
      slackId: { $in: slackIds },
      telegramId: { $exists: true, $ne: null },
    })
      .select('slackId telegramId displayName email')
      .lean();

    for (const item of mappedUsers as any[]) {
      mentions.set(item.slackId, {
        telegramId: String(item.telegramId),
        displayName: item.displayName || item.email || item.slackId,
      });
    }
  }

  return slackTextToTelegramHtml(source, mentions);
}

function formatText(message: any) {
  const body = message.forwardedText || escapeTelegramHtml(message.text || '') || '[Сообщение без текста]';
  const normalizedBody = String(body || '').trim();
  const fileSuffix =
    Array.isArray(message.files) && message.files.length
      ? `\n\nВложения: ${message.files.map((file: any) => escapeTelegramHtml(file.name || file.type)).join(', ')}`
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

const activeSyncBuffers = new Set<string>();

export function isActiveSyncBufferChat(chatId: unknown): boolean {
  const id = String(chatId ?? '');
  if (!id) return false;
  if (env.telegramSyncChatId && id === String(env.telegramSyncChatId)) return true;
  return activeSyncBuffers.has(id);
}

export function registerSyncBufferChat(chatId: string) {
  const id = String(chatId ?? '').trim();
  if (id) activeSyncBuffers.add(id);
}

export function unregisterSyncBufferChat(chatId: string) {
  activeSyncBuffers.delete(String(chatId ?? ''));
}

function reconstructTelegramMessageFromForward(forwarded: any, sourceChatId: string, originalMessageId: number) {
  const origin = forwarded?.forward_origin || {};
  const from =
    forwarded?.forward_from ||
    origin.sender_user ||
    (origin.type === 'hidden_user' ? { first_name: origin.sender_user_name || 'Telegram user' } : null);
  const senderChat =
    forwarded?.forward_from_chat ||
    origin.sender_chat ||
    (origin.sender_chat_id ? { id: origin.sender_chat_id } : null);
  const mediaKeys = [
    'photo',
    'document',
    'video',
    'audio',
    'voice',
    'sticker',
    'animation',
    'video_note',
    'contact',
    'location',
    'venue',
    'poll',
    'dice',
  ];
  const reconstructed: any = {
    message_id: originalMessageId,
    from,
    sender_chat: senderChat,
    chat: { id: sourceChatId },
    date: origin.date || forwarded?.forward_date || forwarded?.date,
    text: forwarded?.text,
    caption: forwarded?.caption,
    entities: forwarded?.entities,
    caption_entities: forwarded?.caption_entities,
  };
  for (const key of mediaKeys) {
    if (forwarded?.[key]) reconstructed[key] = forwarded[key];
  }
  return reconstructed;
}

export async function fetchTelegramMessageById({
  fromChatId,
  messageId,
  bufferChatId,
}: {
  fromChatId: string;
  messageId: number;
  bufferChatId: string;
}) {
  if (!env.telegramBotToken) {
    return { ok: false, missing: false, error: 'TELEGRAM_BOT_TOKEN is not configured', message: null };
  }
  try {
    const response: any = await axios.post(getTelegramApiUrl('forwardMessage'), {
      chat_id: bufferChatId,
      from_chat_id: fromChatId,
      message_id: messageId,
      disable_notification: true,
      protect_content: true,
    });
    if (!response.data?.ok) {
      const description = String(response.data?.description ?? 'Unknown error');
      if (/not found|MESSAGE_ID_INVALID|message to forward not found/i.test(description)) {
        return { ok: false, missing: true, error: description, message: null };
      }
      return { ok: false, missing: false, error: description, message: null };
    }
    const forwarded = response.data.result;
    try {
      await deleteTelegramMessage({ chatId: bufferChatId, messageId: forwarded.message_id });
    } catch (_) {}
    return {
      ok: true,
      missing: false,
      message: reconstructTelegramMessageFromForward(forwarded, fromChatId, messageId),
    };
  } catch (error: any) {
    const description = String(extractError(error));
    if (/not found|MESSAGE_ID_INVALID|message to forward not found/i.test(description)) {
      return { ok: false, missing: true, error: description, message: null };
    }
    return { ok: false, missing: false, error: description, message: null };
  }
}

async function sendSlackFileToTelegram({ file, chatId, caption = '', replyToMessageId }: any) {
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
  if (replyToMessageId) {
    form.append('reply_to_message_id', String(replyToMessageId));
    form.append('allow_sending_without_reply', 'true');
  }
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

async function sendSlackMediaGroupToTelegram({ files, chatId, caption = '', replyToMessageId }: any) {
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
  if (replyToMessageId) {
    form.append('reply_to_message_id', String(replyToMessageId));
    form.append('allow_sending_without_reply', 'true');
  }

  const response: any = await withRetry(() => axios.post(getTelegramApiUrl('sendMediaGroup'), form));
  if (!response.data?.ok) throw new Error(response.data?.description ?? 'Failed to send media group');
  return response.data.result?.[0]?.message_id ?? null;
}

export async function setTelegramWebhook({ url, secretToken }: any) {
  if (!env.telegramBotToken) throw new Error('TELEGRAM_BOT_TOKEN is required to set webhook');
  const response = await axios.post(getTelegramApiUrl('setWebhook'), {
    url,
    secret_token: secretToken,
    allowed_updates: ['message', 'edited_message', 'channel_post', 'edited_channel_post', 'callback_query', 'my_chat_member'],
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

export async function sendTelegramMessageWithKeyboard({ chatId, text, keyboard, replyToMessageId }: any) {
  if (!env.telegramBotToken) throw new Error('TELEGRAM_BOT_TOKEN is required');
  const response = await axios.post(getTelegramApiUrl('sendMessage'), {
    chat_id: chatId,
    text,
    reply_markup: { inline_keyboard: keyboard },
    reply_to_message_id: replyToMessageId,
    parse_mode: 'HTML',
  });
  if (!response.data?.ok) throw new Error(`Failed to send message: ${response.data?.description ?? 'Unknown error'}`);
  return { ok: true, messageId: response.data.result.message_id, result: response.data.result };
}

export async function answerCallbackQuery({ callbackQueryId, text, showAlert = false }: any) {
  if (!env.telegramBotToken) throw new Error('TELEGRAM_BOT_TOKEN is required');
  const response = await axios.post(getTelegramApiUrl('answerCallbackQuery'), {
    callback_query_id: callbackQueryId,
    text,
    show_alert: showAlert,
  });
  if (!response.data?.ok) throw new Error(`Failed to answer callback: ${response.data?.description ?? 'Unknown error'}`);
  return { ok: true };
}

export async function editTelegramMessage({ chatId, messageId, text, keyboard }: any) {
  if (!env.telegramBotToken) throw new Error('TELEGRAM_BOT_TOKEN is required');
  const payload: any = { chat_id: chatId, message_id: messageId, text, parse_mode: 'HTML' };
  if (keyboard) payload.reply_markup = { inline_keyboard: keyboard };
  try {
    const response = await axios.post(getTelegramApiUrl('editMessageText'), payload);
    if (!response.data?.ok) throw new Error(response.data?.description ?? 'Unknown error');
    return { ok: true, result: response.data.result };
  } catch (error: any) {
    const description = String(error?.response?.data?.description ?? error?.message ?? '');
    if (!/message to edit not found|there is no text in the message to edit|message can't be edited/i.test(description)) {
      throw error instanceof Error ? error : new Error(description || 'Failed to edit message');
    }
    const captionPayload: any = { chat_id: chatId, message_id: messageId, caption: text, parse_mode: 'HTML' };
    if (keyboard) captionPayload.reply_markup = { inline_keyboard: keyboard };
    const captionResponse = await axios.post(getTelegramApiUrl('editMessageCaption'), captionPayload);
    if (!captionResponse.data?.ok) throw new Error(captionResponse.data?.description ?? (description || 'Failed to edit caption'));
    return { ok: true, result: captionResponse.data.result };
  }
}

export async function deleteTelegramMessage({ chatId, messageId }: any) {
  if (!env.telegramBotToken) throw new Error('TELEGRAM_BOT_TOKEN is required');
  const response = await axios.post(getTelegramApiUrl('deleteMessage'), { chat_id: chatId, message_id: messageId });
  if (!response.data?.ok) throw new Error(`Failed to delete message: ${response.data?.description ?? 'Unknown error'}`);
  return { ok: true };
}

async function telegramAuthorHtml(message: any) {
  const renderedText = await renderSlackMentionsToTelegramHtml(message.text || '');
  const authorName = escapeTelegramHtml(String(message.userName || ''));
  if (authorName && renderedText) return `<b>[${authorName}]</b> : ${renderedText}`;
  if (authorName) return `<b>[${authorName}]</b>`;
  return renderedText;
}

function telegramReplyFields(message: any) {
  const replyToMessageId = message.replyToMessageId ?? message.metadata?.replyToTelegramMessageId;
  if (!replyToMessageId) return {};
  return { reply_to_message_id: Number(replyToMessageId), allow_sending_without_reply: true };
}

export async function sendToTelegram(message: any) {
  const chatId = message.destinationChannelId || env.defaultTelegramChatId || message.channelId;
  const replyToMessageId = message.replyToMessageId ?? message.metadata?.replyToTelegramMessageId;

  if (!env.enableLiveForwarding || !env.telegramBotToken || !chatId) {
    return {
      status: 'mocked',
      mode: 'mock',
      target: chatId || 'telegram-chat-not-configured',
      providerMessageId: `mock-tg:${message.externalId || Date.now()}`,
      replyToMessageId: replyToMessageId || undefined,
    };
  }

  try {
    const forwardedText = await telegramAuthorHtml(message);
    const hasFiles = Array.isArray(message.files) && message.files.length > 0;
    let response: any = null;
    const authorCaption = forwardedText;
    const replyFields = telegramReplyFields(message);

    if (!hasFiles) {
      response = await axios.post(getTelegramApiUrl('sendMessage'), {
        chat_id: chatId,
        text: formatText({ ...message, forwardedText }),
        parse_mode: 'HTML',
        ...replyFields,
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
          response = await sendSlackMediaGroupToTelegram({
            files: photoVideoFiles,
            chatId,
            caption: authorCaption,
            replyToMessageId,
          });
          captionSent = true;
        } catch (groupError) {
          for (let index = 0; index < photoVideoFiles.length; index += 1) {
            const file = photoVideoFiles[index];
            try {
              const caption = !captionSent && index === 0 ? authorCaption : '';
              response = await sendSlackFileToTelegram({
                file,
                chatId,
                caption,
                replyToMessageId: captionSent ? undefined : replyToMessageId,
              });
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
          response = await sendSlackFileToTelegram({
            file: photoVideoFiles[0],
            chatId,
            caption: authorCaption,
            replyToMessageId,
          });
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
            response = await axios.post(getTelegramApiUrl('sendMessage'), {
              chat_id: chatId,
              text: caption,
              parse_mode: 'HTML',
              ...replyFields,
            });
            captionSent = true;
          }
          response = await sendSlackFileToTelegram({
            file,
            chatId,
            caption,
            replyToMessageId: captionSent ? undefined : replyToMessageId,
          });
          if (caption) captionSent = true;
        } catch (fileError: any) {
          await axios.post(getTelegramApiUrl('sendMessage'), {
            chat_id: chatId,
            text: `⚠️ Не удалось переслать файл: ${file.name || file.type} (${fileError.message})`,
          });
        }
      }

      if (!captionSent && !message.text) {
        response = await axios.post(getTelegramApiUrl('sendMessage'), {
          chat_id: chatId,
          text: authorCaption,
          parse_mode: 'HTML',
          ...replyFields,
        });
      }
    }

    return {
      status: 'sent',
      mode: 'live',
      target: chatId,
      providerMessageId: typeof response === 'number' ? response : response?.data?.result?.message_id ?? null,
      replyToMessageId: replyToMessageId || undefined,
    };
  } catch (error) {
    return { status: 'failed', mode: 'live', target: chatId, error: extractError(error) };
  }
}

export async function updateTelegramMessage(message: any) {
  const chatId = message.destinationChannelId || env.defaultTelegramChatId || message.channelId;
  const messageId = message.telegramMessageId ?? message.delivery?.providerMessageId ?? message.providerMessageId;
  if (!chatId || messageId === undefined || messageId === null || messageId === '') {
    return { status: 'failed', mode: 'control', target: chatId, error: 'missing_telegram_target' };
  }
  if (!env.enableLiveForwarding || !env.telegramBotToken) {
    return { status: 'mocked', mode: 'mock', target: chatId, providerMessageId: messageId, action: 'edit' };
  }
  try {
    const forwardedText = await telegramAuthorHtml(message);
    await editTelegramMessage({
      chatId,
      messageId,
      text: formatText({ ...message, forwardedText }),
    });
    return { status: 'sent', mode: 'live', target: chatId, providerMessageId: messageId, action: 'edit' };
  } catch (error) {
    return { status: 'failed', mode: 'live', target: chatId, error: extractError(error) };
  }
}

export async function removeTelegramMessage({ chatId, messageId }: { chatId: any; messageId: any }) {
  const target = String(chatId ?? '').trim();
  if (!target || messageId === undefined || messageId === null || messageId === '') {
    return { status: 'failed', mode: 'control', target, error: 'missing_telegram_target' };
  }
  if (!env.enableLiveForwarding || !env.telegramBotToken) {
    return { status: 'mocked', mode: 'mock', target, providerMessageId: messageId, action: 'delete' };
  }
  try {
    await deleteTelegramMessage({ chatId: target, messageId });
    return { status: 'sent', mode: 'live', target, providerMessageId: messageId, action: 'delete' };
  } catch (error) {
    return { status: 'failed', mode: 'live', target, error: extractError(error) };
  }
}
