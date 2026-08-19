import { ActionLog, ChannelLink, Contact, JiraIssue, Message, models } from './models';
import { isMongoConnected } from './database';

// Faithful port of services/persistenceService.js (Mongo + in-memory fallback).
const memoryStore = {
  contacts: new Map<string, any>(),
  messages: [] as any[],
  jiraIssues: [] as any[],
  channelLinks: new Map<string, any>(),
  actionLogs: [] as any[],
};

function toPlainObject(document: any) {
  if (!document) return null;
  return typeof document.toObject === 'function' ? document.toObject() : document;
}

function toMemoryLink(link: any) {
  return { ...link, updatedAt: new Date().toISOString() };
}

export async function findConnectionByInn(inn: string) {
  if (!inn) return null;
  if (isMongoConnected()) {
    const connect = await models.ChannelLink.findOne({ inn }).lean();
    return connect || null;
  }
  return memoryStore.channelLinks.get(String(inn)) || null;
}

export async function findConnectionBySourceChannel(source: string, channelId: string) {
  if (!channelId) return null;
  const query =
    source === 'telegram'
      ? { telegramChatId: String(channelId) }
      : { slackChannelId: String(channelId) };

  if (isMongoConnected()) {
    return ChannelLink.findOne(query).lean();
  }

  for (const link of memoryStore.channelLinks.values()) {
    if (source === 'telegram' && String(link.telegramChatId) === String(channelId)) return link;
    if (source === 'slack' && String(link.slackChannelId) === String(channelId)) return link;
  }
  return null;
}

export async function remapTelegramChatId(fromChatId: string, toChatId: string) {
  if (!fromChatId || !toChatId || String(fromChatId) === String(toChatId)) return null;
  const existing: any = await findConnectionBySourceChannel('telegram', String(fromChatId));
  if (!existing) return null;

  if (isMongoConnected()) {
    return ChannelLink.findOneAndUpdate(
      { _id: existing._id },
      {
        $set: {
          telegramChatId: String(toChatId),
          lastActivityAt: new Date(),
          metadata: {
            ...(existing.metadata ?? {}),
            migratedFromChatId: String(fromChatId),
            migratedToChatId: String(toChatId),
            migratedAt: new Date().toISOString(),
          },
        },
      },
      { new: true },
    ).lean();
  }

  const updated = toMemoryLink({
    ...existing,
    telegramChatId: String(toChatId),
    metadata: {
      ...(existing.metadata ?? {}),
      migratedFromChatId: String(fromChatId),
      migratedToChatId: String(toChatId),
      migratedAt: new Date().toISOString(),
    },
  });
  memoryStore.channelLinks.set(existing.inn, updated);
  return updated;
}

export async function deactivateConnectionBySourceChannel(
  source: string,
  channelId: string,
  metadata: any = {},
) {
  if (!channelId) return null;
  const query =
    source === 'telegram'
      ? { telegramChatId: String(channelId) }
      : { slackChannelId: String(channelId) };

  if (isMongoConnected()) {
    const existing: any = await ChannelLink.findOne(query).lean();
    if (!existing) return null;
    const mergedMetadata = {
      ...(existing.metadata ?? {}),
      ...(metadata ?? {}),
      lastDeactivatedAt: new Date().toISOString(),
    };
    return ChannelLink.findOneAndUpdate(
      { _id: existing._id },
      { $set: { status: 'suspended', metadata: mergedMetadata, lastActivityAt: new Date() } },
      { new: true },
    ).lean();
  }

  for (const [inn, link] of memoryStore.channelLinks.entries()) {
    const isMatch =
      source === 'telegram'
        ? String(link.telegramChatId) === String(channelId)
        : String(link.slackChannelId) === String(channelId);
    if (!isMatch) continue;
    const updated = toMemoryLink({
      ...link,
      status: 'suspended',
      metadata: { ...(link.metadata ?? {}), ...(metadata ?? {}), lastDeactivatedAt: new Date().toISOString() },
      lastActivityAt: new Date().toISOString(),
    });
    memoryStore.channelLinks.set(inn, updated);
    return updated;
  }
  return null;
}

export async function upsertTelegramConnection(record: any) {
  const existing = await findConnectionByInn(record.inn);

  if (isMongoConnected()) {
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
      metadata: { ...(existing?.metadata ?? {}), ...(record.metadata ?? {}) },
      status: record.slackChannelId || existing?.slackChannelId ? 'linked' : 'pending_slack',
      linkedAt: record.slackChannelId || existing?.slackChannelId ? new Date() : existing?.linkedAt ?? null,
      lastActivityAt: new Date(),
    };
    const updated = await ChannelLink.findOneAndUpdate(
      { inn: record.inn },
      { $set: payload },
      { new: true, upsert: true, setDefaultsOnInsert: true },
    ).lean();
    return updated;
  }

  const updated = toMemoryLink({
    inn: record.inn,
    status: record.slackChannelId || existing?.slackChannelId ? 'linked' : 'pending_slack',
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
    metadata: { ...(existing?.metadata ?? {}), ...(record.metadata ?? {}) },
    linkedAt: record.slackChannelId || existing?.slackChannelId ? new Date().toISOString() : existing?.linkedAt ?? null,
    lastActivityAt: new Date().toISOString(),
    createdAt: existing?.createdAt ?? new Date().toISOString(),
  });
  memoryStore.channelLinks.set(record.inn, updated);
  return updated;
}

export async function upsertSlackConnection(record: any) {
  const existing = await findConnectionByInn(record.inn);

  if (isMongoConnected()) {
    const payload = {
      inn: record.inn,
      slackChannelId: String(record.slackChannelId),
      slackChannelName: record.slackChannelName ?? '',
      slackTeamId: record.slackTeamId ?? '',
      slackUserId: String(record.slackUserId ?? ''),
      slackUserName: record.slackUserName ?? '',
      activationSource: 'slack',
      metadata: { ...(existing?.metadata ?? {}), ...(record.metadata ?? {}) },
      status: existing?.telegramChatId ? 'linked' : 'pending_telegram',
      linkedAt: existing?.telegramChatId ? new Date() : existing?.linkedAt ?? null,
      lastActivityAt: new Date(),
    };
    const updated = await ChannelLink.findOneAndUpdate(
      { inn: record.inn },
      { $set: payload },
      { new: true, upsert: true, setDefaultsOnInsert: true },
    ).lean();
    return updated;
  }

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
    metadata: { ...(existing?.metadata ?? {}), ...(record.metadata ?? {}) },
    linkedAt: existing?.telegramChatId ? new Date().toISOString() : existing?.linkedAt ?? null,
    lastActivityAt: new Date().toISOString(),
    createdAt: existing?.createdAt ?? new Date().toISOString(),
  });
  memoryStore.channelLinks.set(record.inn, updated);
  return updated;
}

export async function listConnections() {
  if (isMongoConnected()) {
    return ChannelLink.find().sort({ updatedAt: -1 }).lean();
  }
  return [...memoryStore.channelLinks.values()].sort(
    (l, r) => new Date(r.updatedAt).getTime() - new Date(l.updatedAt).getTime(),
  );
}

export async function getAnalyticsSummary() {
  if (isMongoConnected()) {
    const [
      links,
      messages,
      contacts,
      jiraIssues,
      firstInteractions,
      forwardedMessages,
      employeeMessages,
      actionLogs,
    ] = await Promise.all([
      ChannelLink.find().lean(),
      Message.countDocuments(),
      Contact.countDocuments(),
      JiraIssue.countDocuments(),
      Message.countDocuments({ firstInteraction: true }),
      Message.countDocuments({ 'delivery.status': { $in: ['sent', 'mocked'] } }),
      Message.countDocuments({ 'sender.isEmployee': true }),
      ActionLog.countDocuments(),
    ]);
    return {
      totalConnections: links.length,
      linkedConnections: links.filter((i: any) => i.status === 'linked').length,
      pendingConnections: links.filter((i: any) => i.status !== 'linked').length,
      totalMessages: messages,
      totalContacts: contacts,
      firstInteractions,
      jiraIssuesTriggered: jiraIssues,
      forwardedMessages,
      employeeMessages,
      totalActionLogs: actionLogs,
    };
  }

  const links = [...memoryStore.channelLinks.values()];
  return {
    totalConnections: memoryStore.channelLinks.size,
    linkedConnections: links.filter((i) => i.status === 'linked').length,
    pendingConnections: links.filter((i) => i.status !== 'linked').length,
    totalMessages: memoryStore.messages.length,
    totalContacts: memoryStore.contacts.size,
    firstInteractions: memoryStore.messages.filter((i) => i.firstInteraction).length,
    jiraIssuesTriggered: memoryStore.jiraIssues.length,
    forwardedMessages: memoryStore.messages.filter((i) => ['sent', 'mocked'].includes(i.delivery?.status)).length,
    employeeMessages: memoryStore.messages.filter((i) => i.sender?.isEmployee).length,
    totalActionLogs: memoryStore.actionLogs.length,
  };
}

export function resetMemoryStore() {
  memoryStore.contacts.clear();
  memoryStore.messages.length = 0;
  memoryStore.jiraIssues.length = 0;
  memoryStore.channelLinks.clear();
  memoryStore.actionLogs.length = 0;
}

export async function saveActionLog(record: any) {
  if (isMongoConnected()) {
    return toPlainObject(await ActionLog.create(record));
  }
  const log = {
    ...record,
    _id: record._id ?? `mem-log-${memoryStore.actionLogs.length + 1}`,
    createdAt: record.createdAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  memoryStore.actionLogs.push(log);
  return log;
}

export async function getRecentActionLogs(limit = 50, filter: any = {}) {
  const query: any = {};
  if (filter.category) query.category = filter.category;
  if (filter.action) query.action = filter.action;
  if (filter.connectionInn) query.connectionInn = filter.connectionInn;

  if (isMongoConnected()) {
    return ActionLog.find(query).sort({ createdAt: -1 }).limit(limit).lean();
  }

  const matches = memoryStore.actionLogs.filter((log) =>
    Object.entries(query).every(([key, value]) => log[key] === value),
  );
  return matches.slice(-limit).reverse();
}

export async function findMessageByExternalId(source: string, externalId: string) {
  if (isMongoConnected()) {
    return Message.findOne({ source, externalId }).lean();
  }
  return (
    memoryStore.messages.find(
      (m) => m.source === source && String(m.externalId) === String(externalId),
    ) || null
  );
}

export async function findMessagesByChannel(source: string, channelId: string) {
  if (!channelId) return [];
  if (isMongoConnected()) {
    return Message.find({ source, channelId: String(channelId) }).sort({ createdAt: 1 }).lean();
  }
  return memoryStore.messages.filter(
    (m) => m.source === source && String(m.channelId) === String(channelId),
  );
}

export async function updateMessageRecord(source: string, externalId: string, patch: any) {
  if (!source || !externalId) return null;
  const next = { ...patch, updatedAt: new Date() };
  if (isMongoConnected()) {
    return Message.findOneAndUpdate({ source, externalId }, { $set: next }, { new: true }).lean();
  }
  const existing = memoryStore.messages.find(
    (m) => m.source === source && String(m.externalId) === String(externalId),
  );
  if (!existing) return null;
  Object.assign(existing, next);
  return existing;
}

export async function saveMessage(record: any) {
  if (isMongoConnected()) {
    try {
      return toPlainObject(await Message.create(record));
    } catch (error: any) {
      // Duplicate key: another worker already stored this inbound id.
      // Return the existing row instead of crashing the webhook pipeline.
      if (error?.code === 11000) {
        const existing = await Message.findOne({ source: record.source, externalId: record.externalId }).lean();
        if (existing) return existing;
      }
      throw error;
    }
  }
  const already = memoryStore.messages.find(
    (m) => m.source === record.source && String(m.externalId) === String(record.externalId),
  );
  if (already) return already;
  const message = {
    ...record,
    _id: record._id ?? `mem-msg-${memoryStore.messages.length + 1}`,
    createdAt: record.createdAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  memoryStore.messages.push(message);
  return message;
}

export async function upsertContact(record: any) {
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

export async function saveJiraIssue(record: any) {
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
