import axios from 'axios';

import { env } from '../core/env';

// Faithful port of services/jiraService.js
const jiraKeywords = [/оплат/i, /problem/i, /issue/i, /error/i, /ошиб/i, /не работает/i, /bug/i, /incident/i];

function jiraAuthHeader() {
  return `Basic ${Buffer.from(`${env.jiraEmail}:${env.jiraApiToken}`).toString('base64')}`;
}

function jiraApiRoot() {
  return env.jiraBaseUrl.replace(/\/$/, '');
}

function buildAdfDescription(message: any) {
  const text = [
    `Источник: ${message.source}`,
    `Пользователь: ${message.userName} (${message.userId})`,
    `Канал: ${message.channelId || 'n/a'}`,
    `Текст: ${message.text || '[без текста]'}`,
  ].join('\n');
  return { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] };
}

export function shouldCreateJiraIssue(message: any): boolean {
  if (message.forceJira) return true;
  return jiraKeywords.some((pattern) => pattern.test(message.text || ''));
}

function buildSummary(message: any) {
  const sourceLabel = message.source === 'telegram' ? 'TG' : 'SL';
  const text = (message.text || 'Новое обращение без текста').replace(/\s+/g, ' ').trim();
  return `[${sourceLabel}] ${text.slice(0, 80)}`;
}

export async function maybeCreateJiraIssue(message: any) {
  if (!shouldCreateJiraIssue(message)) {
    return { triggered: false, status: 'skipped', mode: env.jiraBaseUrl ? 'live' : 'mock' };
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
      payload: { projectKey: env.jiraProjectKey || 'MOCK' },
    };
  }

  try {
    const response = await axios.post(
      `${jiraApiRoot()}/rest/api/3/issue`,
      {
        fields: {
          project: { key: env.jiraProjectKey },
          summary,
          description: buildAdfDescription(message),
          issuetype: { name: env.jiraIssueType },
        },
      },
      {
        headers: {
          Authorization: jiraAuthHeader(),
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
  } catch (error: any) {
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

export function jiraDocToText(node: any): string {
  if (!node) return '';
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(jiraDocToText).join('');
  if (node.type === 'text') return String(node.text || '');
  if (node.type === 'hardBreak' || node.type === 'rule') return '\n';
  const inner = jiraDocToText(node.content);
  if (node.type === 'paragraph' || node.type === 'heading' || node.type === 'blockquote') {
    return `${inner}\n`;
  }
  if (node.type === 'listItem') return `- ${inner.trim()}\n`;
  return inner;
}

export function jiraCommentToPlainText(comment: any): string {
  const body = comment?.body;
  if (typeof body === 'string') return body.trim();
  return jiraDocToText(body).trim();
}

export async function listJiraIssueComments(issueKey: string): Promise<any[]> {
  if (!issueKey || !env.jiraBaseUrl || !env.jiraEmail || !env.jiraApiToken) return [];
  const comments: any[] = [];
  let startAt = 0;
  const maxResults = 100;
  for (;;) {
    const response = await axios.get(`${jiraApiRoot()}/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment`, {
      params: { startAt, maxResults },
      headers: { Authorization: jiraAuthHeader(), Accept: 'application/json' },
    });
    const batch = Array.isArray(response.data?.comments) ? response.data.comments : [];
    comments.push(...batch);
    startAt += batch.length;
    const total = Number(response.data?.total ?? startAt);
    if (!batch.length || startAt >= total) break;
  }
  return comments;
}
