import * as dotenv from 'dotenv';

// Load the repository-root .env.
dotenv.config();

function toBoolean(value: string | undefined, defaultValue = false): boolean {
  if (value === undefined) return defaultValue;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function normalizeBaseUrl(value: string | undefined): string {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  if (/^https?:\/\//i.test(raw)) return raw;
  return `https://${raw}`;
}

function parseServiceClients(value: string | undefined): Record<string, string> {
  const clients: Record<string, string> = {};
  if (!value) return clients;
  for (const pair of value.split(',')) {
    const trimmed = pair.trim();
    const idx = trimmed.indexOf(':');
    if (idx === -1) continue;
    const name = trimmed.slice(0, idx).trim();
    const secret = trimmed.slice(idx + 1).trim();
    if (name && secret) clients[name] = secret;
  }
  return clients;
}

const serviceClients = parseServiceClients(process.env.SERVICE_CLIENTS);

// Faithful port of config/env.js so behavior is identical after the cutover.
export const env = {
  nodeEnv: process.env.NODE_ENV ?? 'development',
  port: Number(process.env.PORT ?? 9010),
  host: process.env.HOST ?? '0.0.0.0',
  mongoUri: process.env.MONGODB_URI ?? '',
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
  telegramWebhookUrl: process.env.TELEGRAM_WEBHOOK_URL ?? '',
  serviceName: process.env.SERVICE_NAME ?? 'paycomconnect',
  serviceClients,
  serviceAuthEnabled:
    process.env.SERVICE_AUTH_ENABLED !== undefined && process.env.SERVICE_AUTH_ENABLED !== ''
      ? toBoolean(process.env.SERVICE_AUTH_ENABLED, false)
      : Object.keys(serviceClients).length > 0,
};

export const integrationFlags = {
  mongodb: Boolean(env.mongoUri),
  telegram: Boolean(env.telegramBotToken),
  slack: Boolean(env.slackBotToken),
  jira: Boolean(env.jiraBaseUrl && env.jiraEmail && env.jiraApiToken && env.jiraProjectKey),
};
