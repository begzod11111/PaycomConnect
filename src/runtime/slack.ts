import axios from 'axios';

import { env } from '../core/env';
import { SlackUser } from './models';
import { SlackApiService } from './slack-api';

// Faithful port of services/slackService.js (outbound Telegram -> Slack delivery).
const FILE_RETRY_ATTEMPTS = 3;
const FILE_RETRY_DELAY_MS = 700;
const FILE_UPLOAD_CONCURRENCY = 2;
const TELEGRAM_AVATAR_CACHE_TTL_MS = 10 * 60 * 1000;
const telegramAvatarCache = new Map<string, any>();

const SLACK_NAME_CACHE_TTL_MS = 30 * 60 * 1000;
const slackNameCache = new Map<string, { name: string; ts: number }>();

// Slack Events webhooks usually omit `user_profile`, so inbound messages fall
// back to a raw `user-<id>` label. Resolve the real display name (DB first,
// then Slack API, cached) so forwarded messages show a human name instead of an
// internal Slack id.
export async function resolveSlackDisplayName(userId: string, fallback: string): Promise<string> {
  const id = String(userId || '').trim();
  if (!id) return fallback;

  try {
    const dbUser: any = await SlackUser.findOne({ slackId: id }).select('displayName email').lean();
    const dbName = dbUser?.displayName || dbUser?.email;
    if (dbName) return dbName;
  } catch {
    // ignore DB lookup failures and fall through to the Slack API / cache.
  }

  const cached = slackNameCache.get(id);
  if (cached && Date.now() - cached.ts < SLACK_NAME_CACHE_TTL_MS) return cached.name;

  if (!env.slackBotToken) return fallback;

  try {
    const info: any = await SlackApiService.getUserInfo(id);
    const resolved =
      info?.profile?.real_name ||
      info?.profile?.display_name ||
      info?.real_name ||
      info?.name ||
      fallback;
    slackNameCache.set(id, { name: resolved, ts: Date.now() });
    return resolved;
  } catch {
    return fallback;
  }
}

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

async function processWithConcurrency(items: any[], limit: number, handler: any) {
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

function extractError(error: any) {
  return error.response?.data?.error ?? error.message;
}

function formatText(message: any) {
  const header = `*${message.userName}*`;
  const body = message.forwardedText || message.text || '[Сообщение без текста]';
  const fileSuffix = message.files.length
    ? `\n\nВложения: ${message.files.map((file: any) => file.name || file.type).join(', ')}`
    : '';
  return `${header}\n${body}${fileSuffix}`;
}

async function resolveTelegramAvatarUrl(telegramUserId: any) {
  if (!telegramUserId || !env.telegramBotToken) return '';
  const cacheKey = String(telegramUserId);
  const cached = telegramAvatarCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < TELEGRAM_AVATAR_CACHE_TTL_MS) return cached.url;

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

function getSlackCustomizeFields() {
  const fields: any = {};
  if (env.slackBridgeBotName) fields.username = env.slackBridgeBotName;
  if (env.slackBridgeBotIconEmoji) fields.icon_emoji = env.slackBridgeBotIconEmoji;
  return fields;
}

async function buildSlackMessagePayload(message: any) {
  const forwardedText = message.forwardedText || message.text || '';
  const defaultText = formatText(message);

  if (message.source !== 'telegram') {
    return { text: defaultText, customizeFields: getSlackCustomizeFields() };
  }

  const tgUsername = message.metadata?.telegramUsername
    ? `@${String(message.metadata.telegramUsername).replace(/^@+/, '')}`
    : '';
  const avatarUrl = await resolveTelegramAvatarUrl(message.userId);

  const customizeFields: any = { username: message.userName || env.slackBridgeBotName || 'Telegram User' };
  if (avatarUrl) customizeFields.icon_url = avatarUrl;
  else if (env.slackBridgeBotIconEmoji) customizeFields.icon_emoji = env.slackBridgeBotIconEmoji;

  const blocks: any[] = [];
  if (tgUsername) {
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `${tgUsername}  •  _Telegram_` }] });
  }
  if (forwardedText) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: forwardedText } });
  }
  // Attachments are uploaded to Slack as native files (with previews), so we
  // deliberately do not add an extra "Вложения: <name>" line here — it would
  // duplicate what Slack already renders and make the message look custom.

  return { text: defaultText, blocks: blocks.length ? blocks : undefined, customizeFields };
}

async function resolveIntegratorMentions(connection: any) {
  const integratorIds = Array.isArray(connection?.integrators) ? connection.integrators : [];
  if (!integratorIds.length) return '';
  const integrators = await SlackUser.find({
    _id: { $in: integratorIds },
    slackId: { $exists: true, $ne: '' },
    status: 'active',
  })
    .select('slackId')
    .lean();
  const mentions = integrators.map((item: any) => `<@${item.slackId}>`);
  return mentions.length ? mentions.join(' ') : '';
}

async function buildTelegramToSlackText(message: any) {
  const botTag = String(env.telegramBotName || '').trim();
  const original = String(message.text || '');
  let forwardedText = original;
  if (botTag && forwardedText.includes(botTag)) {
    forwardedText = forwardedText.split(botTag).join('').trim();
    const integratorMentions = await resolveIntegratorMentions(message.connection);
    if (integratorMentions) forwardedText = `${forwardedText}\n\n${integratorMentions}`.trim();
  }
  return forwardedText;
}

// Caption shown together with forwarded media. File-upload messages cannot use
// per-user username/avatar customization, so the author identity is carried in
// the comment text instead (bold name + optional Telegram @username).
function buildSlackMediaComment(message: any, forwardedText: string) {
  const userName = message.userName || env.slackBridgeBotName || 'Telegram User';
  const tgUsername =
    message.source === 'telegram' && message.metadata?.telegramUsername
      ? `@${String(message.metadata.telegramUsername).replace(/^@+/, '')}`
      : '';
  const header = tgUsername ? `*${userName}*  ·  ${tgUsername}` : `*${userName}*`;
  const body = String(forwardedText || '').trim();
  return body ? `${header}\n${body}` : header;
}

// Upload a single Telegram file to Slack's staging storage WITHOUT finalizing it,
// so several files can later be shared into the channel as one message.
async function uploadTelegramFileToSlackStaging(file: any) {
  const getFileRes: any = await withRetry(() =>
    axios.get(`https://api.telegram.org/bot${env.telegramBotToken}/getFile`, { params: { file_id: file.fileId } }),
  );
  if (!getFileRes.data?.ok || !getFileRes.data?.result?.file_path) {
    throw new Error(`Telegram getFile failed for ${file.fileId}`);
  }

  const filePath = getFileRes.data.result.file_path;
  const downloadUrl = `https://api.telegram.org/file/bot${env.telegramBotToken}/${filePath}`;
  const fileData: any = await withRetry(() => axios.get(downloadUrl, { responseType: 'arraybuffer' }));
  const fileName = file.name || filePath.split('/').pop() || 'file.bin';

  const getUploadUrlRes: any = await withRetry(() =>
    axios.post(
      'https://slack.com/api/files.getUploadURLExternal',
      new URLSearchParams({ filename: fileName, length: String(fileData.data.byteLength) }),
      { headers: { Authorization: `Bearer ${env.slackBotToken}`, 'Content-Type': 'application/x-www-form-urlencoded' } },
    ),
  );
  if (!getUploadUrlRes.data?.ok) throw new Error(getUploadUrlRes.data?.error ?? 'Slack getUploadURLExternal failed');

  const uploadUrl = getUploadUrlRes.data.upload_url;
  const uploadFileId = getUploadUrlRes.data.file_id;

  await withRetry(() =>
    axios.post(uploadUrl, fileData.data, {
      headers: { 'Content-Type': file.mimeType || 'application/octet-stream' },
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
    }),
  );

  return { id: uploadFileId, title: fileName };
}

// Finalize staged uploads: shares all files into the channel as a SINGLE message,
// with the caption/author line as its comment.
async function completeSlackUpload({ files, channel, initialComment }: any) {
  const body: any = { files, channel_id: channel };
  if (initialComment) body.initial_comment = initialComment;
  const response: any = await withRetry(() =>
    axios.post('https://slack.com/api/files.completeUploadExternal', body, {
      headers: { Authorization: `Bearer ${env.slackBotToken}`, 'Content-Type': 'application/json' },
    }),
  );
  if (!response.data?.ok) throw new Error(response.data?.error ?? 'Slack file upload failed');
  return response.data;
}

async function postSlackTextMessage(message: any, forwardedText: string, channel: string) {
  const payload = await buildSlackMessagePayload({ ...message, forwardedText });
  const customizeFields = payload.customizeFields ?? getSlackCustomizeFields();
  const baseBody: any = { channel, text: payload.text, ...(payload.blocks ? { blocks: payload.blocks } : {}) };

  let response: any = await axios.post(
    'https://slack.com/api/chat.postMessage',
    { ...baseBody, ...customizeFields },
    { headers: { Authorization: `Bearer ${env.slackBotToken}` } },
  );

  if (!response.data?.ok && response.data?.error === 'missing_scope' && Object.keys(customizeFields).length) {
    response = await axios.post('https://slack.com/api/chat.postMessage', baseBody, {
      headers: { Authorization: `Bearer ${env.slackBotToken}` },
    });
  }
  return response;
}

async function notifySlack(channel: string, text: string) {
  await axios
    .post('https://slack.com/api/chat.postMessage', { channel, text }, { headers: { Authorization: `Bearer ${env.slackBotToken}` } })
    .catch(() => {});
}

export async function sendToSlack(message: any) {
  const channel = message.destinationChannelId || env.defaultSlackChannelId || message.channelId;

  if (!env.enableLiveForwarding || !env.slackBotToken || !channel) {
    return { status: 'mocked', mode: 'mock', target: channel || 'slack-channel-not-configured' };
  }

  try {
    const forwardedText = message.source === 'telegram' ? await buildTelegramToSlackText(message) : message.text;
    const hasFiles = Array.isArray(message.files) && message.files.length > 0;

    // Text-only: keep the native per-user identity (username + avatar + blocks).
    if (!hasFiles) {
      const response = await postSlackTextMessage(message, forwardedText, channel);
      if (!response.data?.ok) {
        return { status: 'failed', mode: 'live', target: channel, error: response.data?.error ?? 'Unknown Slack API error' };
      }
      return { status: 'sent', mode: 'live', target: channel, providerMessageId: response.data?.ts ?? null };
    }

    // Media: upload every file, then share them as ONE message whose comment
    // carries the author line + caption — instead of a separate text message
    // followed by separate file messages.
    const initialComment = buildSlackMediaComment(message, forwardedText);
    const uploadResults: any[] = new Array(message.files.length).fill(null);
    await processWithConcurrency(
      message.files.map((file: any, index: number) => ({ file, index })),
      FILE_UPLOAD_CONCURRENCY,
      async ({ file, index }: any) => {
        if (!file.fileId) return;
        try {
          uploadResults[index] = { ok: true, upload: await uploadTelegramFileToSlackStaging(file) };
        } catch (fileError: any) {
          uploadResults[index] = { ok: false, file, error: fileError };
        }
      },
    );

    const uploaded = uploadResults.filter((r) => r?.ok).map((r) => r.upload);
    const failures = uploadResults.filter((r) => r && !r.ok);
    let missingScopeDetected = failures.some((f) => String(f.error?.message ?? '').includes('missing_scope'));

    let providerMessageId: any = null;
    let mediaMessageSent = false;
    if (uploaded.length) {
      try {
        const complete = await completeSlackUpload({ files: uploaded, channel, initialComment });
        providerMessageId = complete?.files?.[0]?.id ?? null;
        mediaMessageSent = true;
      } catch (completeError: any) {
        if (String(completeError.message ?? '').includes('missing_scope')) missingScopeDetected = true;
        else failures.push({ file: null, error: completeError });
      }
    }

    // If no file could be shared, still deliver the text so the message content
    // is not lost (native identity preserved).
    if (!mediaMessageSent) {
      const response = await postSlackTextMessage(message, forwardedText, channel);
      if (!response.data?.ok) {
        return { status: 'failed', mode: 'live', target: channel, error: response.data?.error ?? 'Unknown Slack API error' };
      }
      providerMessageId = response.data?.ts ?? providerMessageId;
    }

    for (const failure of failures) {
      if (!failure.file) continue;
      if (String(failure.error?.message ?? '').includes('missing_scope')) continue;
      await notifySlack(channel, `⚠️ Не удалось переслать файл: ${failure.file.name || failure.file.type} (${failure.error?.message})`);
    }
    if (missingScopeDetected) {
      await notifySlack(channel, '⚠️ Вложения из Telegram не загружены: у Slack-бота нет scope `files:write`.');
    }

    return { status: 'sent', mode: 'live', target: channel, providerMessageId };
  } catch (error) {
    return { status: 'failed', mode: 'live', target: channel, error: extractError(error) };
  }
}
