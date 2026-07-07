# PaycomConnect

PaycomConnect — MVP-сервис для синхронизации коммуникаций между Telegram и Slack с базовым CRM-слоем, аналитикой и подготовкой к интеграции с JIRA.

## Что уже реализовано

- Прием сообщений из Telegram и Slack через webhook/mock endpoints.
- Нормализация payload'ов обеих платформ в единый формат.
- Логирование первого взаимодействия пользователя.
- CRM-учет контактов и истории сообщений.
- In-memory режим без MongoDB и автоматическое переключение на MongoDB при наличии `MONGODB_URI`.
- Триггер JIRA по ключевым словам (`оплата`, `ошибка`, `problem`, `issue`, `bug` и т.д.).
- Mock/live режимы для Telegram, Slack и JIRA.
- Базовая аналитика по сообщениям, первым обращениям и JIRA-trigger'ам.

## Архитектура

- `index.js` — инициализация Express-приложения.
- `bin/www` — HTTP entrypoint.
- `config/env.js` — загрузка и нормализация env-переменных.
- `routes/api.js` — API и webhook маршруты.
- `services/bridgeService.js` — центральный orchestration-слой обработки сообщений.
- `services/persistenceService.js` — хранение данных в MongoDB или памяти.
- `models/*` — Mongoose-модели для CRM и JIRA.

Дополнительная документация:

- `docs/system-overview.md` — краткая документация текущей системы: поток сообщений, структура каталогов, модели данных, endpoint'ы, конфигурация и известный технический долг.
- `docs/architecture-recommendation.md` — рекомендация по архитектуре (монолит vs микросервисы), куда встраиваются Jira-автоматизация, интеграция с Balancer (Telegram → Telegram с лимитерами) и admin web, а также поэтапный roadmap.
- `docs/bridge-architecture.md` — текущие границы модулей и рекомендуемая архитектура Slack ↔ Telegram bridge.
- `docs/slack-permissions.md` — минимальные Slack scopes с объяснением, какие текущие scopes можно удалить.

## Быстрый старт

1. Установите зависимости.
2. Скопируйте `.env.example` в `.env`.
3. При необходимости укажите реальные ключи Telegram / Slack / JIRA.
4. Запустите проект.

### Команды

```powershell
npm install
Copy-Item .env.example .env
npm start
```

## Основные endpoint'ы

### Служебные

- `GET /` — веб-страница со статусом MVP.
- `GET /api/health` — healthcheck и текущая аналитика.
- `GET /api/analytics/summary` — агрегированная аналитика.
- `GET /api/messages/recent` — последние сообщения.

### Mock endpoints

#### Telegram → Slack

```powershell
Invoke-RestMethod -Method Post -Uri http://localhost:9010/api/mock/telegram -ContentType 'application/json' -Body '{"messageId":"tg-1","userId":"1001","userName":"Ali","channelId":"telegram-support","text":"Есть проблема с оплатой №12345"}'
```

#### Slack → Telegram

```powershell
Invoke-RestMethod -Method Post -Uri http://localhost:9010/api/mock/slack -ContentType 'application/json' -Body '{"event_id":"slack-1","userId":"U100","userName":"Support Bot","channelId":"C123","text":"Problem with invoice 12345"}'
```

### Webhooks

- `POST /api/webhooks/telegram`
- `POST /api/webhooks/slack`

> В Slack route поддерживает `url_verification` и игнорирует `bot_message` события.

## Принцип работы

1. Входящее сообщение попадает в API.
2. `bridgeService` нормализует его и проверяет дубликаты.
3. Контакт обновляется в CRM; для первого сообщения это фиксируется отдельно.
4. По правилам может быть создана задача в JIRA.
5. Сообщение отправляется в целевую платформу либо эмулируется в mock-режиме.
6. Данные попадают в аналитику.

## Проверка

```powershell
npm test
```

## Следующие шаги

- Добавить валидацию подписи Slack и Telegram secret token.
- Пересылать файлы не только как метаданные, но и как реальные вложения.
- Хранить mapping каналов/чатов Telegram ↔ Slack в отдельной коллекции.
- Добавить правила категоризации задач JIRA и SLA-аналитику.

