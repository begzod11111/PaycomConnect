import axios from 'axios';

import { env } from '../config/env.js';

const jiraKeywords = [
  /оплат/i,
  /problem/i,
  /issue/i,
  /error/i,
  /ошиб/i,
  /не работает/i,
  /bug/i,
  /incident/i,
];

function buildAdfDescription(message) {
  const text = [
    `Источник: ${message.source}`,
    `Пользователь: ${message.userName} (${message.userId})`,
    `Канал: ${message.channelId || 'n/a'}`,
    `Текст: ${message.text || '[без текста]'}`,
  ].join('\n');

  return {
    type: 'doc',
    version: 1,
    content: [
      {
        type: 'paragraph',
        content: [
          {
            type: 'text',
            text,
          },
        ],
      },
    ],
  };
}

export function shouldCreateJiraIssue(message) {
  if (message.forceJira) {
    return true;
  }

  return jiraKeywords.some((pattern) => pattern.test(message.text || ''));
}

function buildSummary(message) {
  const sourceLabel = message.source === 'telegram' ? 'TG' : 'SL';
  const text = (message.text || 'Новое обращение без текста').replace(/\s+/g, ' ').trim();
  const trimmed = text.slice(0, 80);
  return `[${sourceLabel}] ${trimmed}`;
}

export async function maybeCreateJiraIssue(message) {
  if (!shouldCreateJiraIssue(message)) {
    return {
      triggered: false,
      status: 'skipped',
      mode: env.jiraBaseUrl ? 'live' : 'mock',
    };
  }

  const summary = buildSummary(message);
  const description = [
    `Источник: ${message.source}`,
    `Пользователь: ${message.userName} (${message.userId})`,
    `Текст: ${message.text || '[без текста]'}`,
  ].join('\n');

  if (!env.jiraBaseUrl || !env.jiraEmail || !env.jiraApiToken || !env.jiraProjectKey) {
    return {
      triggered: true,
      status: 'mocked',
      mode: 'mock',
      issueKey: `MOCK-${Date.now().toString().slice(-6)}`,
      summary,
      description,
      payload: {
        projectKey: env.jiraProjectKey || 'MOCK',
      },
    };
  }

  try {
    const response = await axios.post(
      `${env.jiraBaseUrl.replace(/\/$/, '')}/rest/api/3/issue`,
      {
        fields: {
          project: {
            key: env.jiraProjectKey,
          },
          summary,
          description: buildAdfDescription(message),
          issuetype: {
            name: env.jiraIssueType,
          },
        },
      },
      {
        headers: {
          Authorization: `Basic ${Buffer.from(`${env.jiraEmail}:${env.jiraApiToken}`).toString('base64')}`,
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
      },
    );

    return {
      triggered: true,
      status: 'created',
      mode: 'live',
      issueKey: response.data?.key ?? '',
      summary,
      description,
      payload: response.data,
    };
  } catch (error) {
    return {
      triggered: true,
      status: 'failed',
      mode: 'live',
      issueKey: '',
      summary,
      description,
      error: error.response?.data ?? error.message,
      payload: error.response?.data ?? {},
    };
  }
}

