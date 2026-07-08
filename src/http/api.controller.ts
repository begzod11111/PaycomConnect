import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';

import { env, integrationFlags } from '../core/env';
import { getDatabaseStatus, isMongoConnected } from '../runtime/database';
import { processInboundMessage } from '../runtime/bridge';
import { getConnectionOverview } from '../runtime/connections';
import {
  findConnectionByInn,
  getAnalyticsSummary,
  getRecentActionLogs,
  getRecentMessages,
} from '../runtime/persistence';
import { ChannelLink } from '../runtime/models';
import { ServiceAuthGuard } from '../common/guards/service-auth.guard';

// Faithful port of routes/api.js (general endpoints + connection management).
@Controller()
export class ApiController {
  @Get('health')
  async health() {
    const analytics = await getAnalyticsSummary();
    return {
      status: 'ok',
      service: 'PaycomConnect',
      version: '0.1.0',
      runtime: 'nestjs',
      env: env.nodeEnv,
      database: getDatabaseStatus(),
      integrations: integrationFlags,
      uptime: process.uptime(),
      analytics,
    };
  }

  @Post('mock/telegram')
  async mockTelegram(@Body() body: any, @Res() res: Response) {
    const result = await processInboundMessage('telegram', body);
    res.status(result.duplicate ? 200 : 201).json(result);
  }

  @Post('mock/slack')
  async mockSlack(@Body() body: any, @Res() res: Response) {
    const result = await processInboundMessage('slack', body);
    res.status(result.duplicate ? 200 : 201).json(result);
  }

  @Get('analytics/summary')
  @UseGuards(ServiceAuthGuard)
  async analyticsSummary() {
    return getAnalyticsSummary();
  }

  @Get('messages/recent')
  @UseGuards(ServiceAuthGuard)
  async recentMessages(@Query('limit') limit?: string) {
    const parsed = Number(limit ?? 20);
    return getRecentMessages(Number.isNaN(parsed) ? 20 : Math.min(parsed, 100));
  }

  @Get('logs/recent')
  @UseGuards(ServiceAuthGuard)
  async recentLogs(
    @Query('limit') limit?: string,
    @Query('category') category?: string,
    @Query('action') action?: string,
    @Query('inn') inn?: string,
  ) {
    const parsed = Number(limit ?? 50);
    const safeLimit = Number.isNaN(parsed) ? 50 : Math.min(parsed, 200);
    return getRecentActionLogs(safeLimit, { category, action, connectionInn: inn });
  }

  @Get('connections')
  @UseGuards(ServiceAuthGuard)
  async connections() {
    return getConnectionOverview();
  }

  @Get('connections/:inn')
  @UseGuards(ServiceAuthGuard)
  async connectionByInn(@Param('inn') inn: string, @Res() res: Response) {
    const connection = await findConnectionByInn(inn);
    if (!connection) return res.status(404).json({ error: 'Connection not found' });
    return res.json(connection);
  }

  @Post('connections/:inn/jira')
  @UseGuards(ServiceAuthGuard)
  async attachJira(@Param('inn') inn: string, @Body() body: any, @Res() res: Response) {
    const { projectKey, issueKey, issueUrl } = body ?? {};
    const connection = await findConnectionByInn(inn);
    if (!connection) return res.status(404).json({ error: 'Connection not found' });

    if (isMongoConnected()) {
      const updated = await ChannelLink.findOneAndUpdate(
        { inn },
        { $set: { jiraProjectKey: projectKey, jiraIssueKey: issueKey, jiraIssueUrl: issueUrl } },
        { new: true },
      ).lean();
      return res.json(updated);
    }
    return res.status(501).json({ error: 'JIRA link update not implemented for memory mode' });
  }

  @Patch('connections/:inn')
  @UseGuards(ServiceAuthGuard)
  async updateStatus(@Param('inn') inn: string, @Body() body: any, @Res() res: Response) {
    const { status } = body ?? {};
    if (!['linked', 'suspended', 'pending_telegram', 'pending_slack'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }
    const connection = await findConnectionByInn(inn);
    if (!connection) return res.status(404).json({ error: 'Connection not found' });

    if (isMongoConnected()) {
      const updated = await ChannelLink.findOneAndUpdate({ inn }, { $set: { status } }, { new: true }).lean();
      return res.json(updated);
    }
    return res.status(501).json({ error: 'Status update not implemented for memory mode' });
  }

  @Delete('connections/:inn')
  @UseGuards(ServiceAuthGuard)
  async remove(@Param('inn') inn: string, @Res() res: Response) {
    if (isMongoConnected()) {
      const deleted = await ChannelLink.findOneAndDelete({ inn });
      if (!deleted) return res.status(404).json({ error: 'Connection not found' });
      return res.json({ ok: true, deleted });
    }
    return res.status(501).json({ error: 'Delete not implemented for memory mode' });
  }
}
