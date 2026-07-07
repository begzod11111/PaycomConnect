import { Body, Controller, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import axios from 'axios';

import { env } from '../core/env';
import { processInboundMessage } from '../runtime/bridge';
import {
  activateSlackByInn,
  deactivateChannelConnect,
  normalizeInn,
} from '../runtime/connections';
import { findConnectionBySourceChannel } from '../runtime/persistence';
import { SlackApiService } from '../runtime/slack-api';
import { ScriptService } from '../runtime/script';
import { sendTelegramDocumentByUrl, sendTelegramReply } from '../runtime/telegram';

// Faithful port of routes/slack.js (slash commands, events webhook, mock).
// NOTE: Slack-DM onboarding (handleDirectMessage) and /approve are not yet ported
// and still run on the Express app until their NestJS port is verified.
@Controller('slack')
export class SlackController {
  private async handleScript(body: any, res: Response) {
    const rawCode = String(body.text ?? '').trim();
    const normalizedCode = ScriptService.normalizeCode(rawCode);
    let senderName = body.user_name || 'технический специалист';

    if (body.user_id) {
      try {
        const userInfo = await SlackApiService.getUserInfo(body.user_id);
        senderName =
          userInfo?.profile?.real_name ||
          userInfo?.profile?.display_name ||
          userInfo?.real_name ||
          userInfo?.name ||
          senderName;
      } catch (userError: any) {
        console.warn(`Failed to resolve slash command sender ${body.user_id}:`, userError.message);
      }
    }

    if (!normalizedCode) {
      return res.status(400).json({
        response_type: 'ephemeral',
        text: `Используйте формат: /skript -start\nДоступные коды: ${ScriptService.getAvailableCodes().map((c) => `-${c}`).join(', ')}`,
      });
    }

    const script = ScriptService.getByCode(normalizedCode);
    if (!script) {
      return res.status(404).json({
        response_type: 'ephemeral',
        text: `Скрипт "${rawCode}" не найден. Доступные коды: ${ScriptService.getAvailableCodes().map((c) => `-${c}`).join(', ')}`,
      });
    }

    const connection: any = await findConnectionBySourceChannel('slack', String(body.channel_id));
    const telegramChatId = connection?.telegramChatId || env.defaultTelegramChatId;
    if (!telegramChatId) {
      return res.status(400).json({
        response_type: 'ephemeral',
        text: 'Не найден Telegram-чат для отправки. Сначала создайте связку /connect.',
      });
    }

    const messageText = ScriptService.buildTelegramText(script, normalizedCode, { name: senderName });
    await sendTelegramReply({ chatId: telegramChatId, text: messageText });

    let sentFiles = 0;
    for (const file of script.files ?? []) {
      if (!file?.url) continue;
      await sendTelegramDocumentByUrl({ chatId: telegramChatId, documentUrl: file.url, caption: file.caption || '' });
      sentFiles += 1;
    }

    try {
      await SlackApiService.sendMessage(
        String(body.channel_id),
        `📨 Скрипт -${normalizedCode} отправлен в Telegram <#${connection?.slackChannelId || body.channel_id}> администратором ${senderName}.\nФайлов: ${sentFiles}`,
      );
    } catch (historyError: any) {
      console.warn('Failed to write script history in Slack:', historyError.message);
    }

    return res.status(200).json({
      response_type: 'ephemeral',
      text: `Скрипт -${normalizedCode} отправлен в Telegram (${sentFiles} файл(ов)).`,
    });
  }

  @Post('commands/connect')
  async connect(@Body() body: any, @Res() res: Response) {
    const inn = normalizeInn(body.text);
    if (!inn) {
      return res.status(400).send('Используйте команду в формате /connect 123456789');
    }
    const result = await activateSlackByInn({
      inn,
      slackChannelId: body.channel_id,
      slackChannelName: body.channel_name,
      slackTeamId: body.team_id,
      userId: body.user_id,
      userName: body.user_name,
    });

    return res.status(200).json({
      response_type: 'ephemeral',
      text: result.message,
      status: result.status,
      connection: result.connection,
      blocks: [
        { type: 'section', text: { type: 'mrkdwn', text: result.message } },
        {
          type: 'context',
          elements: [
            { type: 'mrkdwn', text: `*ИНН:* ${inn} | *Статус:* ${result.status === 'linked' ? '✅ Активно' : '⏳ Ожидание'}` },
          ],
        },
      ],
    });
  }

  @Post('commands/disconnect')
  async disconnect(@Body() body: any, @Res() res: Response) {
    const slackChannelId = body.channel_id;
    const actorId = body.user_id;
    const actorName = body.user_name;
    const connection: any = await findConnectionBySourceChannel('slack', String(slackChannelId));

    res.status(200).json({ response_type: 'ephemeral', text: '⏳ Выполняю disconnect...' });

    setImmediate(async () => {
      try {
        const result = await deactivateChannelConnect({ source: 'slack', channelId: String(slackChannelId), actorId, actorName });
        if (result.status === 'not_found') {
          await SlackApiService.sendMessage(slackChannelId, `❌ Активная связка для этого канала не найдена.`).catch(() => {});
          return;
        }
        const inn = result.connection?.inn ?? connection?.inn ?? '—';
        const jiraKey = result.connection?.jiraIssueKey ?? connection?.jiraIssueKey ?? '';
        const tgTitle = result.connection?.telegramChatTitle ?? connection?.telegramChatTitle ?? '';
        const farewellBlocks = [
          { type: 'header', text: { type: 'plain_text', text: '🏁 Интеграция завершена' } },
          {
            type: 'section',
            fields: [
              { type: 'mrkdwn', text: `*ИНН:*\n${inn}` },
              { type: 'mrkdwn', text: `*Jira:*\n${jiraKey || '—'}` },
              { type: 'mrkdwn', text: `*Telegram:*\n${tgTitle || '—'}` },
              { type: 'mrkdwn', text: `*Закрыл:*\n${actorName}` },
            ],
          },
          { type: 'divider' },
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text:
                `✅ *Интеграция успешно завершена.*\n\nЕсли возникнут вопросы или понадобится помощь — звоните на горячую линию поддержки:\n\n📞 *1350*\n\n_Канал будет архивирован автоматически._`,
            },
          },
        ];
        await SlackApiService.sendMessage(slackChannelId, `🏁 Интеграция завершена. ИНН: ${inn}. По вопросам: 1350`, farewellBlocks).catch(
          (err: any) => console.warn('Failed to send farewell message:', err.message),
        );
        await new Promise((resolve) => setTimeout(resolve, 2000));
        await SlackApiService.archiveChannel(slackChannelId).catch((err: any) =>
          console.warn('Failed to archive Slack channel:', err.message),
        );
      } catch (bgError) {
        console.error('Background /disconnect failed:', bgError);
      }
    });
  }

  @Post('commands/script')
  async script(@Body() body: any, @Res() res: Response) {
    return this.handleScript(body, res);
  }

  @Post('commands/skript')
  async skript(@Body() body: any, @Res() res: Response) {
    return this.handleScript(body, res);
  }

  @Post('webhook')
  async webhook(@Body() body: any, @Res() res: Response) {
    if (body?.type === 'url_verification') {
      return res.status(200).json({ challenge: body.challenge });
    }
    if (body?.event?.subtype === 'bot_message' || body?.event?.user === env.slackBotToken) {
      return res.status(200).json({ ok: true, ignored: true });
    }
    // DM onboarding (channel_type === 'im') is handled by the Express app until ported.
    if (body?.event?.channel_type === 'im') {
      return res.status(200).json({ ok: true, ignored: true, note: 'onboarding_not_ported' });
    }

    // Fast ACK, forward in background.
    res.status(200).json({ ok: true, accepted: true });
    processInboundMessage('slack', body).catch((error) =>
      console.error('[Slack Webhook] Background bridge failed:', error),
    );
  }

  @Post('mock')
  async mock(@Body() body: any, @Res() res: Response) {
    const result = await processInboundMessage('slack', body);
    res.status(result.duplicate ? 200 : 201).json(result);
  }
}
