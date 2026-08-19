import { Body, Controller, Get, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';

import { env } from '../core/env';
import { processInboundMessage } from '../runtime/bridge';
import { logAction } from '../runtime/action-log';
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
    handleTelegramUpdate(body).catch((error) => {
      console.error('[Telegram Webhook] Background processing failed:', error);
      const message = body?.message || body?.edited_message || body?.channel_post || body?.edited_channel_post;
      void logAction({
        action: 'telegram.webhook.failed',
        category: 'message',
        level: 'error',
        source: 'telegram',
        message: `Telegram webhook background processing failed: ${error?.message ?? error}`,
        actor: {
          userId: String(message?.from?.id ?? ''),
          userName: [message?.from?.first_name, message?.from?.last_name].filter(Boolean).join(' '),
        },
        externalId: String(message?.message_id ?? body?.update_id ?? ''),
        context: {
          channelId: String(message?.chat?.id ?? ''),
          chatTitle: message?.chat?.title ?? '',
          updateId: body?.update_id ?? null,
        },
      });
    });
  }

  @Post('mock')
  async mock(@Body() body: any, @Res() res: Response) {
    const result = await processInboundMessage('telegram', body);
    res.status(result.duplicate ? 200 : 201).json(result);
  }
}
