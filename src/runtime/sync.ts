import axios from 'axios';

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
import { yieldToLiveBridge } from './live-gate';
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

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;
const NEWER_PROBE = 8;
const FORWARD_GAP_MS = 80;
const FULL_CHAT_WARN_AFTER = 200;
const MAX_CONSECUTIVE_MISS_AFTER_KNOWN = 8;

export type SyncScope = 'both' | 'telegram' | 'jira';
export type SyncWindow = 'last' | 'full';

export type ParsedSyncCommand = {
  scope: SyncScope;
  window: SyncWindow;
  limit: number;
};

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

export function parseSyncCommandText(text: unknown): ParsedSyncCommand {
  const parts = String(text ?? '')
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  let scope: SyncScope = 'both';
  let window: SyncWindow = 'last';
  let limit = DEFAULT_LIMIT;
  for (const part of parts) {
    if (part === 'telegram' || part === 'tg') scope = 'telegram';
    else if (part === 'jira') scope = 'jira';
    else if (part === 'both') scope = 'both';
    else if (part === 'all' || part === 'full' || part === 'весь' || part === 'chat') window = 'full';
    else if (part === 'last' || part === 'последние' || part === 'последних') window = 'last';
    else if (/^\d+$/.test(part)) {
      window = 'last';
      limit = Math.min(MAX_LIMIT, Math.max(1, Number(part)));
    }
  }
  return { scope, window, limit };
}

export function buildSyncAckText(parsed: ParsedSyncCommand): string {
  if (parsed.scope === 'jira') {
    return '🔄 Сверяю комментарии Jira со Slack в фоне. Живые сообщения не блокируются.';
  }
  if (parsed.window === 'full') {
    return (
      '⚠️ Сверяю *весь* чат Telegram со Slack в фоне. Если переписка длинная, это займёт время — задача не остановит живую пересылку.\n' +
      'Подтяну только сообщения, которых ещё нет. Исходное время Telegram будет указано в Slack.'
    );
  }
  return (
    `🔄 Сверяю последние *${parsed.limit}* сообщений Telegram со Slack в фоне.\n` +
    'Беру список, сравниваю «было отправлено / не было», подтягиваю только пропуски. Живые сообщения идут как обычно.'
  );
}

export function listIdsToFetch(params: {
  knownIds: number[];
  deliveredIds: number[];
  skippedIds?: number[];
  window: SyncWindow;
  limit: number;
  newerProbe?: number;
}): { windowStart: number; windowEnd: number; toFetch: number[]; alreadyOk: number; maxKnown: number } {
  const newerProbe = params.newerProbe ?? NEWER_PROBE;
  const skipped = new Set(params.skippedIds ?? []);
  const delivered = new Set(params.deliveredIds);
  const maxKnown = Math.max(0, ...params.knownIds, ...params.deliveredIds);
  const windowEnd = maxKnown ? maxKnown + newerProbe : params.window === 'full' ? params.limit : params.limit;
  const windowStart = !maxKnown || params.window === 'full' ? 1 : Math.max(1, maxKnown - params.limit + 1);
  const toFetch: number[] = [];
  let alreadyOk = 0;
  for (let id = windowStart; id <= windowEnd; id += 1) {
    if (delivered.has(id) || skipped.has(id)) {
      alreadyOk += 1;
      continue;
    }
    toFetch.push(id);
  }
  return { windowStart, windowEnd, toFetch, alreadyOk, maxKnown };
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

async function syncTelegramHistory(params: {
  connection: any;
  window: SyncWindow;
  limit: number;
  actorSlackId?: string;
  actorName?: string;
}) {
  const telegramChatId = String(params.connection.telegramChatId || '');
  const stored = await findMessagesByChannel('telegram', telegramChatId);
  const knownIds: number[] = [];
  const deliveredIds: number[] = [];
  const skippedIds: number[] = [];
  for (const row of stored) {
    const id = parseTelegramNumericId(row.externalId, telegramChatId);
    if (id == null) continue;
    knownIds.push(id);
    if (row.delivered) deliveredIds.push(id);
    else if (row.metadata?.skipReason) skippedIds.push(id);
  }

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
    await yieldToLiveBridge(forwardGapMs);
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
    return { forwarded, retried, skippedConfidential, alreadyDelivered, missing, failed, scanned: 0, compared: 0, details, buffer };
  }

  const plan = listIdsToFetch({
    knownIds,
    deliveredIds,
    skippedIds,
    window: params.window,
    limit: params.limit,
  });
  alreadyDelivered = plan.alreadyOk;
  if (params.window === 'full' && plan.windowEnd - plan.windowStart + 1 >= FULL_CHAT_WARN_AFTER) {
    details.push(
      `Чат длинный (проверка id ${plan.windowStart}–${plan.windowEnd}). Задача идёт в фоне и уступает живой пересылке.`,
    );
  } else if (params.window === 'last') {
    details.push(
      `Сверка последних ${params.limit}: id ${plan.windowStart}–${plan.windowEnd}, уже есть ${plan.alreadyOk}, к проверке ${plan.toFetch.length}.`,
    );
  }

  registerSyncBufferChat(buffer.chatId);
  let consecutiveMissAfterKnown = 0;

  try {
    for (const messageId of plan.toFetch) {
      if (plan.maxKnown && messageId > plan.maxKnown && consecutiveMissAfterKnown >= MAX_CONSECUTIVE_MISS_AFTER_KNOWN) {
        break;
      }

      await yieldToLiveBridge(forwardGapMs);

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

      if (fetched.missing) {
        missing += 1;
        if (plan.maxKnown && messageId > plan.maxKnown) consecutiveMissAfterKnown += 1;
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
        sync: true,
        message,
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
    scanned: plan.toFetch.length,
    compared: plan.windowEnd - plan.windowStart + 1,
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
      await yieldToLiveBridge(forwardGapMs);
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
    context: {
      scope: parsed.scope,
      window: parsed.window,
      limit: parsed.limit,
      slackChannelId: params.slackChannelId,
    },
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
          compared: 0,
          details: [] as string[],
          buffer: { chatId: '', source: 'none' as const },
        }
      : await syncTelegramHistory({
          connection,
          window: parsed.window,
          limit: parsed.limit,
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
      ? `Telegram → Slack: сверено ${telegram.compared || 0}, подтянуто ${telegram.forwarded}, повтор ${telegram.retried}, уже было ${telegram.alreadyDelivered}, служебные ${telegram.skippedConfidential}, нет id ${telegram.missing}, ошибки ${telegram.failed}. Сообщения идут со временем отправки в Telegram.`
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

type SyncJob = {
  slackChannelId: string;
  actorId?: string;
  actorName?: string;
  text?: string;
  response_url?: string;
};

const syncQueue: SyncJob[] = [];
const activeSyncChannels = new Set<string>();
let syncPumpRunning = false;

function isChannelSyncPending(slackChannelId: string) {
  const id = String(slackChannelId);
  return activeSyncChannels.has(id) || syncQueue.some((job) => String(job.slackChannelId) === id);
}

export function enqueueChannelSync(job: SyncJob) {
  const parsed = parseSyncCommandText(job.text);
  if (!job.slackChannelId) {
    return { queued: false, parsed, ack: 'Укажите канал Slack со связкой /connect.' };
  }
  if (isChannelSyncPending(job.slackChannelId)) {
    return {
      queued: false,
      parsed,
      ack: '⏳ Для этого канала уже идёт подтягивание в фоне. Живые сообщения не блокируются.',
    };
  }
  syncQueue.push(job);
  void pumpSyncQueue();
  return { queued: true, parsed, ack: buildSyncAckText(parsed) };
}

async function pumpSyncQueue() {
  if (syncPumpRunning) return;
  syncPumpRunning = true;
  try {
    while (syncQueue.length) {
      await yieldToLiveBridge();
      const job = syncQueue.shift();
      if (!job) break;
      activeSyncChannels.add(String(job.slackChannelId));
      try {
        const result = await syncLinkedChannel(job);
        if (job.response_url) {
          await axios.post(job.response_url, { response_type: 'ephemeral', text: result.message }).catch((error: any) => {
            console.warn('Failed to post /sync result:', error?.message ?? error);
          });
        }
      } catch (error: any) {
        console.error('Background /sync job failed:', error);
        if (job.response_url) {
          await axios
            .post(job.response_url, {
              response_type: 'ephemeral',
              text: `❌ /sync failed: ${error?.message ?? error}`,
            })
            .catch((postError: any) => console.error('Failed to post /sync error:', postError?.message ?? postError));
        }
      } finally {
        activeSyncChannels.delete(String(job.slackChannelId));
      }
    }
  } finally {
    syncPumpRunning = false;
  }
}

export function resetSyncQueueForTests() {
  syncQueue.length = 0;
  activeSyncChannels.clear();
  syncPumpRunning = false;
}

