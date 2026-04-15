# Telegram Schedule Bot

Этот бот работает без постоянного сервера: GitHub Actions раз в 5 минут опрашивает Telegram и, если ты нажал кнопку `Отправь расписание` или отправил `/schedule`, забирает PDF-файлы с публичного Яндекс Диска начиная с сегодняшней даты и отправляет их тебе в Telegram.

## Что уже настроено

- Публичная ссылка Яндекс Диска: `https://disk.yandex.ru/d/bxAEJ55nQmgUTg`
- Кнопка: `Отправь расписание`
- Часовой пояс: `Europe/Moscow`
- Состояние offset хранится в `state/telegram-offset.json`

## Файлы

- `scripts/telegram-schedule-bot.mjs` - логика бота
- `.github/workflows/telegram-schedule-bot.yml` - запуск в GitHub Actions каждые 5 минут
- `telegram-schedule-bot.config.json` - настройки кнопки, ссылки и таймзоны
- `state/telegram-offset.json` - последний обработанный Telegram update

## Как запустить

1. Создай Telegram-бота через `@BotFather` и получи токен.
2. В GitHub репозитории открой `Settings -> Secrets and variables -> Actions`.
3. Добавь secret `TELEGRAM_BOT_TOKEN` со значением токена бота.
4. По желанию добавь secret `TELEGRAM_ALLOWED_CHAT_IDS`.
   Если хочешь ограничить бота только своим чатом, сначала напиши боту `/start`, потом `/whoami`, и сохрани туда свой chat id.
5. Закоммить и запушь файлы в GitHub.
6. Вкладка `Actions` -> `Telegram Schedule Bot` -> `Run workflow`, чтобы первый раз запустить вручную.
7. Напиши боту `/start`.
8. Нажми кнопку `Отправь расписание`.

## Как это работает

- Бот смотрит на имена файлов на Яндекс Диске.
- Из имени берётся дата вроде `15 апреля`.
- Отбираются только PDF с датой `сегодня и позже`.
- Затем бот шлёт сначала список найденных файлов, а потом сами PDF по одному.

## Локальная проверка

Dry-run без Telegram:

```powershell
npm run telegram-schedule-dry-run
```

Проверка на конкретную дату:

```powershell
node scripts/telegram-schedule-bot.mjs --dry-run --today 2026-04-15
```

## Ограничения

- GitHub Actions по cron запускается не чаще, чем раз в 5 минут, поэтому бот отвечает не мгновенно.
- Если Яндекс поменяет формат названий файлов, надо будет обновить парсер даты в `scripts/telegram-schedule-bot.mjs`.
