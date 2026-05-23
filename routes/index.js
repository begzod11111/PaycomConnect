import express from 'express';

import { integrationFlags } from '../config/env.js';
import { getDatabaseStatus } from '../services/databaseService.js';
import { getAnalyticsSummary } from '../services/persistenceService.js';

const router = express.Router();

router.get('/', async (req, res, next) => {
  try {
    const analytics = await getAnalyticsSummary();

    res.render('index', {
      title: 'PaycomConnect',
      description: 'MVP-мост между Telegram, Slack, JIRA и CRM/аналитикой на MongoDB.',
      database: getDatabaseStatus(),
      integrations: integrationFlags,
      analytics,
    });
  } catch (error) {
    next(error);
  }
});

export default router;
