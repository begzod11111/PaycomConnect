import {
  deactivateConnectionBySourceChannel,
  findConnectionByInn,
  findConnectionBySourceChannel,
  listConnections,
  upsertSlackConnection,
  upsertTelegramConnection,
} from './persistenceService.js';
import { SlackApiService } from './SlackApiService.js';
import { SlackUser } from '../models/slackUser.js';
import { IntegrationDistributionService } from './integrationDistributionService.js';
import axios from 'axios';
import { env } from '../config/env.js';

const connectPattern = /^(?:\/(?:connect|activate)|connect|activate)\s+(\d{9,14})(?:\s+([A-Z][A-Z0-9]+-\d+))?$/i;
const innPattern = /^\d{9,14}$/;
const TEST_EMAIL_PREFIXES = ['begzod0426_test'];
const GROUP_CHAT_TYPES = ['group', 'supergroup'];
const CONNECT_ROLES = ['manager', 'owner', 'teamlead', 'cx_manager'];
const jiraKeyPattern = /^[A-Z][A-Z0-9]+-\d+$/;

async function resolveActiveManager(userId) {
  const manager = await SlackUser.findOne({ telegramId: String(userId) });
  if (!manager || manager.status !== 'active' || !CONNECT_ROLES.includes(manager.role)) {
    return null;
  }
  return manager;
}

function isTestEmail(email) {
  const lower = String(email ?? '').toLowerCase().trim();
  return TEST_EMAIL_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

function sanitizeSlackChannelName(name) {
  const cleaned = String(name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '');

  // Slack: от 1 до 80 символов
  return (cleaned || `pc-${Date.now()}`).slice(0, 80);
}

async function buildSlackConnectArtifacts({ inn, telegramChatTitle, manager }) {
  const channelName = sanitizeSlackChannelName(`${telegramChatTitle || 'telegram-chat'}-${inn}`);
  let channel;

  try {
    channel = await SlackApiService.createPrivateChannel(channelName);
  } catch (error) {
    if (!String(error.message).includes('name_taken')) {
      throw error;
    }

    const fallbackName = sanitizeSlackChannelName(`${channelName}-${Date.now().toString().slice(-4)}`);
    channel = await SlackApiService.createPrivateChannel(fallbackName);
  }

  const integrators = await IntegrationDistributionService.pickIntegratorsForConnect(1);

  const invitedUserIds = new Set(
    integrators
      .map((item) => item.slackId)
      .filter((id) => id && !String(id).startsWith('TEST_')),
  );

  const managerIsTest = isTestEmail(manager.email) || String(manager.slackId).startsWith('TEST_');
  if (!managerIsTest && manager.slackId) {
    invitedUserIds.add(manager.slackId);
  }

  if (invitedUserIds.size) {
    await SlackApiService.inviteToChannel(channel.id, [...invitedUserIds]);
  }

  return {
    channel,
    managerIsTest,
    integratorIds: integrators.map((item) => item._id),
    integratorSlackIds: integrators.map((item) => item.slackId).filter(Boolean),
    primaryIntegratorName: integrators[0]?.displayName || integrators[0]?.email || 'интегратор Payme',
    primaryIntegratorSlackId: integrators[0]?.slackId || '',
    primaryIntegratorLoad: integrators[0]?.activeConnects ?? 0,
  };
}

export function normalizeInn(value) {
  const normalized = String(value ?? '').replace(/\D/g, '');
  return innPattern.test(normalized) ? normalized : '';
}

export function parseConnectCommand(text) {
  const normalizedText = String(text ?? '').trim();
  const match = normalizedText.match(connectPattern);

  if (!match) {
    return null;
  }

  console.log('✅ Connect command parsed:', { inn: match[1], text: normalizedText });

  return {
    action: 'connect',
    inn: match[1],
    jiraTaskKey: (match[2] || '').toUpperCase(),
  };
}

export async function createTelegramConnectDraft({ inn, telegramChatId, telegramChatTitle, telegramChatType, userId, userName }) {
  if (!telegramChatId) {
    throw new Error('telegramChatId is required for Telegram activation');
  }

  if (!GROUP_CHAT_TYPES.includes(String(telegramChatType))) {
    return {
      status: 'denied',
      connection: null,
      message: '❌ Команда /connect доступна только в Telegram группах.',
    };
  }

  const manager = await resolveActiveManager(userId);
  if (!manager) {
    return {
      status: 'denied',
      connection: null,
      message: '❌ Команда /connect доступна только зарегистрированным и активным менеджерам.',
    };
  }

  const existing = await findConnectionByInn(inn);

  if (existing?.status === 'linked') {
    return {
      status: 'denied',
      connection: existing,
      message: `❌ Для INN ${inn} уже есть активный connect. Для повторной активации сначала деактивируйте текущий connect.`,
    };
  }

  const connection = await upsertTelegramConnection({
    inn,
    telegramChatId,
    telegramChatTitle,
    telegramChatType,
    telegramInitiatorId: userId,
    telegramInitiatorName: userName,
    managers: [manager._id],
    metadata: {
      lastTelegramDraftAt: new Date().toISOString(),
      draftCreatedByTelegram: true,
    },
  });

  await SlackUser.updateOne(
    { _id: manager._id },
    { $addToSet: { connects: connection._id } },
  );

  return {
    status: connection.status,
    connection,
    message: `✅ Connect для INN ${inn} создан. Теперь для активации отправьте: ${inn} PTI-12345`,
  };
}

async function validateJiraTaskActive(issueKey) {
  if (!env.jiraBaseUrl || !env.jiraEmail || !env.jiraApiToken) {
    throw new Error('Jira integration is not configured');
  }

  const url = `${env.jiraBaseUrl.replace(/\/$/, '')}/rest/api/3/issue/${encodeURIComponent(issueKey)}`;
  const response = await axios.get(url, {
    params: { fields: 'status,summary' },
    headers: {
      Authorization: `Basic ${Buffer.from(`${env.jiraEmail}:${env.jiraApiToken}`).toString('base64')}`,
      Accept: 'application/json',
    },
  });

  const issue = response.data;
  const statusCategory = issue?.fields?.status?.statusCategory?.key;
  return {
    issueKey: issue?.key ?? issueKey,
    summary: issue?.fields?.summary ?? '',
    statusName: issue?.fields?.status?.name ?? 'Unknown',
    isActive: statusCategory !== 'done',
  };
}

function formatJiraError(error, issueKey) {
  const status = error?.response?.status;
  const apiMessage = error?.response?.data?.errorMessages?.[0]
    || error?.response?.data?.message
    || error?.message
    || 'Unknown Jira API error';

  if (status === 401) {
    return `Jira auth failed (401). Проверьте JIRA_EMAIL/JIRA_API_TOKEN.`;
  }

  if (status === 403) {
    return `Нет доступа к Jira issue ${issueKey} (403). Проверьте права проекта.`;
  }

  if (status === 404) {
    return `Jira issue ${issueKey} не найден или у пользователя нет права Browse Projects (404).`;
  }

  return `Jira API error${status ? ` (${status})` : ''}: ${apiMessage}`;
}

export async function activateTelegramByInn({
  inn,
  jiraTaskKey,
  telegramChatId,
  telegramChatTitle,
  telegramChatType,
  userId,
  userName,
  requireExisting = false,
}) {
  console.log('🔗 Activating Telegram connection:', {
    inn,
    chatId: telegramChatId,
    chatTitle: telegramChatTitle,
    user: userName,
  });

  if (!telegramChatId) {
    throw new Error('telegramChatId is required for Telegram activation');
  }

  if (!jiraTaskKey && !env.jiraBaseUrl) {
    const connection = await upsertTelegramConnection({
      inn,
      telegramChatId,
      telegramChatTitle,
      telegramChatType,
      telegramInitiatorId: userId,
      telegramInitiatorName: userName,
      metadata: {
        lastTelegramActivationAt: new Date().toISOString(),
        jiraDisabledAtActivation: true,
      },
    });

    return {
      status: connection.status,
      connection,
      integratorGreeting: '',
      message:
        connection.status === 'linked'
          ? `✅ Связка по INN ${inn} завершена! Slack-канал уже подключен.`
          : `✅ INN ${inn} сохранен! Ожидается подключение Slack-стороны.`,
    };
  }

  if (!jiraTaskKey || !jiraKeyPattern.test(jiraTaskKey)) {
    return {
      status: 'denied',
      connection: null,
      message: '❌ Формат команды: /connect <INN> <JIRA_KEY>, пример: /connect 123456789 PTI-23424',
    };
  }

  if (!GROUP_CHAT_TYPES.includes(String(telegramChatType))) {
    return {
      status: 'denied',
      connection: null,
      message: '❌ Команда /connect доступна только в Telegram группах.',
    };
  }

  const manager = await resolveActiveManager(userId);
  if (!manager) {
    return {
      status: 'denied',
      connection: null,
      message: '❌ Команда /connect доступна только зарегистрированным и активным менеджерам.',
    };
  }

  const existing = await findConnectionByInn(inn);

  if (requireExisting && !existing) {
    return {
      status: 'denied',
      connection: null,
      message: `❌ Connect для INN ${inn} еще не создан. Сначала отправьте только INN, затем отдельным сообщением INN + PTI-ключ.`,
    };
  }

  const usedJiraKeys = Array.isArray(existing?.jiraTaskKeys) ? existing.jiraTaskKeys : [];

  if (usedJiraKeys.includes(jiraTaskKey)) {
    return {
      status: 'denied',
      connection: existing,
      message: `❌ Jira task ${jiraTaskKey} уже использовался для этого INN. Для повторной активации нужен новый task key.`,
    };
  }

  let jiraTask;
  try {
    jiraTask = await validateJiraTaskActive(jiraTaskKey);
  } catch (error) {
    return {
      status: 'failed',
      connection: existing,
      message: `❌ Ошибка проверки Jira task ${jiraTaskKey}: ${formatJiraError(error, jiraTaskKey)}`,
    };
  }

  if (!jiraTask.isActive) {
    return {
      status: 'denied',
      connection: existing,
      message: `❌ Jira task ${jiraTaskKey} не активен (статус: ${jiraTask.statusName}). Нужен активный task для connect.`,
    };
  }

  if (existing?.status === 'linked' && existing?.jiraIssueKey && existing.jiraIssueKey !== jiraTaskKey) {
    return {
      status: 'denied',
      connection: existing,
      message: `❌ Для INN ${inn} уже есть активный connect (task: ${existing.jiraIssueKey}). Закройте/деактивируйте текущий connect перед новой активацией.`,
    };
  }

  let slackArtifacts;
  try {
    slackArtifacts = await buildSlackConnectArtifacts({
      inn,
      telegramChatTitle,
      manager,
    });
  } catch (error) {
    console.error('❌ Failed to create private Slack channel:', error.message);
    return {
      status: 'failed',
      connection: null,
      message: `❌ Не удалось создать приватный Slack-канал: ${error.message}`,
    };
  }

  const connection = await upsertTelegramConnection({
    inn,
    jiraIssueKey: jiraTask.issueKey,
    jiraIssueUrl: `${env.jiraBaseUrl.replace(/\/$/, '')}/browse/${jiraTask.issueKey}`,
    jiraTaskKeys: [...usedJiraKeys, jiraTask.issueKey],
    telegramChatId,
    telegramChatTitle,
    telegramChatType,
    telegramInitiatorId: userId,
    telegramInitiatorName: userName,
    slackChannelId: slackArtifacts.channel.id,
    slackChannelName: slackArtifacts.channel.name,
    slackUserId: manager.slackId,
    slackUserName: manager.displayName || manager.email,
    managers: [manager._id],
    integrators: slackArtifacts.integratorIds,
    metadata: {
      lastTelegramActivationAt: new Date().toISOString(),
      autoSlackChannelCreated: true,
      managerIsTestNotInvited: slackArtifacts.managerIsTest,
      jiraTaskStatusAtActivation: jiraTask.statusName,
    },
  });

  const connectUserIds = [manager._id, ...slackArtifacts.integratorIds].filter(Boolean);
  if (connectUserIds.length) {
    await SlackUser.updateMany(
      { _id: { $in: connectUserIds } },
      { $addToSet: { connects: connection._id } },
    );
  }

  if (connection.status === 'linked' && connection.slackChannelId) {
    const integratorMention = slackArtifacts.primaryIntegratorSlackId
      ? `<@${slackArtifacts.primaryIntegratorSlackId}>`
      : slackArtifacts.primaryIntegratorName;

    try {
      await SlackApiService.sendMessage(
        connection.slackChannelId,
        `🤖 Система назначила ${integratorMention} на интеграцию.\n` +
          `• INN: ${inn}\n` +
          `• Jira: ${connection.jiraIssueUrl || jiraTask.issueKey}\n` +
          `• Telegram группа: ${telegramChatTitle || telegramChatId}`,
      );
    } catch (notifyError) {
      console.warn('Failed to send integrator assignment message to Slack channel:', notifyError.message);
    }
  }

  console.log('✅ Telegram activation complete:', {
    inn: connection.inn,
    status: connection.status,
    linkedAt: connection.linkedAt,
  });

  return {
    status: connection.status,
    connection,
    integratorGreeting:
      connection.status === 'linked'
        ? `Assalomu alaykum!\n` +
          `Ismim ${slackArtifacts.primaryIntegratorName}, Payme texnik mutaxassisiman. Integratsiya nima uchun mo'ljallangan: sayt, mobil ilova yoki Telegram-bot uchunmi?\n\n` +
          `Здравствуйте!\n` +
          `Меня зовут ${slackArtifacts.primaryIntegratorName}, я технический специалист Payme. Подскажите, для какой платформы планируется интеграция: сайт, мобильное приложение или Telegram-бот?`
        : '',
    message:
      connection.status === 'linked'
        ? `✅ Связка по INN ${inn} активирована по задаче ${jiraTask.issueKey}! Создан приватный Slack-канал #${connection.slackChannelName}.`
        : `✅ INN ${inn} сохранен! Ожидается подключение Slack-стороны.`,
  };
}

export async function activateSlackByInn({ inn, slackChannelId, slackChannelName, slackTeamId, userId, userName }) {
  console.log('🔗 Activating Slack connection:', {
    inn,
    channelId: slackChannelId,
    channelName: slackChannelName,
    user: userName,
  });

  if (!slackChannelId) {
    throw new Error('slackChannelId is required for Slack activation');
  }

  const connection = await upsertSlackConnection({
    inn,
    slackChannelId,
    slackChannelName,
    slackTeamId,
    slackUserId: userId,
    slackUserName: userName,
    metadata: {
      lastSlackActivationAt: new Date().toISOString(),
    },
  });

  console.log('✅ Slack activation complete:', {
    inn: connection.inn,
    status: connection.status,
    linkedAt: connection.linkedAt,
  });

  return {
    status: connection.status,
    connection,
    message:
      connection.status === 'linked'
        ? `✅ Связка по INN ${inn} завершена! Telegram-группа уже подключена.`
        : `✅ INN ${inn} сохранен! Ожидается Telegram-группа.`,
  };
}

export async function deactivateChannelConnect({ source, channelId, actorId, actorName }) {
  const updated = await deactivateConnectionBySourceChannel(source, channelId, {
    deactivatedBy: {
      id: String(actorId ?? ''),
      name: actorName ?? '',
    },
    deactivationSource: source,
    jiraClosureRequested: true,
    jiraClosureStatus: 'todo_stub',
  });

  if (!updated) {
    return {
      status: 'not_found',
      connection: null,
      message: '❌ Активная связка для этого канала не найдена.',
    };
  }

  return {
    status: 'suspended',
    connection: updated,
    message:
      `⏸️ Связка по INN ${updated.inn} деактивирована (канал отключен).\n` +
      `Jira закрытие задачи: запланировано (пока заглушка).`,
  };
}

export async function resolveDestinationForMessage(message) {
  const connection = await findConnectionBySourceChannel(message.source, message.channelId);

  if (!connection) {
    console.log('⚠️  Connection not found for:', {
      source: message.source,
      channelId: message.channelId,
    });

    return {
      connection: null,
      status: 'not_found',
      reason: 'Для этого канала еще не создана связка по INN. Выполните /connect <INN>',
    };
  }

  if (connection.status !== 'linked') {
    console.log('⏳ Connection pending:', {
      inn: connection.inn,
      status: connection.status,
    });

    return {
      connection,
      status: 'pending',
      reason:
        message.source === 'telegram'
          ? `Telegram-группа зарегистрирована (INN: ${connection.inn}), но Slack-сторона еще не подключена.`
          : `Slack-сторона зарегистрирована (INN: ${connection.inn}), но Telegram-группа еще не подключена.`,
    };
  }

  console.log('✅ Connection linked:', {
    inn: connection.inn,
    source: message.source,
    destination: message.source === 'telegram' ? 'slack' : 'telegram',
  });

  return {
    connection,
    status: 'linked',
    destinationChannelId: message.source === 'telegram' ? connection.slackChannelId : connection.telegramChatId,
  };
}

export async function getConnectionOverview() {
  const connections = await listConnections();
  console.log(`📊 Total connections: ${connections.length}`);
  return connections;
}
