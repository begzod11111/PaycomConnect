import dotenv from 'dotenv';

dotenv.config();

const defaultCorsOrigins = [
  'https://tamada.monitoring-jira.uz',
  'http://0.0.0.0:9000',
  'http://localhost:9000',
  'http://localhost:3000',
];

function parseCorsOrigins(value) {
  if (!value) {
    return defaultCorsOrigins;
  }

  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function toBoolean(value, defaultValue = false) {
  if (value === undefined) {
    return defaultValue;
  }

  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function normalizeBaseUrl(value) {
  const raw = String(value ?? '').trim();
  if (!raw) {
    return '';
  }

  if (/^https?:\/\//i.test(raw)) {
    return raw;
  }

  return `https://${raw}`;
}

// Разбирает список сервис-клиентов вида "name:secret,name2:secret2" в объект { name: secret }.
// secret — это 36-символьный ключ (буквы/цифры), см. docs/service-auth.md.
function parseServiceClients(value) {
  const clients = {};
  if (!value) {
    return clients;
  }

  for (const pair of String(value).split(',')) {
    const trimmed = pair.trim();
    if (!trimmed) {
      continue;
    }

    const separatorIndex = trimmed.indexOf(':');
    if (separatorIndex === -1) {
      continue;
    }

    const name = trimmed.slice(0, separatorIndex).trim();
    const secret = trimmed.slice(separatorIndex + 1).trim();
    if (name && secret) {
      clients[name] = secret;
    }
  }

  return clients;
}

const serviceClients = parseServiceClients(process.env.SERVICE_CLIENTS);

export const env = {
  nodeEnv: process.env.NODE_ENV ?? 'development',
  port: Number(process.env.PORT ?? 9010),
  host: process.env.HOST ?? '0.0.0.0',
  mongoUri: process.env.MONGODB_URI ?? '',
  corsOrigins: parseCorsOrigins(process.env.CORS_ORIGINS),
  defaultSlackChannelId: process.env.SLACK_CHANNEL_ID ?? '',
  onboardingChannelId: process.env.ONBOARDING_CHANNEL_ID ?? 'C0ATQNJ153Q',
  slackBotToken: process.env.SLACK_BOT_TOKEN ?? '',
  slackBridgeBotName: process.env.SLACK_BRIDGE_BOT_NAME ?? '',
  slackBridgeBotIconEmoji: process.env.SLACK_BRIDGE_BOT_ICON_EMOJI ?? '',
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN ?? '',
    defaultTelegramChannelId: process.env.TELEGRAM_CHANNEL_ID ?? '',
    telegramBotName: process.env.TELEGRAM_BOT_NAME ?? '',
  defaultTelegramChatId: process.env.TELEGRAM_CHAT_ID ?? '',
  jiraBaseUrl: normalizeBaseUrl(process.env.JIRA_BASE_URL),
  jiraEmail: process.env.JIRA_EMAIL ?? '',
  jiraApiToken: process.env.JIRA_API_TOKEN ?? '',
  jiraProjectKey: process.env.JIRA_PROJECT_KEY ?? '',
  jiraIssueType: process.env.JIRA_ISSUE_TYPE ?? 'Task',
  enableLiveForwarding: toBoolean(process.env.ENABLE_LIVE_FORWARDING, true),
    telegramWebhookSecret: process.env.TELEGRAM_WEBHOOK_SECRET ?? '',
  // Имя этого сервиса, к которому обращается Balancer (проверяется в заголовке X-Target-Service).
  serviceName: process.env.SERVICE_NAME ?? 'paycomconnect',
  // Реестр доверенных сервисов: { "<имя>": "<секрет>" }.
  serviceClients,
  // Enforcement: явный флаг перекрывает всё; иначе включается автоматически,
  // как только настроен хотя бы один сервис-клиент. Без клиентов — выключено (dev/тесты).
  serviceAuthEnabled:
    process.env.SERVICE_AUTH_ENABLED !== undefined
      ? toBoolean(process.env.SERVICE_AUTH_ENABLED, false)
      : Object.keys(serviceClients).length > 0,
  telegramWebhookUrl: process.env.TELEGRAM_WEBHOOK_URL ?? '',
};

export const integrationFlags = {
  mongodb: Boolean(env.mongoUri),
  telegram: Boolean(env.telegramBotToken),
  slack: Boolean(env.slackBotToken),
  jira: Boolean(env.jiraBaseUrl && env.jiraEmail && env.jiraApiToken && env.jiraProjectKey),
};

