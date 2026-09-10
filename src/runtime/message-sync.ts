import { logAction } from './action-log';
import {
  findMessageByExternalId,
  findMessageBySlackRef,
  findMessageByTelegramRef,
  updateMessageRecord,
} from './persistence';
import { telegramUserDisplayName } from './membership';
import { slackPermalink } from './slack-events';
import { deleteSlackMessage, updateSlackMessage } from './slack';
import { removeTelegramMessage, updateTelegramMessage } from './telegram';

export function isOwnMessage(existing: any, editorUserId: unknown): boolean {
  const original = String(existing?.userId ?? '').trim();
  const editor = String(editorUserId ?? '').trim();
  if (!original || !editor) return false;
  return original === editor;
}

export function telegramForwardFromName(rawMessage: any): string {
  if (!rawMessage) return '';
  const origin = rawMessage.forward_origin;
  if (origin?.type === 'user') return telegramUserDisplayName(origin.sender_user);
  if (origin?.type === 'hidden_user') return String(origin.sender_user_name || '');
  if (origin?.type === 'chat' || origin?.type === 'channel') {
    return String(origin.chat?.title || origin.sender_chat?.title || '');
  }
  if (rawMessage.forward_from) return telegramUserDisplayName(rawMessage.forward_from);
  if (rawMessage.forward_from_chat?.title) return String(rawMessage.forward_from_chat.title);
  return '';
}

function destinationChannelOf(existing: any): string {
  return String(existing?.destinationChannelId || existing?.delivery?.target || '').trim();
}

function destinationProviderId(existing: any): string {
  return String(existing?.delivery?.providerMessageId ?? '').trim();
}

export async function resolveReplyContext(normalized: any): Promise<any> {
  const metadata = { ...(normalized.metadata ?? {}) };

  if (normalized.source === 'telegram') {
    const replyTo = metadata.replyToTelegramMessageId;
    const sameChatForwardId = metadata.forwardFromTelegramMessageId;
    const parentId = replyTo || sameChatForwardId;
    if (parentId) {
      const parent = await findMessageByTelegramRef({
        chatId: normalized.channelId,
        messageId: parentId,
      });
      const slackTs = String(
        parent?.source === 'telegram'
          ? parent?.delivery?.providerMessageId || parent?.metadata?.slackTs || ''
          : parent?.metadata?.slackTs || parent?.externalId || '',
      ).trim();
      if (slackTs) {
        normalized.threadTs = slackTs;
        metadata.threadTs = slackTs;
        metadata.replyParentExternalId = parent?.externalId ?? '';
      } else if (parent) {
        const permalink = slackPermalink(parent.destinationChannelId || parent.channelId, parent.delivery?.providerMessageId);
        metadata.replyFallback = permalink || String(parent.text || '').slice(0, 180);
      }
    }
  }

  if (normalized.source === 'slack') {
    const threadTs = String(metadata.threadTs ?? normalized.threadTs ?? '').trim();
    if (threadTs) {
      const parent = await findMessageBySlackRef({
        ts: threadTs,
        channelId: normalized.channelId,
      });
      const telegramId = String(
        parent?.source === 'slack'
          ? parent?.delivery?.providerMessageId || parent?.metadata?.telegramMessageId || ''
          : parent?.metadata?.telegramMessageId || '',
      ).trim();
      if (telegramId) {
        normalized.replyToMessageId = telegramId;
        metadata.replyToTelegramMessageId = telegramId;
        metadata.replyParentExternalId = parent?.externalId ?? '';
      } else {
        const permalink = slackPermalink(normalized.channelId, threadTs);
        metadata.replyFallback = permalink;
        if (permalink && normalized.text && !String(normalized.text).includes(permalink)) {
          normalized.text = `${normalized.text}\n${permalink}`;
        }
      }
    }
  }

  if (metadata.forwardedFrom && normalized.source === 'telegram' && normalized.text) {
    const prefix = `↪ Forwarded from ${metadata.forwardedFrom}`;
    if (!String(normalized.text).startsWith('↪ Forwarded from')) {
      normalized.text = `${prefix}\n${normalized.text}`;
    }
  }

  normalized.metadata = metadata;
  return normalized;
}

export async function findExistingForMutation(source: string, normalized: any): Promise<any> {
  if (source === 'slack') {
    const found = await findMessageBySlackRef({
      ts: normalized.metadata?.slackTs || normalized.externalId,
      clientMsgId: normalized.metadata?.clientMsgId,
      channelId: normalized.channelId,
    });
    if (found) return found;
  }
  if (source === 'telegram') {
    const found = await findMessageByTelegramRef({
      chatId: normalized.channelId,
      messageId: normalized.metadata?.telegramMessageId || String(normalized.externalId).split(':').pop(),
    });
    if (found) return found;
  }
  return findMessageByExternalId(normalized.source, normalized.externalId);
}

export async function processBridgedEdit(normalized: any, existing: any): Promise<any> {
  if (!existing) {
    void logAction({
      action: 'message.edit.skipped',
      category: 'message',
      level: 'warn',
      source: normalized.source,
      message: 'Edit ignored because the original bridged message was not found',
      actor: { userId: String(normalized.userId ?? ''), userName: normalized.userName ?? '' },
      externalId: String(normalized.externalId ?? ''),
      context: { reason: 'original_not_found' },
    });
    return { duplicate: false, ignored: true, reason: 'edit_original_not_found' };
  }

  if (!isOwnMessage(existing, normalized.userId)) {
    void logAction({
      action: 'message.edit.denied',
      category: 'message',
      level: 'warn',
      source: normalized.source,
      message: 'Edit ignored: only the original author can edit their own message',
      actor: { userId: String(normalized.userId ?? ''), userName: normalized.userName ?? '' },
      externalId: String(existing.externalId ?? ''),
      context: { reason: 'not_author', originalUserId: existing.userId },
    });
    return { duplicate: false, ignored: true, reason: 'edit_not_author', message: existing };
  }

  if (String(existing.text ?? '') === String(normalized.text ?? '') && !(existing.metadata?.deleted)) {
    return { duplicate: true, ignored: true, reason: 'edit_unchanged', message: existing };
  }

  const destChannel = destinationChannelOf(existing);
  const destId = destinationProviderId(existing);
  const payload = {
    ...existing,
    ...normalized,
    userName: existing.userName || normalized.userName,
    destinationChannelId: destChannel,
    slackTs: existing.source === 'telegram' ? destId : existing.metadata?.slackTs,
    telegramMessageId: existing.source === 'slack' ? destId : existing.metadata?.telegramMessageId,
    delivery: existing.delivery,
  };

  const delivery =
    existing.destination === 'slack' || existing.source === 'telegram'
      ? await updateSlackMessage({ ...payload, destinationChannelId: destChannel, slackTs: destId })
      : await updateTelegramMessage({ ...payload, destinationChannelId: destChannel, telegramMessageId: destId });

  const updated = await updateMessageRecord(existing.source, existing.externalId, {
    text: normalized.text,
    files: normalized.files ?? existing.files,
    metadata: {
      ...(existing.metadata ?? {}),
      ...(normalized.metadata ?? {}),
      editedAt: new Date().toISOString(),
      editedFrom: normalized.source,
    },
    delivery: { ...(existing.delivery ?? {}), lastEdit: delivery },
  });

  void logAction({
    action: delivery?.status === 'failed' ? 'message.edit.failed' : 'message.edited',
    category: 'message',
    level: delivery?.status === 'failed' ? 'error' : 'info',
    source: normalized.source,
    message: 'Bridged message edited on the far side',
    actor: { userId: String(normalized.userId ?? ''), userName: normalized.userName ?? '' },
    externalId: String(existing.externalId ?? ''),
    context: { deliveryStatus: delivery?.status ?? null, action: 'edit' },
  });

  return { duplicate: false, edited: true, message: updated ?? existing, delivery };
}

export async function processBridgedDelete(normalized: any, existing: any): Promise<any> {
  if (!existing) {
    void logAction({
      action: 'message.delete.skipped',
      category: 'message',
      level: 'warn',
      source: normalized.source,
      message: 'Delete ignored because the original bridged message was not found',
      actor: { userId: String(normalized.userId ?? ''), userName: normalized.userName ?? '' },
      externalId: String(normalized.externalId ?? ''),
      context: { reason: 'original_not_found' },
    });
    return { duplicate: false, ignored: true, reason: 'delete_original_not_found' };
  }

  if (existing.metadata?.deleted) {
    return { duplicate: true, ignored: true, reason: 'already_deleted', message: existing };
  }

  const destChannel = destinationChannelOf(existing);
  const destId = destinationProviderId(existing);
  const delivery =
    existing.destination === 'slack' || existing.source === 'telegram'
      ? await deleteSlackMessage({ channel: destChannel, ts: destId })
      : await removeTelegramMessage({ chatId: destChannel, messageId: destId });

  const updated = await updateMessageRecord(existing.source, existing.externalId, {
    metadata: {
      ...(existing.metadata ?? {}),
      deleted: true,
      deletedAt: new Date().toISOString(),
      deletedFrom: normalized.source,
    },
    delivery: { ...(existing.delivery ?? {}), lastDelete: delivery },
  });

  void logAction({
    action: delivery?.status === 'failed' ? 'message.delete.failed' : 'message.deleted',
    category: 'message',
    level: delivery?.status === 'failed' ? 'error' : 'info',
    source: normalized.source,
    message: 'Bridged message deleted on the far side',
    actor: { userId: String(normalized.userId ?? ''), userName: normalized.userName ?? '' },
    externalId: String(existing.externalId ?? ''),
    context: { deliveryStatus: delivery?.status ?? null, action: 'delete' },
  });

  return { duplicate: false, deleted: true, message: updated ?? existing, delivery };
}

export function telegramRawMessage(payload: any) {
  return payload?.edited_message ?? payload?.edited_channel_post ?? payload?.message ?? payload?.channel_post ?? payload;
}

export function isTelegramEditPayload(payload: any): boolean {
  return Boolean(payload?.edited_message || payload?.edited_channel_post);
}

export function isTelegramBotUpdate(payload: any): boolean {
  const message = telegramRawMessage(payload);
  return Boolean(message?.from?.is_bot);
}

export function telegramReplyToMessageId(rawMessage: any): string {
  const reply = rawMessage?.reply_to_message;
  if (!reply?.message_id) return '';
  return String(reply.message_id);
}

export function telegramSameChatForwardMessageId(rawMessage: any): string {
  const chatId = String(rawMessage?.chat?.id ?? '');
  const originChatId = String(
    rawMessage?.forward_from_chat?.id ??
      rawMessage?.forward_origin?.chat?.id ??
      rawMessage?.forward_origin?.sender_chat?.id ??
      '',
  );
  const originMessageId = rawMessage?.forward_from_message_id ?? rawMessage?.forward_origin?.message_id;
  if (!chatId || !originChatId || String(chatId) !== String(originChatId) || !originMessageId) return '';
  return String(originMessageId);
}
