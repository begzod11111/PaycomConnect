# PaycomConnect

PaycomConnect — сервис на **NestJS + TypeScript** для синхронизации коммуникаций между Telegram и Slack с CRM-слоем, аналитикой и интеграцией с Jira.

## Что реализовано

- Приём сообщений из Telegram и Slack через webhook/mock endpoints.
- Нормализация payload'ов обеих платформ в единый формат + пересылка (текст и медиа).
- Онбординг пользователей (Slack-DM и Telegram-DM), `/approve`, connect-визард.
- Связки Telegram-группа ↔ Slack-канал по ИНН + активация по Jira-задаче.
- CRM-учёт контактов и истории сообщений.
- In-memory режим без MongoDB и автоматическое переключение на MongoDB при наличии `MONGODB_URI`.
- Триггер Jira по ключевым словам; сервис-сервис авторизация для Balancer.
- Базовая аналитика по сообщениям, первым обращениям и Jira-trigger'ам.

## Архитектура

Единое NestJS-приложение (Express-версия удалена):

- `src/main.ts` — bootstrap (подключение к MongoDB + memory fallback).
- `src/http/*` — контроллеры (webhooks, slash-команды, mock, data/admin API).
- `src/runtime/*` — доменная логика: `bridge`, `connections`, `persistence`,
  `telegram`/`slack`/`jira`, онбординг и connect-визард.
- `src/common/*` — `ServiceAuthGuard` (авторизация Balancer) и модель прав по ролям.
- `src/domain/*` — целевые сущности (Organization, User, Chat, Connection, Message …)
  для дальнейшего перехода с legacy-моделей.

Дополнительная документация:

- `docs/system-overview.md` — краткая документация текущей системы: поток сообщений, структура каталогов, модели данных, endpoint'ы, конфигурация и известный технический долг.
- `docs/architecture-recommendation.md` — рекомендация по архитектуре (монолит vs микросервисы), куда встраиваются Jira-автоматизация, интеграция с Balancer (Telegram → Telegram с лимитерами) и admin web, а также поэтапный roadmap.
- `docs/service-auth.md` — сервис-сервис авторизация (Balancer → PaycomConnect): схема `base64("name:secret")`, конфигурация, генерация ключа.
- `docs/target-structure.md` — предлагаемая архитектура каталогов/файлов и пошаговая миграция (для анализа).
- `docs/performance-and-media.md` — анализ задержек и пересылки медиа: причины, что уже исправлено, план ускорения.
- `docs/framework-decision.md` — выбор фреймворка для рефакторинга (NestJS vs Express), целевая структура и стратегия миграции (strangler).
- `docs/domain-model.md` — сущности (Organization, User, Chat, Membership, Connection, JiraTask, Message, OnboardingSession) и их связи.
- `docs/onboarding-redesign.md` — как онбординг и connect работают сейчас и как переписываются вокруг сущностей.
- `docs/media-and-permissions.md` — метаданные сообщений, права по ролям (кто может слать файлы/аудио) и pipeline красивой передачи медиа.

- `docs/bridge-architecture.md` — границы модулей и архитектура Slack ↔ Telegram bridge.
- `docs/slack-permissions.md` — минимальные Slack scopes.

## Запуск

```bash
npm install
cp .env.example .env
npm run build      # сборка TypeScript
npm test           # e2e-тесты (10/10)
npm start          # запуск (MONGODB_URI опционально — есть memory-режим)
```

При `npm start` автоматически поднимается **ngrok**-туннель, если задан
`NGROK_AUTHTOKEN` (и опционально бесплатный статический домен `NGROK_DOMAIN`).
В логах печатаются готовые URL для вебхуков Telegram/Slack. Отключить —
`ENABLE_NGROK=false`.

### Вспомогательные скрипты

```bash
# Настроить Telegram-бота (команды, описание; --webhook для установки вебхука)
npm run setup:telegram
npm run setup:telegram -- --webhook
npm run setup:telegram -- --info

# Сгенерировать 36-символьный ключ сервис-клиента для SERVICE_CLIENTS
npm run gen:service-key balancer
```

## Основные endpoint'ы

### Служебные (data/admin — под сервис-авторизацией)

- `GET /api/health` — healthcheck и текущая аналитика.
- `GET /api/analytics/summary` — агрегированная аналитика.
- `GET /api/messages/recent` — последние сообщения.
- `GET/PATCH/DELETE /api/connections[/:inn]`, `POST /api/connections/:inn/jira`.

### Mock endpoints

```bash
curl -X POST http://localhost:9010/api/mock/telegram -H 'Content-Type: application/json' \
  -d '{"messageId":"tg-1","userId":"1001","userName":"Ali","channelId":"telegram-support","text":"Есть проблема с оплатой №12345"}'

curl -X POST http://localhost:9010/api/mock/slack -H 'Content-Type: application/json' \
  -d '{"event_id":"slack-1","userId":"U100","userName":"Support Bot","channelId":"C123","text":"Problem with invoice 12345"}'
```

### Webhooks и команды

- `POST /api/telegram/webhook` — Telegram (онбординг, callback-визард, connect, мост).
- `POST /api/slack/webhook` — Slack Events (онбординг DM, мост).
- `POST /api/slack/commands/{connect,disconnect,approve,script,skript}` — slash-команды.

## Принцип работы

1. Входящее сообщение попадает в контроллер (webhook ACK'ается быстро).
2. `runtime/bridge` нормализует его и проверяет дубликаты.
3. Контакт обновляется в CRM; для первого сообщения это фиксируется отдельно.
4. По ключевым словам может быть создана задача в Jira.
5. Сообщение отправляется в целевую платформу либо эмулируется в mock-режиме.
6. Данные попадают в аналитику.

## Следующие шаги

- Очередь + исходящий rate-limit (для Balancer Telegram → Telegram и стабильной доставки медиа).
- Переход с legacy-моделей (`runtime/models`) на сущности (`src/domain/*`) с backfill.
- Хэширование секретов онбординга; вынос in-memory состояния в Redis.

