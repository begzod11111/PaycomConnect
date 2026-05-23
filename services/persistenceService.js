import { ChannelLink } from '../models/channelLink.js';
import { Contact } from '../models/contact.js';
import { JiraIssue } from '../models/jiraIssue.js';
import { Message } from '../models/message.js';
import { models } from "../models/db.js";
import {isMongoConnected} from "./databaseService.js";

const memoryStore = {
  contacts: new Map(),
  messages: [],
  jiraIssues: [],
  channelLinks: new Map(),
};

function toPlainObject(document) {
  if (!document) {
    return null;
  }
  return typeof document.toObject === 'function' ? document.toObject() : document;
}

function toMemoryLink(link) {
  return {
    ...link,
    updatedAt: new Date().toISOString(),
  };
}

// ========== ПОИСК СВЯЗОК ==========

export async function findConnectionByInn(inn) {
  if (!inn) {
    return null;
  }

  if (isMongoConnected()) {
    const connect = await models.ChannelLink.findOne({ inn }).lean();
    return connect || null;
  }

  console.log('🔍 Searching connection in memory by INN:', inn);
  return memoryStore.channelLinks.get(String(inn)) || null;
}

export async function findConnectionBySourceChannel(source, channelId) {
  if (!channelId) {
    return null;
  }

  const query = source === 'telegram'
    ? { telegramChatId: String(channelId) }
    : { slackChannelId: String(channelId) };

  if (isMongoConnected()) {
    console.log('🔍 Searching connection by channel:', { source, channelId });
    return ChannelLink.findOne(query).lean();
  }

  for (const link of memoryStore.channelLinks.values()) {
    if (source === 'telegram' && String(link.telegramChatId) === String(channelId)) {
      return link;
    }
    if (source === 'slack' && String(link.slackChannelId) === String(channelId)) {
      return link;
    }
  }

  return null;
}

export async function deactivateConnectionBySourceChannel(source, channelId, metadata = {}) {
  if (!channelId) {
    return null;
  }

  const query = source === 'telegram'
    ? { telegramChatId: String(channelId) }
    : { slackChannelId: String(channelId) };

  if (isMongoConnected()) {
    const existing = await ChannelLink.findOne(query).lean();
    if (!existing) {
      return null;
    }

    const mergedMetadata = {
      ...(existing.metadata ?? {}),
      ...(metadata ?? {}),
      lastDeactivatedAt: new Date().toISOString(),
    };

    return ChannelLink.findOneAndUpdate(
      { _id: existing._id },
      {
        $set: {
          status: 'suspended',
          metadata: mergedMetadata,
          lastActivityAt: new Date(),
        },
      },
      { new: true },
    ).lean();
  }

  for (const [inn, link] of memoryStore.channelLinks.entries()) {
    const isMatch = source === 'telegram'
      ? String(link.telegramChatId) === String(channelId)
      : String(link.slackChannelId) === String(channelId);

    if (!isMatch) continue;

    const updated = toMemoryLink({
      ...link,
      status: 'suspended',
      metadata: {
        ...(link.metadata ?? {}),
        ...(metadata ?? {}),
        lastDeactivatedAt: new Date().toISOString(),
      },
      lastActivityAt: new Date().toISOString(),
    });

    memoryStore.channelLinks.set(inn, updated);
    return updated;
  }

  return null;
}

// ========== СОХРАНЕНИЕ TELEGRAM СВЯЗКИ ==========

export async function upsertTelegramConnection(record) {
  const existing = await findConnectionByInn(record.inn);

  if (isMongoConnected()) {
    console.log('💾 Saving Telegram connection to MongoDB:', {
      inn: record.inn,
      chatId: record.telegramChatId,
      chatTitle: record.telegramChatTitle,
      initiator: record.telegramInitiatorName,
    });

    const payload = {
      inn: record.inn,
      telegramChatId: String(record.telegramChatId),
      telegramChatTitle: record.telegramChatTitle ?? '',
      telegramChatType: record.telegramChatType ?? '',
      telegramInitiatorId: String(record.telegramInitiatorId ?? ''),
      telegramInitiatorName: record.telegramInitiatorName ?? '',
      jiraIssueKey: record.jiraIssueKey ?? existing?.jiraIssueKey ?? '',
      jiraIssueUrl: record.jiraIssueUrl ?? existing?.jiraIssueUrl ?? '',
      jiraTaskKeys: record.jiraTaskKeys ?? existing?.jiraTaskKeys ?? [],
      slackChannelId: String(record.slackChannelId ?? existing?.slackChannelId ?? ''),
      slackChannelName: record.slackChannelName ?? existing?.slackChannelName ?? '',
      slackTeamId: record.slackTeamId ?? existing?.slackTeamId ?? '',
      slackUserId: String(record.slackUserId ?? existing?.slackUserId ?? ''),
      slackUserName: record.slackUserName ?? existing?.slackUserName ?? '',
      managers: record.managers ?? existing?.managers ?? [],
      integrators: record.integrators ?? existing?.integrators ?? [],
      activationSource: 'telegram',
      metadata: {
        ...(existing?.metadata ?? {}),
        ...(record.metadata ?? {}),
      },
      status: (record.slackChannelId || existing?.slackChannelId) ? 'linked' : 'pending_slack',
      linkedAt: (record.slackChannelId || existing?.slackChannelId) ? new Date() : existing?.linkedAt ?? null,
      lastActivityAt: new Date(),
    };

    try {
      const updated = await ChannelLink.findOneAndUpdate(
        { inn: record.inn },
        { $set: payload },
        { new: true, upsert: true, setDefaultsOnInsert: true },
      ).lean();

      console.log('✅ Telegram connection saved to MongoDB:', {
        id: updated._id,
        inn: updated.inn,
        status: updated.status,
      });

      return updated;
    } catch (error) {
      console.error('❌ Failed to save Telegram connection:', error.message);
      throw error;
    }
  }

  // Memory store fallback
  console.log('⚠️  Saving Telegram connection to memory (MongoDB not connected)');

  const updated = toMemoryLink({
    inn: record.inn,
    status: (record.slackChannelId || existing?.slackChannelId) ? 'linked' : 'pending_slack',
    telegramChatId: String(record.telegramChatId),
    telegramChatTitle: record.telegramChatTitle ?? '',
    telegramChatType: record.telegramChatType ?? '',
    telegramInitiatorId: String(record.telegramInitiatorId ?? ''),
    telegramInitiatorName: record.telegramInitiatorName ?? '',
    jiraIssueKey: record.jiraIssueKey ?? existing?.jiraIssueKey ?? '',
    jiraIssueUrl: record.jiraIssueUrl ?? existing?.jiraIssueUrl ?? '',
    jiraTaskKeys: record.jiraTaskKeys ?? existing?.jiraTaskKeys ?? [],
    slackChannelId: String(record.slackChannelId ?? existing?.slackChannelId ?? ''),
    slackChannelName: record.slackChannelName ?? existing?.slackChannelName ?? '',
    slackTeamId: record.slackTeamId ?? existing?.slackTeamId ?? '',
    slackUserId: String(record.slackUserId ?? existing?.slackUserId ?? ''),
    slackUserName: record.slackUserName ?? existing?.slackUserName ?? '',
    managers: record.managers ?? existing?.managers ?? [],
    integrators: record.integrators ?? existing?.integrators ?? [],
    activationSource: 'telegram',
    metadata: {
      ...(existing?.metadata ?? {}),
      ...(record.metadata ?? {}),
    },
    linkedAt: (record.slackChannelId || existing?.slackChannelId) ? new Date().toISOString() : existing?.linkedAt ?? null,
    lastActivityAt: new Date().toISOString(),
    createdAt: existing?.createdAt ?? new Date().toISOString(),
  });

  memoryStore.channelLinks.set(record.inn, updated);
  console.log('✅ Saved to memory store');
  return updated;
}

// ========== СОХРАНЕНИЕ SLACK СВЯЗКИ ==========

export async function upsertSlackConnection(record) {
  const existing = await findConnectionByInn(record.inn);

  if (isMongoConnected()) {
    console.log('💾 Saving Slack connection to MongoDB:', {
      inn: record.inn,
      channelId: record.slackChannelId,
      channelName: record.slackChannelName,
      user: record.slackUserName,
    });

    const payload = {
      inn: record.inn,
      slackChannelId: String(record.slackChannelId),
      slackChannelName: record.slackChannelName ?? '',
      slackTeamId: record.slackTeamId ?? '',
      slackUserId: String(record.slackUserId ?? ''),
      slackUserName: record.slackUserName ?? '',
      activationSource: 'slack',
      metadata: {
        ...(existing?.metadata ?? {}),
        ...(record.metadata ?? {}),
      },
      status: existing?.telegramChatId ? 'linked' : 'pending_telegram',
      linkedAt: existing?.telegramChatId ? new Date() : existing?.linkedAt ?? null,
      lastActivityAt: new Date(),
    };

    try {
      const updated = await ChannelLink.findOneAndUpdate(
        { inn: record.inn },
        { $set: payload },
        { new: true, upsert: true, setDefaultsOnInsert: true },
      ).lean();

      console.log('✅ Slack connection saved to MongoDB:', {
        id: updated._id,
        inn: updated.inn,
        status: updated.status,
      });

      return updated;
    } catch (error) {
      console.error('❌ Failed to save Slack connection:', error.message);
      throw error;
    }
  }

  // Memory store fallback
  console.log('⚠️  Saving Slack connection to memory (MongoDB not connected)');

  const updated = toMemoryLink({
    inn: record.inn,
    status: existing?.telegramChatId ? 'linked' : 'pending_telegram',
    telegramChatId: existing?.telegramChatId ?? '',
    telegramChatTitle: existing?.telegramChatTitle ?? '',
    telegramChatType: existing?.telegramChatType ?? '',
    telegramInitiatorId: existing?.telegramInitiatorId ?? '',
    telegramInitiatorName: existing?.telegramInitiatorName ?? '',
    slackChannelId: String(record.slackChannelId),
    slackChannelName: record.slackChannelName ?? '',
    slackTeamId: record.slackTeamId ?? '',
    slackUserId: String(record.slackUserId ?? ''),
    slackUserName: record.slackUserName ?? '',
    activationSource: 'slack',
    metadata: {
      ...(existing?.metadata ?? {}),
      ...(record.metadata ?? {}),
    },
    linkedAt: existing?.telegramChatId ? new Date().toISOString() : existing?.linkedAt ?? null,
    lastActivityAt: new Date().toISOString(),
    createdAt: existing?.createdAt ?? new Date().toISOString(),
  });

  memoryStore.channelLinks.set(record.inn, updated);
  console.log('✅ Saved to memory store');
  return updated;
}

// ========== СПИСОК СВЯЗОК ==========

export async function listConnections() {
  if (isMongoConnected()) {
    return ChannelLink.find().sort({ updatedAt: -1 }).lean();
  }

  return [...memoryStore.channelLinks.values()].sort(
    (left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime(),
  );
}

// ========== СТАТИСТИКА ==========

export async function getAnalyticsSummary() {
  if (isMongoConnected()) {
    const [links, messages, contacts, jiraIssues, firstInteractions, forwardedMessages] = await Promise.all([
      ChannelLink.find().lean(),
      Message.countDocuments(),
      Contact.countDocuments(),
      JiraIssue.countDocuments(),
      Message.countDocuments({ firstInteraction: true }),
      Message.countDocuments({ 'delivery.status': { $in: ['sent', 'mocked'] } }),
    ]);

    return {
      totalConnections: links.length,
      linkedConnections: links.filter((item) => item.status === 'linked').length,
      pendingConnections: links.filter((item) => item.status !== 'linked').length,
      totalMessages: messages,
      totalContacts: contacts,
      firstInteractions,
      jiraIssuesTriggered: jiraIssues,
      forwardedMessages,
    };
  }

  return {
    totalConnections: memoryStore.channelLinks.size,
    linkedConnections: [...memoryStore.channelLinks.values()].filter((item) => item.status === 'linked').length,
    pendingConnections: [...memoryStore.channelLinks.values()].filter((item) => item.status !== 'linked').length,
    totalMessages: memoryStore.messages.length,
    totalContacts: memoryStore.contacts.size,
    firstInteractions: memoryStore.messages.filter((item) => item.firstInteraction).length,
    jiraIssuesTriggered: memoryStore.jiraIssues.length,
    forwardedMessages: memoryStore.messages.filter((item) => ['sent', 'mocked'].includes(item.delivery?.status)).length,
  };
}

// ========== ОЧИСТКА ==========

export function resetMemoryStore() {
  memoryStore.contacts.clear();
  memoryStore.messages.length = 0;
  memoryStore.jiraIssues.length = 0;
  memoryStore.channelLinks.clear();
}

export async function findMessageByExternalId(source, externalId) {
  if (isMongoConnected()) {
    return Message.findOne({ source, externalId }).lean();
  }

  return memoryStore.messages.find(
    (message) => message.source === source && String(message.externalId) === String(externalId),
  ) || null;
}

export async function saveMessage(record) {
  if (isMongoConnected()) {
    return toPlainObject(await Message.create(record));
  }

  const message = {
    ...record,
    _id: record._id ?? `mem-msg-${memoryStore.messages.length + 1}`,
    createdAt: record.createdAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  memoryStore.messages.push(message);
  return message;
}

export async function upsertContact(record) {
  const key = `${record.platform}:${record.userId}`;

  if (isMongoConnected()) {
    const existing = await Contact.findOne({ platform: record.platform, userId: String(record.userId) }).lean();
    const contact = await Contact.findOneAndUpdate(
      { platform: record.platform, userId: String(record.userId) },
      {
        $set: {
          userName: record.userName ?? '',
          channelId: String(record.channelId ?? ''),
          lastInteractionAt: record.messageTimestamp ? new Date(record.messageTimestamp) : new Date(),
        },
        $setOnInsert: {
          platform: record.platform,
          userId: String(record.userId),
          firstInteractionAt: record.messageTimestamp ? new Date(record.messageTimestamp) : new Date(),
        },
      },
      { new: true, upsert: true, setDefaultsOnInsert: true },
    ).lean();

    return { contact, isFirstInteraction: !existing };
  }

  const existing = memoryStore.contacts.get(key);
  const contact = {
    ...(existing ?? {}),
    platform: record.platform,
    userId: String(record.userId),
    userName: record.userName ?? existing?.userName ?? '',
    channelId: String(record.channelId ?? existing?.channelId ?? ''),
    firstInteractionAt: existing?.firstInteractionAt ?? record.messageTimestamp ?? new Date().toISOString(),
    lastInteractionAt: record.messageTimestamp ?? new Date().toISOString(),
  };
  memoryStore.contacts.set(key, contact);

  return { contact, isFirstInteraction: !existing };
}

export async function saveJiraIssue(record) {
  if (isMongoConnected()) {
    return toPlainObject(await JiraIssue.create(record));
  }

  const issue = {
    ...record,
    _id: record._id ?? `mem-jira-${memoryStore.jiraIssues.length + 1}`,
    createdAt: record.createdAt ?? new Date().toISOString(),
  };
  memoryStore.jiraIssues.push(issue);
  return issue;
}

export async function getRecentMessages(limit = 20) {
  if (isMongoConnected()) {
    return Message.find().sort({ createdAt: -1 }).limit(limit).lean();
  }

  return memoryStore.messages.slice(-limit).reverse();
}
