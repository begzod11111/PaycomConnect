import { Body, Controller, Get, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';

import { env } from '../core/env';
import { processInboundMessage } from '../runtime/bridge';
import {
  getTelegramBotInfo,
  getTelegramWebhookInfo,
  setTelegramWebhook,
  validateTelegramWebhookSecret,
} from '../runtime/telegram';
import { handleTelegramUpdate } from '../runtime/telegram-webhook';

// Full port of routes/telegram.js: webhook (onboarding, callback wizard, group
// connect session, bridge), bot admin, and mock.
@Controller('telegram')
export class TelegramController {
  @Get('bot-info')
  async botInfo() {
    return getTelegramBotInfo();
  }

  @Get('webhook-info')
  async webhookInfo() {
    return getTelegramWebhookInfo();
  }

  @Post('webhook-setup')
  async webhookSetup(@Body() body: any) {
    const url = body?.url || env.telegramWebhookUrl;
    return setTelegramWebhook({ url, secretToken: env.telegramWebhookSecret });
  }

  @Post('webhook')
  async webhook(@Req() req: Request, @Body() body: any, @Res() res: Response) {
    if (env.telegramWebhookSecret && !validateTelegramWebhookSecret(req, env.telegramWebhookSecret)) {
      return res.status(403).json({ ok: false, error: 'Invalid secret token' });
    }

    // Fast ACK; process the full update (onboarding, callbacks, connect, bridge)
    // in the background so Telegram never sees a slow webhook.
    res.status(200).json({ ok: true });
    handleTelegramUpdate(body).catch((error) =>
      console.error('[Telegram Webhook] Background processing failed:', error),
    );
  }

  @Post('mock')
  async mock(@Body() body: any, @Res() res: Response) {
    const result = await processInboundMessage('telegram', body);
    res.status(result.duplicate ? 200 : 201).json(result);
  }
}
