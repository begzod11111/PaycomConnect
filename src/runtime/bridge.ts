import { randomUUID } from 'crypto';

import { env } from '../core/env';
import {
  activateSlackByInn,
  activateTelegramByInn,
  parseConnectCommand,
  resolveDestinationForMessage,
} from './connections';
import { logAction } from './action-log';
import { registerInteraction } from './crm';
import { identifySender } from './directory';
import { maybeCreateJiraIssue } from './jira';
import { findMessageByExternalId, saveJiraIssue, saveMessage } from './persistence';
import { sendToSlack } from './slack';
import { sendToTelegram } from './telegram';

// Content shape of a normalized message: pure text, a file/attachment, both, or empty.
function classifyMessageFormat(message: any): 'text' | 'file' | 'mixed' | 'empty' {
  const hasFiles = Array.isArray(message.files) && message.files.length > 0;
  const hasText = Boolean(String(message.text ?? '').trim());
  if (hasFiles && hasText) return 'mixed';
  if (hasFiles) return 'file';
  if (hasText) return 'text';
  return 'empty';
}

// telegram_to_slack | slack_to_telegram — the crossing direction.
function resolveDirection(source: string): string {
  return source === 'telegram' ? 'telegram_to_slack' : 'slack_to_telegram';
}

// A delivery outcome counts as "delivered" (rendered on the far side) only when
// it was actually sent or mocked; pending/unlinked/failed do not.
function isDelivered(delivery: any): boolean {
  return ['sent', 'mocked'].includes(delivery?.status);
}

// Faithful port of services/bridgeService.js
const processedMessageIds = new Map<string, number>();
const PROCESSED_MESSAGE_TTL_MS = 5 * 60 * 1000;

const processedMessageCleanupInterval = setInterval(() => {
  const now = Date.now();
  for (const [key, ts] of processedMessageIds.entries()) {
    if (now - ts > PROCESSED_MESSAGE_TTL_MS) processedMessageIds.delete(key);
  }
}, 60 * 1000);
processedMessageCleanupInterval.unref?.();

function toIsoTimestamp(value: any): string {
  if (!value) return new Date().toISOString();
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') {
    if (value.includes('T')) return new Date(value).toISOString();
    if (value.includes('.')) return new Date(Number(value.split('.')[0]) * 1000).toISOString();
  }
  const numericValue = Number(value);
  if (!Number.isNaN(numericValue)) {
    return new Date(String(Math.trunc(numericValue)).length <= 10 ? numericValue * 1000 : numericValue).toISOString();
  }
  return new Date().toISOString();
}

function normalizeFiles(files: any[] = []) {
  return files.map((file) => ({
    type: file.type || file.mime_type || 'file',
    name: file.name || file.file_name || file.title || '',
    url: file.url || file.private_url || file.url_private || file.url_private_download || '',
    size: file.size || file.file_size || 0,
    mimeType: file.mimeType || file.mimetype || file.mime_type || '',
    width: file.width || file.original_w || file.w || 0,
    height: file.height || file.original_h || file.h || 0,
    duration: file.duration || file.audio_duration || 0,
    fileId: file.file_id || file.fileId || '',
    slackFileId: file.id || '',
    slackPrivateUrl: file.url_private_download || file.url_private || '',
  }));
}

function normalizeTelegramPayload(payload: any) {
  const message = payload.message ?? payload.edited_message ?? payload;
  const largestPhoto = Array.isArray(message.photo) && message.photo.length ? message.photo[message.photo.length - 1] : null;
  const photoFiles = largestPhoto
    ? [{ type: 'photo', name: 'telegram-photo', file_id: largestPhoto.file_id, file_size: largestPhoto.file_size }]
    : [];
  const documentFiles = message.document
    ? [{ type: 'document', name: message.document.file_name || 'telegram-document', file_id: message.document.file_id, file_size: message.document.file_size || 0 }]
    : [];
  const videoFiles = message.video
    ? [{ type: 'video', name: message.video.file_name || 'telegram-video', file_id: message.video.file_id, file_size: message.video.file_size || 0 }]
    : [];
  const audioFiles = message.audio
    ? [{ type: 'audio', name: message.audio.file_name || 'telegram-audio', file_id: message.audio.file_id, file_size: message.audio.file_size || 0 }]
    : [];
  const voiceFiles = message.voice
    ? [{ type: 'voice', name: 'telegram-voice.ogg', file_id: message.voice.file_id, file_size: message.voice.file_size || 0 }]
    : [];

  return {
    source: 'telegram',
    destination: 'slack',
    externalId: String(message.message_id ?? payload.messageId ?? randomUUID()),
    userId: String(message.from?.id ?? payload.userId ?? 'telegram-user-unknown'),
    userName:
      payload.userName ||
      [message.from?.first_name, message.from?.last_name].filter(Boolean).join(' ').trim() ||
      message.from?.username ||
      'Telegram user',
    channelId: String(message.chat?.id ?? payload.channelId ?? env.defaultTelegramChatId ?? ''),
    destinationChannelId: payload.destinationChannelId ?? env.defaultSlackChannelId ?? '',
    text: message.text ?? message.caption ?? payload.text ?? '',
    files: normalizeFiles(payload.files ?? [...photoFiles, ...documentFiles, ...videoFiles, ...audioFiles, ...voiceFiles]),
    messageTimestamp: toIsoTimestamp(message.date ?? payload.timestamp ?? Date.now()),
    metadata: {
      rawType: payload.update_id ? 'telegram_webhook' : 'telegram_mock',
      updateId: payload.update_id ?? null,
      chatTitle: message.chat?.title ?? payload.chatTitle ?? '',
      chatType: message.chat?.type ?? payload.chatType ?? '',
      telegramUsername: message.from?.username ?? '',
    },
    forceJira: Boolean(payload.forceJira),
  };
}

function normalizeSlackPayload(payload: any) {
  const event = payload.event ?? payload;
  return {
    source: 'slack',
    destination: 'telegram',
    externalId: String(event.client_msg_id ?? payload.event_id ?? event.event_ts ?? randomUUID()),
    userId: String(event.user ?? payload.userId ?? 'slack-user-unknown'),
    userName:
      payload.userName ??
      event.user_profile?.real_name ??
      event.user_profile?.display_name ??
      event.username ??
      `user-${event.user ?? payload.userId ?? 'unknown'}`,
    channelId: String(event.channel ?? payload.channelId ?? env.defaultSlackChannelId ?? ''),
    destinationChannelId: payload.destinationChannelId ?? env.defaultTelegramChatId ?? '',
    text: event.text ?? payload.text ?? '',
    files: normalizeFiles(event.files ?? payload.files ?? []),
    messageTimestamp: toIsoTimestamp(event.ts ?? payload.timestamp ?? Date.now()),
    metadata: {
      rawType: payload.event ? 'slack_webhook' : 'slack_mock',
      eventId: payload.event_id ?? null,
      subtype: event.subtype ?? null,
      channelName: payload.channel_name ?? payload.channelName ?? '',
    },
    forceJira: Boolean(payload.forceJira),
  };
}

export function normalizeInboundMessage(source: string, payload: any) {
  return source === 'telegram' ? normalizeTelegramPayload(payload) : normalizeSlackPayload(payload);
}

export async function processInboundMessage(source: string, payload: any): Promise<any> {
  const normalized: any = normalizeInboundMessage(source, payload);

  const dedupeKey = `${normalized.source}:${normalized.externalId}`;
  if (processedMessageIds.has(dedupeKey)) {
    return { duplicate: true, ignored: true, reason: 'in_memory_dedupe' };
  }

  void logAction({
    action: 'message.received',
    category: 'message',
    source: normalized.source,
    message: `Inbound ${normalized.source} message received`,
    actor: { userId: String(normalized.userId ?? ''), userName: normalized.userName ?? '' },
    externalId: String(normalized.externalId ?? ''),
    context: {
      channelId: normalized.channelId,
      format: classifyMessageFormat(normalized),
    },
  });

  if (source === 'slack') {
    const ignoredSubtypes = new Set([
      'bot_message',
      'channel_join',
      'channel_leave',
      'channel_topic',
      'channel_purpose',
      'message_changed',
      'message_deleted',
      'thread_broadcast',
    ]);
    if (ignoredSubtypes.has(normalized.metadata?.subtype)) {
      void logAction({
        action: 'message.skipped',
        category: 'message',
        source: normalized.source,
        message: `Ignored Slack subtype: ${normalized.metadata?.subtype}`,
        externalId: String(normalized.externalId ?? ''),
        context: { subtype: normalized.metadata?.subtype },
      });
      return { duplicate: false, ignored: true, reason: `ignored_subtype:${normalized.metadata?.subtype}` };
    }
  }

  if (!normalized.userId) throw new Error('User identifier is required');

  const existingMessage = await findMessageByExternalId(normalized.source, normalized.externalId);
  if (existingMessage) {
    return { duplicate: true, message: existingMessage, delivery: existingMessage.delivery, jira: existingMessage.jira };
  }

  const connectCommand = parseConnectCommand(normalized.text);
  if (connectCommand) {
    const activationResult =
      normalized.source === 'telegram'
        ? await activateTelegramByInn({
            inn: connectCommand.inn,
            jiraTaskKey: connectCommand.jiraTaskKey,
            telegramChatId: normalized.channelId,
            telegramChatTitle: normalized.metadata?.chatTitle ?? normalized.channelId,
            telegramChatType: normalized.metadata?.chatType ?? '',
            userId: normalized.userId,
            userName: normalized.userName,
          })
        : await activateSlackByInn({
            inn: connectCommand.inn,
            slackChannelId: normalized.channelId,
            slackChannelName: normalized.metadata?.channelName ?? normalized.channelId,
            userId: normalized.userId,
            userName: normalized.userName,
          });

    void logAction({
      action: 'connection.activation',
      category: 'connection',
      source: normalized.source,
      level: activationResult?.status === 'denied' || activationResult?.status === 'failed' ? 'warn' : 'info',
      message: `Connect command for INN ${connectCommand.inn}: ${activationResult?.status ?? 'unknown'}`,
      actor: { userId: String(normalized.userId ?? ''), userName: normalized.userName ?? '' },
      connectionInn: String(connectCommand.inn ?? ''),
      externalId: String(normalized.externalId ?? ''),
      context: { command: connectCommand, status: activationResult?.status ?? null },
    });

    return {
      duplicate: false,
      onboarding: true,
      command: connectCommand,
      activation: activationResult,
      delivery: { status: 'activated', mode: 'control', target: normalized.channelId },
    };
  }

  processedMessageIds.set(dedupeKey, Date.now());

  const crmResult = await registerInteraction(normalized);
  const sender = await identifySender(normalized.source, normalized.userId);
  const format = classifyMessageFormat(normalized);
  const direction = resolveDirection(normalized.source);
  const routing: any = await resolveDestinationForMessage(normalized);
  const jiraResult: any = await maybeCreateJiraIssue({ ...normalized, firstInteraction: crmResult.isFirstInteraction });

  if (jiraResult.triggered) {
    await saveJiraIssue({
      sourceMessageId: normalized.externalId,
      platform: normalized.source,
      issueKey: jiraResult.issueKey ?? '',
      summary: jiraResult.summary,
      description: jiraResult.description,
      status: jiraResult.status,
      mode: jiraResult.mode,
      payload: jiraResult.payload ?? {},
    });
  }

  const delivery =
    routing.status === 'linked'
      ? normalized.destination === 'slack'
        ? await sendToSlack({ ...normalized, destinationChannelId: routing.destinationChannelId, connection: routing.connection })
        : await sendToTelegram({ ...normalized, destinationChannelId: routing.destinationChannelId })
      : {
          status: routing.status === 'pending' ? 'pending_link' : 'unlinked',
          mode: 'control',
          target: normalized.channelId,
          reason: routing.reason,
        };

  const delivered = isDelivered(delivery);

  const message = await saveMessage({
    ...normalized,
    direction,
    sender,
    format,
    firstInteraction: crmResult.isFirstInteraction,
    delivery: { ...delivery, delivered },
    delivered,
    jira: jiraResult.triggered ? jiraResult : null,
    metadata: {
      ...normalized.metadata,
      connectionStatus: routing.status,
      connectionInn: routing.connection?.inn ?? null,
    },
  });

  void logAction({
    action: delivered ? 'message.forwarded' : 'message.not_forwarded',
    category: 'message',
    level: delivery?.status === 'failed' ? 'error' : delivered ? 'info' : 'warn',
    source: normalized.source,
    message: delivered
      ? `Message forwarded ${direction} (${format})`
      : `Message not forwarded (${delivery?.status ?? 'unknown'})`,
    actor: {
      userId: String(normalized.userId ?? ''),
      userName: normalized.userName ?? '',
      isEmployee: sender.isEmployee,
      userRef: sender.userRef ?? undefined,
    },
    connectionInn: routing.connection?.inn ?? '',
    externalId: String(normalized.externalId ?? ''),
    context: {
      direction,
      format,
      senderType: sender.type,
      deliveryStatus: delivery?.status ?? null,
      deliveryMode: delivery?.mode ?? null,
      reason: (delivery as any)?.reason ?? null,
    },
  });

  if (jiraResult.triggered) {
    void logAction({
      action: 'jira.triggered',
      category: 'jira',
      source: normalized.source,
      message: `Jira issue ${jiraResult.status}: ${jiraResult.issueKey || jiraResult.summary || ''}`.trim(),
      actor: { userId: String(normalized.userId ?? ''), userName: normalized.userName ?? '' },
      connectionInn: routing.connection?.inn ?? '',
      externalId: String(normalized.externalId ?? ''),
      context: { status: jiraResult.status, mode: jiraResult.mode, issueKey: jiraResult.issueKey ?? '' },
    });
  }

  return { duplicate: false, message, contact: crmResult.contact, delivery, jira: jiraResult };
}
