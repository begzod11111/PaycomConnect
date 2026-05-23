/**
 * JiraApiService
 * Работа с Jira REST API v3: задачи, статусы, исполнители, комментарии.
 * Все методы — статические.
 */

import axios from 'axios';
import { env } from '../config/env.js';

export class JiraApiService {
  // ── Internal ────────────────────────────────────────────────────────────────

  static #auth() {
    return Buffer.from(`${env.jiraEmail}:${env.jiraApiToken}`).toString('base64');
  }

  static #headers() {
    return {
      Authorization: `Basic ${JiraApiService.#auth()}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    };
  }

  static #url(path) {
    return `${env.jiraBaseUrl.replace(/\/$/, '')}/rest/api/3/${path}`;
  }

  static async #get(path, params = {}) {
    const res = await axios.get(JiraApiService.#url(path), {
      params,
      headers: JiraApiService.#headers(),
    });
    return res.data;
  }

  static async #post(path, body = {}) {
    const res = await axios.post(JiraApiService.#url(path), body, {
      headers: JiraApiService.#headers(),
    });
    return res.data;
  }

  static async #put(path, body = {}) {
    const res = await axios.put(JiraApiService.#url(path), body, {
      headers: JiraApiService.#headers(),
    });
    return res.data;
  }

  static async #patch(path, body = {}) {
    const res = await axios.patch(JiraApiService.#url(path), body, {
      headers: JiraApiService.#headers(),
    });
    return res.data;
  }

  static async #delete(path) {
    const res = await axios.delete(JiraApiService.#url(path), {
      headers: JiraApiService.#headers(),
    });
    return res.data;
  }

  // ── Задачи (Issues) ─────────────────────────────────────────────────────────

  /**
   * Получить задачу по ключу или id.
   * @param {string} issueKey  e.g. 'PROJ-123'
   */
  static async getIssue(issueKey) {
    return JiraApiService.#get(`issue/${issueKey}`);
  }

  /**
   * Создать задачу.
   * @param {{ summary: string, description?: string, assigneeEmail?: string, issueType?: string }} opts
   */
  static async createIssue({ summary, description = '', assigneeEmail, issueType }) {
    const fields = {
      project: { key: env.jiraProjectKey },
      summary,
      issuetype: { name: issueType ?? env.jiraIssueType ?? 'Task' },
    };

    if (description) {
      fields.description = {
        type: 'doc',
        version: 1,
        content: [{ type: 'paragraph', content: [{ type: 'text', text: description }] }],
      };
    }

    if (assigneeEmail) {
      // Находим accountId по email
      const accountId = await JiraApiService.findAccountIdByEmail(assigneeEmail);
      if (accountId) fields.assignee = { accountId };
    }

    return JiraApiService.#post('issue', { fields });
  }

  /**
   * Обновить поля задачи (summary, description и др.).
   * @param {string} issueKey
   * @param {object} fields  Jira fields object
   */
  static async updateIssue(issueKey, fields) {
    await JiraApiService.#put(`issue/${issueKey}`, { fields });
    return { ok: true, issueKey };
  }

  /**
   * Удалить задачу.
   * @param {string} issueKey
   */
  static async deleteIssue(issueKey) {
    await JiraApiService.#delete(`issue/${issueKey}`);
    return { ok: true, issueKey };
  }

  // ── Статусы ─────────────────────────────────────────────────────────────────

  /**
   * Получить текущий статус задачи.
   * @param {string} issueKey
   * @returns {string} название статуса
   */
  static async getIssueStatus(issueKey) {
    const issue = await JiraApiService.getIssue(issueKey);
    return issue.fields?.status?.name ?? null;
  }

  /**
   * Получить доступные переходы (transitions) для задачи.
   * @param {string} issueKey
   */
  static async getTransitions(issueKey) {
    const data = await JiraApiService.#get(`issue/${issueKey}/transitions`);
    return data.transitions ?? [];
  }

  /**
   * Сменить статус задачи по названию перехода.
   * @param {string} issueKey
   * @param {string} transitionName  e.g. 'In Progress', 'Done', 'Closed'
   */
  static async transitionIssue(issueKey, transitionName) {
    const transitions = await JiraApiService.getTransitions(issueKey);
    const transition = transitions.find(
      (t) => t.name.toLowerCase() === transitionName.toLowerCase(),
    );

    if (!transition) {
      const available = transitions.map((t) => t.name).join(', ');
      throw new Error(
        `[JiraApiService] Transition "${transitionName}" not found for ${issueKey}. Available: ${available}`,
      );
    }

    await JiraApiService.#post(`issue/${issueKey}/transitions`, {
      transition: { id: transition.id },
    });

    return { ok: true, issueKey, newStatus: transitionName };
  }

  // ── Исполнитель ─────────────────────────────────────────────────────────────

  /**
   * Найти accountId пользователя Jira по email.
   * @param {string} email
   * @returns {string|null}
   */
  static async findAccountIdByEmail(email) {
    const users = await JiraApiService.#get('user/search', { query: email });
    const match = users.find(
      (u) => u.emailAddress?.toLowerCase() === email.toLowerCase(),
    );
    return match?.accountId ?? null;
  }

  /**
   * Назначить исполнителя задачи по email.
   * @param {string} issueKey
   * @param {string} assigneeEmail
   */
  static async assignIssue(issueKey, assigneeEmail) {
    const accountId = await JiraApiService.findAccountIdByEmail(assigneeEmail);
    if (!accountId) throw new Error(`[JiraApiService] User not found by email: ${assigneeEmail}`);

    await JiraApiService.#put(`issue/${issueKey}/assignee`, { accountId });
    return { ok: true, issueKey, accountId };
  }

  /**
   * Снять исполнителя с задачи.
   * @param {string} issueKey
   */
  static async unassignIssue(issueKey) {
    await JiraApiService.#put(`issue/${issueKey}/assignee`, { accountId: null });
    return { ok: true, issueKey };
  }

  // ── Комментарии ─────────────────────────────────────────────────────────────

  /**
   * Добавить комментарий к задаче.
   * @param {string} issueKey
   * @param {string} text
   */
  static async addComment(issueKey, text) {
    const body = {
      body: {
        type: 'doc',
        version: 1,
        content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
      },
    };
    return JiraApiService.#post(`issue/${issueKey}/comment`, body);
  }

  /**
   * Получить все комментарии задачи.
   * @param {string} issueKey
   */
  static async getComments(issueKey) {
    const data = await JiraApiService.#get(`issue/${issueKey}/comment`);
    return data.comments ?? [];
  }

  // ── Поиск (JQL) ─────────────────────────────────────────────────────────────

  /**
   * Поиск задач по JQL.
   * @param {string} jql
   * @param {string[]} [fields]
   * @param {number}  [maxResults=50]
   */
  static async searchIssues(jql, fields = ['summary', 'status', 'assignee'], maxResults = 50) {
    return JiraApiService.#post('search', { jql, fields, maxResults });
  }

  /**
   * Получить все задачи проекта с определённым статусом.
   * @param {string} status
   * @param {string} [projectKey]
   */
  static async getIssuesByStatus(status, projectKey) {
    const proj = projectKey ?? env.jiraProjectKey;
    const jql = `project = "${proj}" AND status = "${status}" ORDER BY created DESC`;
    return JiraApiService.searchIssues(jql);
  }

  /**
   * Получить задачи назначенные на email.
   * @param {string} assigneeEmail
   * @param {string} [projectKey]
   */
  static async getIssuesByAssignee(assigneeEmail, projectKey) {
    const proj = projectKey ?? env.jiraProjectKey;
    const jql = `project = "${proj}" AND assignee = "${assigneeEmail}" ORDER BY updated DESC`;
    return JiraApiService.searchIssues(jql);
  }
}

