# Запуск через ngrok (тест до деплоя)

Цель — прогнать PaycomConnect с реальными Telegram/Slack webhook'ами **до**
полноценного деплоя на `paycom.monitoring-jira.uz`. ngrok даёт публичный HTTPS-URL,
который проксирует на локальный контейнер приложения (порт `9010`).

Порядок: **сначала ngrok → проверяем → потом деплой** (см. `docs/deployment.md`).

## 1. Подготовка `.env`

```bash
cp .env.example .env
```

Заполнить как минимум:

- `NGROK_AUTHTOKEN` — токен из https://dashboard.ngrok.com
- `TELEGRAM_BOT_TOKEN` — токен бота
- `MONGODB_URI` — облачная Mongo (Atlas). Можно оставить пустым — тогда включится
  in-memory режим (данные не сохраняются между перезапусками).
- (опц.) `TELEGRAM_WEBHOOK_SECRET` — секрет для проверки webhook'а
- (опц.) `NGROK_DOMAIN` — зарезервированный домен ngrok, чтобы URL не менялся при
  каждом запуске (иначе URL случайный и после рестарта нужно снова ставить webhook)

## 2. Запуск приложения + туннеля

```bash
docker compose -f docker-compose.yml -f docker-compose.ngrok.yml up -d --build
docker compose -f docker-compose.yml -f docker-compose.ngrok.yml ps
docker compose -f docker-compose.yml -f docker-compose.ngrok.yml logs -f paycomconnect ngrok
```

Проверка, что приложение живо (внутри контейнера ngrok или на хосте, если открыт порт):

```bash
curl -s http://127.0.0.1:4040/api/tunnels        # публичный URL от ngrok
```

Инспектор ngrok доступен на http://127.0.0.1:4040 (видно все входящие запросы —
удобно отлаживать webhook'и).

## 3. Настроить Telegram-бота и webhook

```bash
npm run setup:telegram          # команды/описания бота (один раз)
npm run webhook:ngrok           # берёт URL из ngrok и ставит webhook автоматически
```

`webhook:ngrok` определит публичный URL и поставит webhook на
`<ngrok-url>/api/telegram/webhook` (с `TELEGRAM_WEBHOOK_SECRET`, если задан).

Полезные варианты:

```bash
npm run webhook:ngrok -- --print     # только показать URL, не менять webhook
npm run webhook:ngrok -- --delete    # удалить webhook
node ./scripts/setup-telegram.mjs --info   # текущее состояние webhook'а
```

## 4. Проверка

- Написать боту в Telegram → в логах `paycomconnect` и в инспекторе ngrok
  (http://127.0.0.1:4040) должны появиться входящие апдейты.
- `GET <ngrok-url>/api/health` → `{"status":"ok",...}`.

## 5. Остановка

```bash
docker compose -f docker-compose.yml -f docker-compose.ngrok.yml down
```

## Заметки

- Без `NGROK_DOMAIN` публичный URL меняется при каждом рестарте ngrok — после
  рестарта снова выполните `npm run webhook:ngrok`.
- Для теста можно запускать это на своей машине или на VM — ngrok-контейнер
  соединяется с приложением по имени сервиса `paycomconnect:9010`, поэтому
  публиковать порт на хост не нужно (в этом override он отключён).
- Когда всё проверено — переходите к постоянному деплою на субдомен по
  `docs/deployment.md` (nginx + сертификат + порт 9010), а webhook переставьте на
  `https://paycom.monitoring-jira.uz/api/telegram/webhook`.
