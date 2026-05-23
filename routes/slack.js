import express from 'express';
import axios from 'axios';

import { activateSlackByInn, deactivateChannelConnect, normalizeInn } from '../services/connectionService.js';
import { processInboundMessage } from '../services/bridgeService.js';
import { handleDirectMessage, handleApproveCommand } from '../services/onboardingService.js';
import { SlackApiService } from '../services/SlackApiService.js';
import { findConnectionBySourceChannel } from '../services/persistenceService.js';
import { env } from '../config/env.js';
import { sendTelegramDocumentByUrl, sendTelegramReply } from '../services/telegramService.js';
import { ScriptService } from '../services/scriptService.js';

const router = express.Router();

async function handleScriptCommand(req, res, next) {
  try {
    const rawCode = String(req.body.text ?? '').trim();
    const normalizedCode = ScriptService.normalizeCode(rawCode);
    let senderName = req.body.user_name || 'технический специалист';

    if (req.body.user_id) {
      try {
        const userInfo = await SlackApiService.getUserInfo(req.body.user_id);
        senderName =
          userInfo?.profile?.real_name
          || userInfo?.profile?.display_name
          || userInfo?.real_name
          || userInfo?.name
          || senderName;
      } catch (userError) {
        console.warn(`Failed to resolve slash command sender ${req.body.user_id}:`, userError.message);
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

    const connection = await findConnectionBySourceChannel('slack', String(req.body.channel_id));
    const telegramChatId = connection?.telegramChatId || env.defaultTelegramChatId;

    if (!telegramChatId) {
      return res.status(400).json({
        response_type: 'ephemeral',
        text: 'Не найден Telegram-чат для отправки. Сначала создайте связку /connect.',
      });
    }

    const messageText = ScriptService.buildTelegramText(script, normalizedCode, {
      name: senderName,
    });
    await sendTelegramReply({
      chatId: telegramChatId,
      text: messageText,
    });

    let sentFiles = 0;
    for (const file of script.files ?? []) {
      if (!file?.url) continue;
      await sendTelegramDocumentByUrl({
        chatId: telegramChatId,
        documentUrl: file.url,
        caption: file.caption || '',
      });
      sentFiles += 1;
    }

    // История в Slack: фиксируем факт отправки скрипта в канале
    try {
      await SlackApiService.sendMessage(
        String(req.body.channel_id),
        `📨 Скрипт -${normalizedCode} отправлен в Telegram <#${connection?.slackChannelId || req.body.channel_id}> администратором ${senderName}.\n` +
          `Файлов: ${sentFiles}`,
      );
    } catch (historyError) {
      console.warn('Failed to write script history in Slack:', historyError.message);
    }

    return res.status(200).json({
      response_type: 'ephemeral',
      text: `Скрипт -${normalizedCode} отправлен в Telegram (${sentFiles} файл(ов)).`,
    });
  } catch (error) {
    return next(error);
  }
}

// ========== Slash Commands ==========

// Команда /approve <@user> <role> — апрув нового пользователя модератором
router.post('/commands/approve', async (req, res, next) => {
  try {
    const payload = {
      text: req.body.text,
      user_id: req.body.user_id,
      response_url: req.body.response_url,
    };

    // Slack slash commands ждут ACK ~3 секунды, иначе показывают operation_timeout.
    res.status(200).json({
      response_type: 'ephemeral',
      text: '⏳ Команда принята, выполняю апрув...',
    });

    setImmediate(async () => {
      try {
        const result = await handleApproveCommand(payload);

        if (payload.response_url) {
          await axios.post(payload.response_url, result);
        }
      } catch (backgroundError) {
        console.error('Background /approve command failed:', backgroundError);
        if (payload.response_url) {
          await axios.post(payload.response_url, {
            response_type: 'ephemeral',
            text: `❌ /approve failed: ${backgroundError.message}`,
          }).catch((responseError) => {
            console.error('Failed to post /approve error to response_url:', responseError.message);
          });
        }
      }
    });
  } catch (error) {
    next(error);
  }
});

// Обработка slash command /connect
router.post('/commands/connect', async (req, res, next) => {
  try {
    const inn = normalizeInn(req.body.text);

    if (!inn) {
      res.status(400).send('Используйте команду в формате /connect 123456789');
      return;
    }
    const result = await activateSlackByInn({
      inn,
      slackChannelId: req.body.channel_id,
      slackChannelName: req.body.channel_name,
      slackTeamId: req.body.team_id,
      userId: req.body.user_id,
      userName: req.body.user_name,
    });

    res.status(200).json({
      response_type: 'ephemeral',
      text: result.message,
      status: result.status,
      connection: result.connection,
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: result.message,
          },
        },
        {
          type: 'context',
          elements: [
            {
              type: 'mrkdwn',
              text: `*ИНН:* ${inn} | *Статус:* ${result.status === 'linked' ? '✅ Активно' : '⏳ Ожидание'}`,
            },
          ],
        },
      ],
    });
  } catch (error) {
    next(error);
  }
});

// Обработка slash command /disconnect
router.post('/commands/disconnect', async (req, res, next) => {
  try {
        const slackChannelId = req.body.channel_id;
    const actorId = req.body.user_id;
    const actorName = req.body.user_name;

    // Ищем связку по Slack-каналу
    const connection = await findConnectionBySourceChannel('slack', String(slackChannelId));

    // ACK Slack сразу (иначе timeout)
    res.status(200).json({
      response_type: 'ephemeral',
      text: '⏳ Выполняю disconnect...',
    });

    setImmediate(async () => {
      try {
        // 1. Деактивируем связку в БД
        const result = await deactivateChannelConnect({
          source: 'slack',
          channelId: String(slackChannelId),
          actorId,
          actorName,
        });

        if (result.status === 'not_found') {
          await SlackApiService.sendMessage(slackChannelId,
            `❌ Активная связка для этого канала не найдена.`
          ).catch(() => {});
          return;
        }

        const inn = result.connection?.inn ?? connection?.inn ?? '—';
        const jiraKey = result.connection?.jiraIssueKey ?? connection?.jiraIssueKey ?? '';
        const tgTitle = result.connection?.telegramChatTitle ?? connection?.telegramChatTitle ?? '';

        // 2. Отправляем итоговое сообщение в канал перед архивированием
        const farewellBlocks = [
          {
            type: 'header',
            text: { type: 'plain_text', text: '🏁 Интеграция завершена' },
          },
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
                `✅ *Интеграция успешно завершена.*\n\n` +
                `Если возникнут вопросы или понадобится помощь — звоните на горячую линию поддержки:\n\n` +
                `📞 *1350*\n\n` +
                `_Канал будет архивирован автоматически._`,
            },
          },
        ];

        await SlackApiService.sendMessage(
          slackChannelId,
          `🏁 Интеграция завершена. ИНН: ${inn}. По вопросам: 1350`,
          farewellBlocks,
        ).catch((err) => console.warn('Failed to send farewell message:', err.message));

        // 3. Небольшая пауза чтобы участники увидели сообщение
        await new Promise((resolve) => setTimeout(resolve, 2000));

        // 4. Архивируем Slack-канал
        await SlackApiService.archiveChannel(slackChannelId)
          .catch((err) => console.warn('Failed to archive Slack channel:', err.message));

        console.log(`✅ Slack channel ${slackChannelId} archived after disconnect (INN: ${inn})`);
      } catch (bgError) {
        console.error('Background /disconnect failed:', bgError);
      }
    });

  } catch (error) {
    next(error);
  }
});

// Обработка slash command /script и /skript
router.post('/commands/script', handleScriptCommand);
router.post('/commands/skript', handleScriptCommand);

// ========== Webhook endpoint (события) ==========

router.post('/webhook', async (req, res, next) => {
  // URL verification challenge
  if (req.body?.type === 'url_verification') {
    return res.status(200).json({ challenge: req.body.challenge });
  }

  // Игнорировать сообщения от ботов
  if (req.body?.event?.subtype === 'bot_message' || req.body?.event?.user === 'U0AT5HHV5B8') {
    return res.status(200).json({ ok: true, ignored: true });
  }

  try {
    console.log('Received Slack event:', JSON.stringify(req.body, null, 2));

    const event = req.body?.event ?? {};
    let resolvedUserName = req.body?.userName;

    if (!resolvedUserName && event.user) {
      try {
        const userInfo = await SlackApiService.getUserInfo(event.user);
        resolvedUserName =
          userInfo?.profile?.real_name
          || userInfo?.profile?.display_name
          || userInfo?.real_name
          || userInfo?.name
          || '';
      } catch (userLookupError) {
        console.warn(`Failed to resolve Slack user name for ${event.user}:`, userLookupError.message);
      }
    }

    // DM для онбординга в Slack
    if (req.body?.event?.channel_type === 'im') {
      await handleDirectMessage(req.body.event);
      return res.status(200).json({ ok: true, onboarding: true });
    }

    // Быстрый ACK в Slack (иначе Slack может ретраить событие и дублировать пересылку)
    res.status(200).json({ ok: true, accepted: true });

    processInboundMessage('slack', {
      ...req.body,
      userName: resolvedUserName || req.body?.userName || '',
    })
      .then((result) => {
        console.log('Slack event processed:', {
          duplicate: result?.duplicate ?? false,
          ignored: Boolean(result?.ignored),
          reason: result?.reason ?? null,
        });
      })
      .catch((backgroundError) => {
        console.error('Slack background processing error:', backgroundError);
      });

    return;
  } catch (error) {
    return next(error);
  }
});

// ========== Управление связками ==========

// Создать/обновить связку по INN
router.post('/connections', async (req, res, next) => {
  try {
    const inn = normalizeInn(req.body.inn);

    if (!inn) {
      res.status(400).json({ error: 'Valid INN is required' });
      return;
    }

    const result = await activateSlackByInn({
      inn,
      slackChannelId: req.body.slackChannelId ?? req.body.channelId,
      slackChannelName: req.body.slackChannelName ?? req.body.channelName,
      slackTeamId: req.body.slackTeamId ?? req.body.teamId,
      userId: req.body.userId,
      userName: req.body.userName,
    });

    res.status(201).json(result);
  } catch (error) {
    next(error);
  }
});

// ========== Mock endpoint для тестирования ==========

router.post('/mock', async (req, res, next) => {
  try {
    const result = await processInboundMessage('slack', req.body);
    res.status(result.duplicate ? 200 : 201).json(result);
  } catch (error) {
    next(error);
  }
});

// ========== Interactivity endpoints ==========

// Обработка интерактивных компонентов (кнопки, меню)
router.post('/interactive', async (req, res, next) => {
  try {
    const payload = JSON.parse(req.body.payload);

    // Обработка разных типов интеракций
    switch (payload.type) {
      case 'block_actions':
        // Обработка нажатий на кнопки
        return res.status(200).json({ ok: true });

      case 'view_submission':
        // Обработка модальных окон
        return res.status(200).json({ ok: true });

      default:
        return res.status(200).json({ ok: true });
    }
  } catch (error) {
    next(error);
  }
});

export default router;
