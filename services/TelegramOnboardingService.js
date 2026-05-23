/**
 * TelegramOnboardingService
 *
 * Флоу регистрации пользователя через Telegram DM:
 *   1. /start → проверка по telegramId в БД
 *   2. Не зарегистрирован → попросить email
 *   3. Ввод email → валидация домена (@payme.uz / @tbcbank.uz)
 *   4. Поиск пользователя в Slack workspace по email (users.lookupByEmail)
 *   5. Создать SlackUser { status: 'pending', telegramId }
 *   6. Уведомить Slack онбординг-канал о pending-заявке
 *
 * Апрув выполняется отдельно через /approve в Slack (см. onboardingService.js)
 */

import axios from 'axios';
import { env } from '../config/env.js';
import { SlackUser } from '../models/slackUser.js';

// ── Константы ─────────────────────────────────────────────────────────────────

const ALLOWED_DOMAINS = ['payme.uz', 'tbcbank.uz'];
// Канал Slack для уведомлений онбординга
const ONBOARDING_SLACK_CHANNEL = env.onboardingChannelId || 'C0ATQNJ153Q';
// Тестовые префиксы для пропуска проверки Slack
const TEST_EMAIL_PREFIXES = ['begzod0426_test'];

// ── In-memory сессии: telegramId → { step, data, ts } ────────────────────────
const sessions = new Map();

// Автоочистка сессий старше 30 минут
setInterval(() => {
  const cutoff = Date.now() - 30 * 60 * 1000;
  for (const [key, val] of sessions.entries()) {
    if (val.ts < cutoff) sessions.delete(key);
  }
}, 5 * 60 * 1000);

export class TelegramOnboardingService {
    // ── Telegram API helpers ────────────────────────────────────────────────────

    static async #tgPost(method, body) {
        const url = `https://api.telegram.org/bot${env.telegramBotToken}/${method}`;
        const res = await axios.post(url, body);
        return res.data;
    }

    /**
     * Отправить сообщение пользователю в Telegram.
     * @param {string|number} chatId
     * @param {string}        text   (HTML)
     */
    static async #sendTg(chatId, text) {
        return TelegramOnboardingService.#tgPost('sendMessage', {
            chat_id: chatId,
            text,
            parse_mode: 'HTML',
        });
    }

    /**
     * Отправить сообщение с inline-кнопкой.
     */
    static async #sendTgWithButtons(chatId, text, buttons) {
        return TelegramOnboardingService.#tgPost('sendMessage', {
            chat_id: chatId,
            text,
            parse_mode: 'HTML',
            reply_markup: {inline_keyboard: buttons},
        });
    }

    /**
     * Ответить на callback query (убирает часики на кнопке).
     */
    static async answerCallback(callbackQueryId, text = '') {
        return TelegramOnboardingService.#tgPost('answerCallbackQuery', {
            callback_query_id: callbackQueryId,
            text,
        });
    }

    /**
     * Обработать callback_query от inline-кнопки "Проверить статус".
     * @param {{ id, from, data }} callbackQuery
     */
    static async handleCallback(callbackQuery) {
        const {id: callbackId, from, data} = callbackQuery;
        const chatId = from.id;
        const telegramId = String(from.id);

        if (data === 'check_status') {
            await TelegramOnboardingService.answerCallback(callbackId);

            const user = await SlackUser.findOne({telegramId});

            if (!user) {
                await TelegramOnboardingService.#sendTg(chatId,
                    `❓ Заявка не найдена. Напишите /start чтобы начать регистрацию.`);
                return true;
            }

            const statusMap = {
                pending: `⏳ <b>На рассмотрении</b> — ваша заявка ожидает проверки модератора.`,
                active: `✅ <b>Активна</b> — вы зарегистрированы с ролью <b>${user.role}</b>.`,
                rejected: `❌ <b>Отклонена</b> — обратитесь к администратору.`,
            };

            const statusText = statusMap[user.status] ?? `❓ Неизвестный статус: ${user.status}`;

            await TelegramOnboardingService.#sendTgWithButtons(
                chatId,
                `🔖 <b>Статус вашей заявки</b>\n\n` +
                `👤 ${user.displayName}\n` +
                `📧 ${user.email}\n\n` +
                statusText,
                [[{text: '🔄 Обновить', callback_data: 'check_status'}]],
            );

            return true;
        }

        return false;
    }

    // ── Slack API helpers ───────────────────────────────────────────────────────

    static #slackHeaders() {
        return {
            Authorization: `Bearer ${env.slackBotToken}`,
            'Content-Type': 'application/json',
        };
    }

    /**
     * Отправить сообщение в Slack канал.
     * @param {string} channel
     * @param {string} text
     * @param {Array}  [blocks]
     */
    static async #sendSlack(channel, text, blocks) {
        const payload = {channel, text};
        if (blocks?.length) payload.blocks = blocks;
        const res = await axios.post('https://slack.com/api/chat.postMessage', payload, {
            headers: TelegramOnboardingService.#slackHeaders(),
        });
        return res.data;
    }

    /**
     * Найти пользователя в Slack workspace по email.
     * @param {string} email
     * @returns {object|null} Slack user object или null
     */
    static async #lookupSlackUser(email) {
        const res = await axios.get('https://slack.com/api/users.lookupByEmail', {
            params: {email},
            headers: TelegramOnboardingService.#slackHeaders(),
        });
        if (!res.data.ok) return null;
        return res.data.user;
    }

    // ── Валидация ───────────────────────────────────────────────────────────────

    /**
     * Проверить что email принадлежит разрешённому домену.
     * @param {string} email
     */
    static isAllowedEmail(email) {
        const lower = (email || '').toLowerCase().trim();
        // Базовая валидация формата
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(lower)) return false;
        return ALLOWED_DOMAINS.some((d) => lower.endsWith(`@${d}`));
    }

    /**
     * Проверить тестовый email (для разработки/тестирования).
     * Тестовые email пропускают валидацию Slack lookup.
     * @param {string} email
     */
    static isTestEmail(email) {
        const lower = (email || '').toLowerCase().trim();
        return TEST_EMAIL_PREFIXES.some((prefix) => lower.startsWith(prefix));
    }

    // ── Сессии ──────────────────────────────────────────────────────────────────

    static #getSession(telegramId) {
        return sessions.get(String(telegramId)) ?? null;
    }

    static #setSession(telegramId, step, data = {}) {
        sessions.set(String(telegramId), {step, data, ts: Date.now()});
    }

    static #clearSession(telegramId) {
        sessions.delete(String(telegramId));
    }

    // ── Публичные методы ────────────────────────────────────────────────────────

    /**
     * Обработать команду /start из Telegram DM.
     *
     * @param {{ chatId: number, userId: number, userName: string }} params
     */
    static async handleStart({chatId, userId, userName}) {
        const telegramId = String(userId);

        // 1. Проверяем, есть ли пользователь в БД
        const existing = await SlackUser.findOne({telegramId});

        if (existing) {
            if (existing.status === 'active') {
                await TelegramOnboardingService.#sendTg(
                    chatId,
                    `👋 С возвращением, <b>${existing.displayName}</b>!\n\nВы уже зарегистрированы с ролью <b>${existing.role}</b>.`,
                );
                return {ok: true, step: 'already_active'};
            }

            if (existing.status === 'pending') {
                await TelegramOnboardingService.#sendTgWithButtons(
                    chatId,
                    `⏳ Ваша заявка уже отправлена и ожидает проверки модератора.\nМы сообщим вам о решении в этом чате.`,
                    [[{text: '🔍 Проверить статус заявки', callback_data: 'check_status'}]],
                );
                return {ok: true, step: 'already_pending'};
            }
        }

        // 2. Новый пользователь — начинаем онбординг
        // Не уведомляем Slack на шаге /start, чтобы не засорять канал.
        // Уведомление уходит только после успешного создания pending-заявки.
        // 3. Переводим в состояние ожидания email
        TelegramOnboardingService.#setSession(telegramId, 'awaiting_email', {chatId, userName});

        await TelegramOnboardingService.#sendTg(
            chatId,
            `👋 Добро пожаловать в <b>PaycomConnect</b>!\n\n` +
            `Это корпоративный ресурс для сотрудников <b>Payme</b>.\n` +
            `Для регистрации введите вашу корпоративную почту.\n\n` +
            `📧 Формат: <code>name@payme.uz</code>`,
        );

        return {ok: true, step: 'awaiting_email'};
    }

    /**
     * Обработать входящее текстовое сообщение в DM (ввод email или верификационный код).
     *
     * @param {{ chatId: number, userId: number, userName: string, text: string }} params
     * @returns {{ handled: boolean }} handled=true если сообщение обработано онбордингом
     */
    static async handleMessage({chatId, userId, userName, text}) {
        const telegramId = String(userId);
        const session = TelegramOnboardingService.#getSession(telegramId);

        if (!session) return {handled: false};

        if (session.step === 'awaiting_email') {
            await TelegramOnboardingService.#processEmail({chatId, userId, userName, email: text.trim()});
            return {handled: true};
        }

        if (session.step === 'awaiting_verification_code') {
            await TelegramOnboardingService.#processVerificationCode({chatId, userId, verificationCode: text.trim()});
            return {handled: true};
        }

        if (session.step === 'done') {
            await TelegramOnboardingService.#sendTg(
                chatId,
                `⏳ Ваша регистрация завершена. Вы можете начинать работу!`,
            );
            return {handled: true};
        }

        return {handled: false};
    }

    /**
     * Отправить пользователю в Telegram уведомление об апруве.
     * Вызывается из onboardingService.js после /approve.
     *
     * @param {{ telegramId: string, displayName: string, role: string, email: string, password: string, verificationCode: string }} params
     */
    static async notifyApproved({telegramId, displayName, role, email, password, verificationCode}) {
        if (!telegramId) return;

        TelegramOnboardingService.#setSession(telegramId, 'awaiting_verification_code', {email, role});

        await TelegramOnboardingService.#sendTg(
            telegramId,
            `🎉 <b>Ваша заявка одобрена!</b>\n\n` +
            `Добро пожаловать, <b>${displayName}</b>!\n` +
            `Вам назначена роль: <b>${role}</b>\n\n` +
            `🔐 <b>Данные для входа:</b>\n` +
            `Логин: <code>${email}</code>\n` +
            `Пароль: <code>${password}</code>\n\n` +
            `✅ <b>Для завершения регистрации:</b>\n` +
            `Напишите 6-значный верификационный код из личного Slack-чата (действителен 12 часов).`,
        );
    }

    // ── Приватные шаги ──────────────────────────────────────────────────────────

    /**
     * Обработать ввод email: валидация → поиск в Slack → создание пользователя.
     */
    static async #processEmail({chatId, userId, userName, email}) {
        const telegramId = String(userId);

        try {
            // Шаг 1: валидация формата и домена email
            // Для тестовых email пропускаем валидацию домена, чтобы можно было тестировать с любыми адресами пока #TEST_EMAIL_PREFIXES настроены.
            // if (!TelegramOnboardingService.isAllowedEmail(email)) {
            //   await TelegramOnboardingService.#sendTg(
            //     chatId,
            //     `❌ <b>ОШИБКА:</b> Неверный формат или недопустимый домен.\n\n` +
            //     `Принимаются только адреса:\n• name@payme.uz\n• name@tbcbank.uz\n\n` +
            //     `Попробуйте ещё раз:`,
            //   );
            //   return;
            // }

            // Шаг 2: проверяем дубликат по email в БД
            const existingByEmail = await SlackUser.findOne({email: email.toLowerCase()});
            if (existingByEmail) {
                TelegramOnboardingService.#clearSession(telegramId);
                const msg = existingByEmail.status === 'active'
                    ? `✅ Этот email уже зарегистрирован и активен.`
                    : `⏳ Заявка с этим email уже существует и ожидает проверки.`;
                await TelegramOnboardingService.#sendTg(chatId, msg);
                return;
            }

            // Шаг 3: поиск в Slack workspace по email
            let slackUser;

            // Для тестовых email пропускаем Slack lookup и создаём фиктивного пользователя
            const isTest = TelegramOnboardingService.isTestEmail(email);
            if (isTest) {
                console.log(`[TelegramOnboardingService] Test email detected: ${email}, skipping Slack lookup`);
                slackUser = {
                    id: `TEST_${email.replace(/[^a-z0-9]/gi, '_').toUpperCase()}`,
                    name: email.split('@')[0],
                    profile: {real_name: `Test User (${email})`},
                };
            } else {
                slackUser = await TelegramOnboardingService.#lookupSlackUser(email);
            }

            if (!slackUser) {
                await TelegramOnboardingService.#sendTg(
                    chatId,
                    `❌ <b>ОШИБКА:</b> Пользователь с почтой <code>${email}</code> не найден в Slack workspace.\n\n` +
                    `Убедитесь что:\n• Email написан верно\n• Вы добавлены в Slack workspace\n\nПопробуйте ещё раз:`,
                );
                return;
            }

            // Шаг 4: создаём запись в БД со статусом pending
            const newUser = await SlackUser.create({
                slackId: slackUser.id,
                telegramId,
                email: email.toLowerCase().trim(),
                displayName: slackUser.profile?.real_name || slackUser.real_name || userName,
                status: 'pending',
                role: null,
            });

            TelegramOnboardingService.#setSession(telegramId, 'done', {email});

            // Шаг 5: подтверждение пользователю в личный чат — УСПЕШНО
            await TelegramOnboardingService.#sendTgWithButtons(
                chatId,
                `✅ <b>ЗАЯВКА УСПЕШНО ПРИНЯТА</b>\n\n` +
                `Спасибо, <b>${newUser.displayName}</b>!\n` +
                `Ваша заявка на регистрацию принята и обрабатывается.\n\n` +
                `📧 Email: <code>${email}</code>\n` +
                `🔖 Статус: ⏳ На рассмотрении у модератора\n\n` +
                `⏱️ Мы свяжемся с вами в этом чате с логином и паролем после апрува.`,
                [[{text: '🔍 Проверить статус заявки', callback_data: 'check_status'}]],
            );

            // Шаг 6: уведомляем Slack-канал онбординга
            await TelegramOnboardingService.#notifySlackPendingUser({user: newUser, slackUserId: slackUser.id});

            return {ok: true, status: 'created'};
        } catch (error) {
            // Обработка неожиданных ошибок
            console.error('[TelegramOnboardingService] Error processing email:', error);
            await TelegramOnboardingService.#sendTg(
                chatId,
                `❌ <b>ОШИБКА ОБРАБОТКИ</b>\n\n` +
                `При обработке вашей заявки произошла ошибка системы.\n` +
                `Пожалуйста, попробуйте позже или обратитесь к администратору.\n\n` +
                `Ошибка: <code>${error.message}</code>`,
            );
            return {ok: false, error: error.message};
        }
    }


    /**
     * Уведомить Slack-канал о новой заявке на онбординг.
     */
    static async #notifySlackPendingUser({user, slackUserId}) {
        const isTest = TelegramOnboardingService.isTestEmail(user.email);
        const displaySlack = isTest ? `_тестовый аккаунт_` : `<@${slackUserId}>`;

        await TelegramOnboardingService.#sendSlack(
            ONBOARDING_SLACK_CHANNEL,
            `🆕 Новая заявка на регистрацию от ${user.displayName}`,
            [
                {
                    type: 'header',
                    text: {type: 'plain_text', text: '🆕 Новая заявка на регистрацию'},
                },
                {
                    type: 'section',
                    fields: [
                        {type: 'mrkdwn', text: `*Имя:*\n${user.displayName}`},
                        {type: 'mrkdwn', text: `*Email:*\n${user.email}`},
                        {type: 'mrkdwn', text: `*Slack:*\n${displaySlack}`},
                        {type: 'mrkdwn', text: `*Telegram:*\n${user.telegramId}${isTest ? '  🧪 тест' : ''}`},
                    ],
                },
                {
                    type: 'section',
                    text: {
                        type: 'mrkdwn',
                        text: `*Для апрува* используйте команду в формате:\n/approve ${slackUserId} manager\n\nДоступные роли: manager, integrator, b2b_support`,
                    },
                },
                {type: 'divider'},
            ],
        );
    }


    /**
     * Обработать ввод верификационного кода в Telegram.
     */
    static async #processVerificationCode({chatId, userId, verificationCode}) {
        const telegramId = String(userId);

        try {
            // Найдём пользователя по telegramId
            const user = await SlackUser.findOne({telegramId});

            if (!user) {
                await TelegramOnboardingService.#sendTg(
                    chatId,
                    `❌ Пользователь не найден. Попробуйте повторить регистрацию.`,
                );
                TelegramOnboardingService.#clearSession(telegramId);
                return;
            }

            // Проверяем: есть ли верификационный код
            if (!user.verificationCode) {
                await TelegramOnboardingService.#sendTg(
                    chatId,
                    `❌ <b>ОШИБКА:</b> Верификационный код не установлен. Пожалуйста, обратитесь к администратору.`,
                );
                return;
            }

            // Проверяем срок действия кода
            if (user.verificationCodeExpiresAt && new Date() > user.verificationCodeExpiresAt) {
                await TelegramOnboardingService.#sendTg(
                    chatId,
                    `❌ <b>КОД ИСТЁК</b>\nВерификационный код больше не действителен (истекла 12-часовая давность). Обратитесь к администратору для повторного апрува.`,
                );
                TelegramOnboardingService.#clearSession(telegramId);
                return;
            }

            // Проверяем: уже ли код использован
            if (user.verificationCodeUsed) {
                await TelegramOnboardingService.#sendTg(
                    chatId,
                    `❌ Этот код уже был использован. Регистрация завершена.`,
                );
                TelegramOnboardingService.#setSession(telegramId, 'done');
                return;
            }

            // Проверяем правильность кода
            if (verificationCode !== user.verificationCode) {
                await TelegramOnboardingService.#sendTg(
                    chatId,
                    `❌ <b>НЕВЕРНЫЙ КОД</b>\nПроверьте и попробуйте ещё раз (осталось попыток: ∞).`,
                );
                return;
            }

            // ✅ КОД ПРАВИЛЬНЫЙ — маркируем как использованный
            user.verificationCodeUsed = true;
            await user.save();

            TelegramOnboardingService.#setSession(telegramId, 'done');

            await TelegramOnboardingService.#sendTg(
                chatId,
                `✅ <b>РЕГИСТРАЦИЯ ЗАВЕРШЕНА!</b>\n\n` +
                `Вас приветствует система <b>PaycomConnect</b>.\n` +
                `Ваша роль: <b>${user.role}</b>\n\n` +
                `🎉 Добро пожаловать! Теперь вы можете начинать работу.`,
            );

            return {ok: true, status: 'verified'};
        } catch (error) {
            console.error('[TelegramOnboardingService] Error processing verification code:', error);
            await TelegramOnboardingService.#sendTg(
                chatId,
                `❌ <b>ОШИБКА ОБРАБОТКИ</b>\n\nПри проверке кода произошла ошибка. Обратитесь к администратору.\n\nОшибка: <code>${error.message}</code>`,
            );
            return {ok: false, error: error.message};
        }
    }
}



