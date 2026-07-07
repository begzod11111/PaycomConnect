import { Body, Controller, Get, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';

import { env } from '../core/env';
import { processInboundMessage } from '../runtime/bridge';
import {
  getTelegramBotInfo,
  getTelegramWebhookInfo,
  sendTelegramReply,
  setTelegramWebhook,
  validateTelegramWebhookSecret,
} from '../runtime/telegram';

// Faithful port of the core of routes/telegram.js (webhook message bridge + connect).
// NOTE: The inline-callback wizard, group PTI session, and Telegram-DM onboarding
// are not yet ported and still run on the Express app until verified.
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

    const update = body;
    const message = update?.message ?? update?.edited_message;

    // Callback queries and DM onboarding are still served by the Express app.
    if (!message) {
      return res.status(200).json({ ok: true, ignored: true });
    }

    // Fast ACK; forward in background (avoids Telegram ret/ry-driven latency).
    res.status(200).json({ ok: true });

    processInboundMessage('telegram', update)
      .then(async (bridgeResult: any) => {
        if (bridgeResult?.onboarding && bridgeResult?.command?.action === 'connect') {
          try {
            await sendTelegramReply({
              chatId: message.chat?.id,
              text: bridgeResult.activation?.message ?? 'Команда обработана',
              replyToMessageId: message.message_id,
            });
          } catch (replyError) {
            console.warn('[Telegram Webhook] connect reply failed:', replyError);
          }
        }
      })
      .catch((error) => console.error('[Telegram Webhook] Background bridge failed:', error));
  }

  @Post('mock')
  async mock(@Body() body: any, @Res() res: Response) {
    const result = await processInboundMessage('telegram', body);
    res.status(result.duplicate ? 200 : 201).json(result);
  }
}
