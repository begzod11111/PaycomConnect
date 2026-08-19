import { env } from '../core/env';
import { logAction } from './action-log';
import {
  processInboundMessage,
  redeliverStoredMessage,
  shouldRedeliverStoredMessage,
  telegramExternalId,
} from './bridge';
import { isMongoConnected } from './database';
import { jiraCommentToPlainText, listJiraIssueComments } from './jira';
import { isTelegramServiceMessage } from './membership';
import { SlackUser } from './models';
import {
  findConnectionBySourceChannel,
  findMessageByExternalId,
  findMessagesByChannel,
  saveMessage,
} from './persistence';
import { SlackApiService } from './slack-api';
import {
  fetchTelegramMessageById,
  registerSyncBufferChat,
  unregisterSyncBufferChat,
} from './telegram';

const DEFAULT_LOOKBACK = 200;
const MAX_LOOKBACK = 1000;
const NEWER_PROBE = 40;
const FORWARD_GAP_MS = 80;
const MAX_CONSECUTIVE_MISS_AFTER_KNOWN = 8;

export type SyncScope = 'all' | 'telegram' | 'jira';

export type TelegramHistoryFetcher = (args: {
  fromChatId: string;
  messageId: number;
  bufferChatId: string;
}) => Promise<{ ok: boolean; missing?: boolean; error?: string; message: any }>;

let telegramHistoryFetcher: TelegramHistoryFetcher | null = null;
let syncBufferOverride = '';
let forwardGapMs = FORWARD_GAP_MS;

export function setTelegramHistoryFetcherForTests(fetcher?: TelegramHistoryFetcher | null) {
  telegramHistoryFetcher = fetcher || null;
  forwardGapMs = fetcher ? 0 : FORWARD_GAP_MS;
}

export function setSyncBufferChatForTests(chatId?: string) {
  syncBufferOverride = String(chatId ?? '');
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function parseSyncCommandText(text: unknown): { scope: SyncScope; lookback: number } {
  const parts = String(text ?? '')
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  let scope: SyncScope = 'all';
  let lookback = DEFAULT_LOOKBACK;
  for (const part of parts) {
    if (part === 'telegram' || part === 'tg') scope = 'telegram';
    else if (part === 'jira') scope = 'jira';
    else if (part === 'all') scope = 'all';
    else if (/^\d+$/.test(part)) lookback = Math.min(MAX_LOOKBACK, Math.max(10, Number(part)));
  }
  return { scope, lookback };
}

export function telegramHistorySkipReason(message: any): string | null {
  if (!message) return 'missing';
  if (message.from?.is_bot && !message.sender_chat) return 'bot';
  if (isTelegramServiceMessage(message)) return 'service';
  const text = String(message.text || message.caption || '').trim();
  if (text.startsWith('/')) return 'slash_command';
  const hasMedia = Boolean(
    message.photo ||
      message.document ||
      message.video ||
      message.audio ||
      message.voice ||
      message.sticker ||
      message.animation ||
      message.video_note,
  );
  if (!text && !hasMedia) return 'empty_content';
  return null;
}

export function parseTelegramNumericId(externalId: unknown, channelId: unknown): number | null {
  const id = String(externalId ?? '');
  const chat = String(channelId ?? '');
  const raw = chat && id.startsWith(`${chat}:`) ? id.slice(chat.length + 1) : id;
  const numeric = Number(raw);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : null;
}

export async function findTelegramMessageForChat(channelId: string, messageId: number | string) {
  const combined = telegramExternalId(channelId, messageId);
  const ids = combined === String(messageId) ? [combined] : [combined, String(messageId)];
  for (const externalId of ids) {
    const found = await findMessageByExternalId('telegram', externalId);
    if (!found) continue;
    if (!found.channelId || String(found.channelId) === String(channelId)) return found;
  }
  return null;
}

async function resolveSyncBufferChat(actorSlackId?: string) {
  if (syncBufferOverride) {
    return { chatId: syncBufferOverride, source: 'test' as const };
  }
  if (env.telegramSyncChatId) {
    return { chatId: String(env.telegramSyncChatId), source: 'env' as const };
  }
  if (actorSlackId && isMongoConnected()) {
    const operator: any = await SlackUser.findOne({
      slackId: String(actorSlackId),
      telegramId: { $exists: true, $ne: null },
    })
      .select('telegramId')
      .lean();
    if (operator?.telegramId) {
      return { chatId: String(operator.telegramId), source: 'operator_dm' as const };
    }
  }
  return { chatId: '', source: 'none' as const };
}

function buildIdRange(knownIds: number[], lookback: number) {
  const unique = [...new Set(knownIds.filter((id) => id > 0))].sort((a, b) => a - b);
  const maxKnown = unique.length ? unique[unique.length - 1] : 0;
  const minId = maxKnown ? Math.max(1, maxKnown - lookback + 1) : 1;
  const maxId = maxKnown ? maxKnown + NEWER_PROBE : lookback;
  const ids: number[] = [];
  for (let id = minId; id <= maxId; id += 1) ids.push(id);
  return { ids, minId, maxId, maxKnown };
}

async function syncTelegramHistory(params: {
  connection: any;
  lookback: number;
  actorSlackId?: string;
  actorName?: string;
}) {
  const telegramChatId = String(params.connection.telegramChatId || '');
  const stored = await findMessagesByChannel('telegram', telegramChatId);
  const knownIds = stored
    .map((row) => parseTelegramNumericId(row.externalId, telegramChatId))
    .filter((id): id is number => id != null);

  let forwarded = 0;
  let retried = 0;
  let skippedConfidential = 0;
  let alreadyDelivered = 0;
  let missing = 0;
  let failed = 0;
  const details: string[] = [];

  for (const row of stored) {
    if (row.delivered || row.metadata?.skipReason) continue;
    if (!shouldRedeliverStoredMessage(row)) continue;
    const result = await redeliverStoredMessage(row);
    if (result.delivered) retried += 1;
    else failed += 1;
  }

  const buffer = await resolveSyncBufferChat(params.actorSlackId);
  const canReadHistory = Boolean(buffer.chatId) && Boolean(telegramHistoryFetcher || env.telegramBotToken);
  if (!canReadHistory) {
    if (!env.telegramBotToken && !telegramHistoryFetcher) {
      details.push('История Telegram не читалась: нет TELEGRAM_BOT_TOKEN (повтор из Mongo выполнен).');
    } else {
      details.push(
        'История Telegram не читалась: задайте TELEGRAM_SYNC_CHAT_ID (приватный канал, бот — админ) или напишите боту /start в Telegram, чтобы /sync мог читать сообщения группы.',
      );
    }
    return { forwarded, retried, skippedConfidential, alreadyDelivered, missing, failed, scanned: 0, details, buffer };
  }

  registerSyncBufferChat(buffer.chatId);
  const { ids, maxKnown } = buildIdRange(knownIds, params.lookback);
  let consecutiveMissAfterKnown = 0;

  try {
    for (const messageId of ids) {
      if (maxKnown && messageId > maxKnown && consecutiveMissAfterKnown >= MAX_CONSECUTIVE_MISS_AFTER_KNOWN) {
        break;
      }

      const existing = await findTelegramMessageForChat(telegramChatId, messageId);
      if (existing?.delivered) {
        alreadyDelivered += 1;
        consecutiveMissAfterKnown = 0;
        continue;
      }
      if (existing?.metadata?.skipReason) {
        skippedConfidential += 1;
        consecutiveMissAfterKnown = 0;
        continue;
      }
      if (existing && shouldRedeliverStoredMessage(existing)) {
        const result = await redeliverStoredMessage(existing);
        if (result.delivered) retried += 1;
        else failed += 1;
        consecutiveMissAfterKnown = 0;
        continue;
      }

      const fetched = await (telegramHistoryFetcher || fetchTelegramMessageById)({
        fromChatId: telegramChatId,
        messageId,
        bufferChatId: buffer.chatId,
      });
      if (forwardGapMs) await sleep(forwardGapMs);

      if (fetched.missing) {
        missing += 1;
        if (maxKnown && messageId > maxKnown) consecutiveMissAfterKnown += 1;
        continue;
      }
      consecutiveMissAfterKnown = 0;
      if (!fetched.ok || !fetched.message) {
        failed += 1;
        continue;
      }

      const message = {
        ...fetched.message,
        chat: {
          id: telegramChatId,
          title: params.connection.telegramChatTitle || fetched.message.chat?.title || '',
          type: params.connection.telegramChatType || fetched.message.chat?.type || 'supergroup',
        },
      };
      const skipReason = telegramHistorySkipReason(message);
      if (skipReason) {
        skippedConfidential += 1;
        continue;
      }

      const result = await processInboundMessage('telegram', {
        update_id: null,
        message,
        metadataHint: 'telegram_sync',
      });
      if (result?.duplicate && result?.message?.delivered) {
        alreadyDelivered += 1;
      } else if (result?.delivery && ['sent', 'mocked'].includes(result.delivery.status)) {
        forwarded += 1;
      } else if (result?.ignored) {
        skippedConfidential += 1;
      } else {
        failed += 1;
      }
    }
  } finally {
    unregisterSyncBufferChat(buffer.chatId);
  }

  return {
    forwarded,
    retried,
    skippedConfidential,
    alreadyDelivered,
    missing,
    failed,
    scanned: ids.length,
    details,
    buffer,
  };
}

async function syncJiraComments(params: { connection: any; slackChannelId: string }) {
  const issueKeys = [
    ...new Set(
      [params.connection.jiraIssueKey, ...(params.connection.jiraTaskKeys || [])]
        .map((key) => String(key || '').trim())
        .filter(Boolean),
    ),
  ];
  if (!issueKeys.length) {
    return { posted: 0, skipped: 0, failed: 0, details: ['У связки нет Jira-ключа — комментарии не подтягивались.'] };
  }
  if (!env.jiraBaseUrl || !env.jiraEmail || !env.jiraApiToken) {
    return { posted: 0, skipped: 0, failed: 0, details: ['Jira не настроена (JIRA_BASE_URL / JIRA_EMAIL / JIRA_API_TOKEN).'] };
  }

  let posted = 0;
  let skipped = 0;
  let failed = 0;

  for (const issueKey of issueKeys) {
    let comments: any[] = [];
    try {
      comments = await listJiraIssueComments(issueKey);
    } catch (error: any) {
      failed += 1;
      continue;
    }
    for (const comment of comments) {
      const commentId = String(comment.id ?? '');
      if (!commentId) continue;
      const externalId = `jira:${issueKey}:${commentId}`;
      const existing = await findMessageByExternalId('slack', externalId);
      if (existing?.delivered) {
        skipped += 1;
        continue;
      }
      const author = comment.author?.displayName || comment.author?.emailAddress || 'Jira';
      const body = jiraCommentToPlainText(comment) || '[без текста]';
      const text = `💬 *Jira ${issueKey}* — ${author}\n${body}`;
      try {
        if (env.enableLiveForwarding && env.slackBotToken) {
          await SlackApiService.sendMessage(params.slackChannelId, text, [
            { type: 'context', elements: [{ type: 'mrkdwn', text: '_Комментарий из Jira. В Telegram не отправлялся._' }] },
            { type: 'section', text: { type: 'mrkdwn', text } },
          ]);
        }
        await saveMessage({
          source: 'slack',
          destination: 'telegram',
          direction: 'slack_to_telegram',
          externalId,
          userId: String(comment.author?.accountId || 'jira'),
          userName: author,
          channelId: params.slackChannelId,
          text: body,
          format: 'text',
          files: [],
          firstInteraction: false,
          delivery: {
            status: env.enableLiveForwarding && env.slackBotToken ? 'sent' : 'mocked',
            mode: 'jira_sync',
            target: params.slackChannelId,
            delivered: true,
            slackOnly: true,
          },
          delivered: true,
          jira: { issueKey, commentId },
          messageTimestamp: comment.created ? new Date(comment.created) : new Date(),
          metadata: {
            skipTelegram: true,
            jiraIssueKey: issueKey,
            jiraCommentId: commentId,
            rawType: 'jira_comment_sync',
          },
        });
        posted += 1;
      } catch {
        failed += 1;
      }
    }
  }

  return { posted, skipped, failed, details: [] as string[] };
}

export async function syncLinkedChannel(params: {
  slackChannelId: string;
  actorId?: string;
  actorName?: string;
  text?: string;
}) {
  const parsed = parseSyncCommandText(params.text);
  const connection: any = await findConnectionBySourceChannel('slack', String(params.slackChannelId));
  if (!connection) {
    return {
      ok: false,
      status: 'not_found',
      message: 'Активная связка для этого канала не найдена. Сначала /connect.',
    };
  }
  if (connection.status !== 'linked') {
    return {
      ok: false,
      status: connection.status,
      message: `Связка ${connection.inn || ''} ещё не linked (статус: ${connection.status}).`,
    };
  }

  void logAction({
    action: 'channel.sync',
    category: 'connection',
    source: 'slack',
    message: `Slack /sync started for INN ${connection.inn}`,
    actor: { userId: String(params.actorId ?? ''), userName: params.actorName ?? '' },
    connectionInn: String(connection.inn ?? ''),
    context: { scope: parsed.scope, lookback: parsed.lookback, slackChannelId: params.slackChannelId },
  });

  const telegram =
    parsed.scope === 'jira'
      ? {
          forwarded: 0,
          retried: 0,
          skippedConfidential: 0,
          alreadyDelivered: 0,
          missing: 0,
          failed: 0,
          scanned: 0,
          details: [] as string[],
          buffer: { chatId: '', source: 'none' as const },
        }
      : await syncTelegramHistory({
          connection,
          lookback: parsed.lookback,
          actorSlackId: params.actorId,
          actorName: params.actorName,
        });

  const jira =
    parsed.scope === 'telegram'
      ? { posted: 0, skipped: 0, failed: 0, details: [] as string[] }
      : await syncJiraComments({ connection, slackChannelId: String(params.slackChannelId) });

  const lines = [
    `🔄 *Подтягивание для ИНН ${connection.inn}*`,
    parsed.scope !== 'jira'
      ? `Telegram → Slack: отправлено ${telegram.forwarded}, повтор ${telegram.retried}, уже было ${telegram.alreadyDelivered}, служебные пропущены ${telegram.skippedConfidential}, нет в Telegram ${telegram.missing}, ошибки ${telegram.failed}.`
      : '',
    parsed.scope !== 'telegram' ? `Jira → Slack: новых комментариев ${jira.posted}, уже было ${jira.skipped}, ошибки ${jira.failed}.` : '',
    ...telegram.details,
    ...jira.details,
  ].filter(Boolean);

  return {
    ok: true,
    status: 'done',
    message: lines.join('\n'),
    connection,
    telegram,
    jira,
    parsed,
  };
}
