# Cloudflare Workers VPN

Этот проект разворачивает "VPN-подобный" прокси на Cloudflare Workers через `VLESS + WebSocket`.

Важно: это не настоящий WireGuard/OpenVPN/L3 VPN. И ещё важнее: Cloudflare Workers блокируют TCP-проксирование обычного веб-трафика на порты `80` и `443`, поэтому такой проект не может работать как нормальный VPN для браузера и большинства приложений.

## Что умеет

- Принимает `VLESS over WebSocket`.
- Проксирует TCP-трафик через `cloudflare:sockets`.
- Поддерживает UDP только для DNS (`53`) через DNS-over-HTTPS.
- Отдает ссылку-подписку и готовый `sing-box` JSON.
- Имеет стартовую страницу `/` и health-check `/health`.

## Ограничения

- Это не полный VPN на сетевом уровне.
- Cloudflare Workers блокируют исходящие TCP-подключения через `connect()` к обычным веб-портам `80` и `443`, поэтому сайты через такой Worker открываться не будут.
- Обычный UDP не поддерживается.
- Cloudflare Workers блокируют исходящие TCP-соединения на Cloudflare IP ranges, поэтому часть сайтов за Cloudflare может не открываться через такой прокси.
- Для тяжелой нагрузки и долгих соединений у Cloudflare есть лимиты по Workers и соединениям.

## Структура

- `src/index.js` — основной Worker.
- `wrangler.toml` — конфиг Wrangler.
- `.dev.vars.example` — пример локальных секретов.

## Быстрый старт

### 1. Установи зависимости

```powershell
npm install
```

### 2. Ничего заполнять не нужно

Я уже создал и заполнил `.dev.vars`, а также прописал те же значения в `wrangler.toml`.

Готовые значения:

- `UUID`: `116a2ae6-ec7c-48de-8167-6df2cff1b712`
- `WS_PATH`: `8ie27gsoxrktad`
- `SUBSCRIPTION_TOKEN`: `njhg16wor5xa84m2p9`
- `USER_NICKNAME`: `Ilya VPN`

### 3. Локальный запуск

```powershell
npm run dev
```

Потом открой:

- `http://127.0.0.1:8787/`
- `http://127.0.0.1:8787/health`

### 4. Авторизация в Cloudflare

Если ты еще не логинился в Wrangler:

```powershell
npx wrangler login
```

### 5. Секреты вручную добавлять не нужно

Для упрощения я уже положил значения в `wrangler.toml`, поэтому отдельный шаг с `wrangler secret put ...` можно пропустить.

### 6. Деплой

```powershell
npm run deploy
```

После деплоя ты получишь адрес вида:

```text
https://cf-vpn-ft6yok.<subdomain>.workers.dev
```

## Как получить конфиг

После деплоя открой:

```text
https://<worker-host>/config/njhg16wor5xa84m2p9
```

Там будут:

- готовая `vless://` ссылка;
- plain subscription;
- base64 subscription;
- JSON для `sing-box`.

## Подключение в клиентах

### Вариант 1. v2rayN / v2rayNG / Nekobox / Hiddify

1. Открой `/config/<SUBSCRIPTION_TOKEN>`.
2. Скопируй `vless://...` ссылку.
3. Импортируй ее в клиент.
4. Включи режим VPN/TUN в клиенте, если нужен перехват всего трафика устройства.

Но для обычного веб-трафика этот вариант не заработает из-за ограничения Cloudflare на порты `80/443`.

Параметры у подключения будут такие:

- Address / Server: твой `workers.dev` домен или custom domain.
- Port: `443`
- UUID: твой `UUID`
- Network: `ws`
- Path: `/${WS_PATH}`
- TLS: `on`
- SNI: домен Worker
- Host header: домен Worker

### Вариант 2. sing-box

Открой:

```text
https://<worker-host>/client/<SUBSCRIPTION_TOKEN>/sing-box.json
```

И используй полученный JSON как базу для клиента `sing-box`.

## Полезные URL

- `/` — статус-страница Worker.
- `/health` — JSON-проверка.
- `/sub/<SUBSCRIPTION_TOKEN>` — plain subscription.
- `/sub/<SUBSCRIPTION_TOKEN>?format=base64` — base64 subscription.
- `/config/<SUBSCRIPTION_TOKEN>` — удобная страница с конфигом.
- `/client/<SUBSCRIPTION_TOKEN>/sing-box.json` — JSON для sing-box.

## Что можно улучшить потом

- Добавить подписку сразу в нескольких форматах.
- Добавить шаблоны под Clash Meta.
- Разнести публичную страницу и секретные endpoints по отдельным Worker routes.
- Привязать custom domain вместо `workers.dev`.

## Self-test

Проверка текущего Worker из терминала:

```powershell
npm run self-test
```

По умолчанию тест пытается открыть `example.com:443` через Worker и сейчас должен падать с понятным сообщением о том, что Cloudflare не дает проксировать веб-порты `80/443`.

## Proxy Blocklist Builder

Если тебе нужен защитный список подозрительных датацентровых/прокси-сетей для своего сервера, можно собрать его из официальных публичных фидов:

- AWS `ip-ranges.json`
- Google Cloud `cloud.json`
- Tor bulk exit list

Сборка:

```powershell
npm run build-blocklist
```

Результат:

- `generated/proxy-blocklist.txt` - список CIDR/IP для твоего бан-скрипта
- `generated/proxy-blocklist.json` - метаданные по источникам и количеству

Дополнительно свои CIDR можно положить в `blocklist.config.json`.
