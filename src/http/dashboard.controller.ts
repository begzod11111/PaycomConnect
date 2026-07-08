import { Controller, Get, Header, Query, UseGuards } from '@nestjs/common';

import { env, integrationFlags } from '../core/env';
import { DashboardGuard } from '../common/guards/dashboard.guard';
import { getConnectionOverview } from '../runtime/connections';
import { getDatabaseStatus } from '../runtime/database';
import {
  getAnalyticsSummary,
  getRecentActionLogs,
  getRecentMessages,
} from '../runtime/persistence';
import { renderDashboardPage } from './dashboard.view';

// Local, non-public inspection dashboard. Serves a few simple HTML pages plus
// JSON data endpoints (logs, messages, connections, system). Gated by
// DashboardGuard (ENABLE_DASHBOARD); meant to be reached over a port-forward.
@Controller('dashboard')
@UseGuards(DashboardGuard)
export class DashboardController {
  // ── Pages ──────────────────────────────────────────────────────────────────
  @Get()
  @Header('Content-Type', 'text/html; charset=utf-8')
  overviewPage(): string {
    return renderDashboardPage('overview');
  }

  @Get('messages')
  @Header('Content-Type', 'text/html; charset=utf-8')
  messagesPage(): string {
    return renderDashboardPage('messages');
  }

  @Get('logs')
  @Header('Content-Type', 'text/html; charset=utf-8')
  logsPage(): string {
    return renderDashboardPage('logs');
  }

  @Get('connections')
  @Header('Content-Type', 'text/html; charset=utf-8')
  connectionsPage(): string {
    return renderDashboardPage('connections');
  }

  // ── Data (JSON) ──────────────────────────────────────────────────────────────
  @Get('data/overview')
  async overviewData() {
    const memory = process.memoryUsage();
    return {
      service: 'PaycomConnect',
      version: '0.1.0',
      runtime: 'nestjs',
      env: env.nodeEnv,
      database: getDatabaseStatus(),
      integrations: integrationFlags,
      process: {
        pid: process.pid,
        node: process.version,
        platform: `${process.platform}/${process.arch}`,
        uptime: formatUptime(process.uptime()),
        memory: { rss: memory.rss, heapUsed: memory.heapUsed, heapTotal: memory.heapTotal },
      },
      analytics: await getAnalyticsSummary(),
    };
  }

  @Get('data/messages')
  async messagesData(@Query('limit') limit?: string) {
    const parsed = Number(limit ?? 100);
    const safe = Number.isNaN(parsed) ? 100 : Math.min(parsed, 500);
    return getRecentMessages(safe);
  }

  @Get('data/logs')
  async logsData(
    @Query('limit') limit?: string,
    @Query('category') category?: string,
    @Query('action') action?: string,
    @Query('inn') inn?: string,
  ) {
    const parsed = Number(limit ?? 200);
    const safe = Number.isNaN(parsed) ? 200 : Math.min(parsed, 1000);
    return getRecentActionLogs(safe, { category, action, connectionInn: inn });
  }

  @Get('data/connections')
  async connectionsData() {
    return getConnectionOverview();
  }
}

function formatUptime(seconds: number): string {
  const s = Math.floor(seconds % 60);
  const m = Math.floor((seconds / 60) % 60);
  const h = Math.floor((seconds / 3600) % 24);
  const d = Math.floor(seconds / 86400);
  const parts = [] as string[];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  parts.push(`${s}s`);
  return parts.join(' ');
}
