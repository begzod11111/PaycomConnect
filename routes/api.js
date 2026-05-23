import express from 'express';

import { env, integrationFlags } from '../config/env.js';
import { getConnectionOverview, normalizeInn } from '../services/connectionService.js';
import { getDatabaseStatus } from '../services/databaseService.js';
import { getAnalyticsSummary, getRecentMessages, findConnectionByInn } from '../services/persistenceService.js';
import { ChannelLink } from '../models/channelLink.js';
import { isMongoConnected } from '../services/databaseService.js';

// Импорт модульных роутеров
import telegramRouter from './telegram.js';
import slackRouter from './slack.js';

const router = express.Router();

// ========== Подключение модульных роутеров ==========

router.use('/telegram', telegramRouter);
router.use('/slack', slackRouter);

// Для обратной совместимости (старые URL)
router.use('/webhooks/telegram', telegramRouter);
router.use('/webhooks/slack', slackRouter);

// ========== Общие API endpoints ==========

// Healthcheck
router.get('/health', async (req, res) => {
  const analytics = await getAnalyticsSummary();

  res.json({
    status: 'ok',
    service: 'PaycomConnect',
    version: '0.1.0',
    env: env.nodeEnv,
    database: getDatabaseStatus(),
    integrations: integrationFlags,
    uptime: process.uptime(),
    analytics,
  });
});

// ========== Аналитика ==========

// Общая аналитика
router.get('/analytics/summary', async (req, res) => {
  const summary = await getAnalyticsSummary();
  res.json(summary);
});

// Последние сообщения
router.get('/messages/recent', async (req, res) => {
  const limit = Number(req.query.limit ?? 20);
  const messages = await getRecentMessages(Number.isNaN(limit) ? 20 : Math.min(limit, 100));
  res.json(messages);
});

// ========== Управление связками ==========

// Список всех связок
router.get('/connections', async (req, res) => {
  const connections = await getConnectionOverview();
  res.json(connections);
});

// Получить связку по INN
router.get('/connections/:inn', async (req, res, next) => {
  try {
    const connection = await findConnectionByInn(req.params.inn);

    if (!connection) {
      return res.status(404).json({ error: 'Connection not found' });
    }

    res.json(connection);
  } catch (error) {
    next(error);
  }
});

// Привязать JIRA issue к связке
router.post('/connections/:inn/jira', async (req, res, next) => {
  try {
    const { inn } = req.params;
    const { projectKey, issueKey, issueUrl } = req.body;

    const connection = await findConnectionByInn(inn);

    if (!connection) {
      return res.status(404).json({ error: 'Connection not found' });
    }

    if (isMongoConnected()) {
      const updated = await ChannelLink.findOneAndUpdate(
        { inn },
        {
          $set: {
            jiraProjectKey: projectKey,
            jiraIssueKey: issueKey,
            jiraIssueUrl: issueUrl,
          },
        },
        { new: true },
      ).lean();

      return res.json(updated);
    }

    // Memory store обновление (если нужно)
    res.status(501).json({ error: 'JIRA link update not implemented for memory mode' });
  } catch (error) {
    next(error);
  }
});

// Обновить статус связки
router.patch('/connections/:inn', async (req, res, next) => {
  try {
    const { inn } = req.params;
    const { status } = req.body;

    if (!['linked', 'suspended', 'pending_telegram', 'pending_slack'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }

    const connection = await findConnectionByInn(inn);

    if (!connection) {
      return res.status(404).json({ error: 'Connection not found' });
    }

    if (isMongoConnected()) {
      const updated = await ChannelLink.findOneAndUpdate(
        { inn },
        { $set: { status } },
        { new: true },
      ).lean();

      return res.json(updated);
    }

    res.status(501).json({ error: 'Status update not implemented for memory mode' });
  } catch (error) {
    next(error);
  }
});

// Удалить связку
router.delete('/connections/:inn', async (req, res, next) => {
  try {
    const { inn } = req.params;

    if (isMongoConnected()) {
      const deleted = await ChannelLink.findOneAndDelete({ inn });

      if (!deleted) {
        return res.status(404).json({ error: 'Connection not found' });
      }

      return res.json({ ok: true, deleted });
    }

    res.status(501).json({ error: 'Delete not implemented for memory mode' });
  } catch (error) {
    next(error);
  }
});

export default router;



