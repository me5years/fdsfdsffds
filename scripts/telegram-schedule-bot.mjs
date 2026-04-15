import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const CONFIG_PATH = path.join(ROOT_DIR, "telegram-schedule-bot.config.json");
const STATE_PATH = path.join(ROOT_DIR, "state", "telegram-offset.json");
const YANDEX_API_URL = "https://cloud-api.yandex.net/v1/disk/public/resources";
const MONTHS = new Map([
  ["января", 1],
  ["февраля", 2],
  ["марта", 3],
  ["апреля", 4],
  ["мая", 5],
  ["июня", 6],
  ["июля", 7],
  ["августа", 8],
  ["сентября", 9],
  ["октября", 10],
  ["ноября", 11],
  ["декабря", 12],
]);

function parseArgs(argv) {
  const options = {
    dryRun: false,
    todayIso: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    if (argument === "--dry-run") {
      options.dryRun = true;
      continue;
    }

    if (argument === "--today" && argv[index + 1]) {
      options.todayIso = argv[index + 1];
      index += 1;
    }
  }

  return options;
}

async function readJson(filePath, fallbackValue) {
  try {
    const raw = await readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return fallbackValue;
    }

    throw error;
  }
}

function normalizeCommand(text) {
  return String(text || "").trim().toLowerCase();
}

function normalizeBotCommand(text, commandName) {
  return new RegExp(`^\\/${commandName}(?:@[^\\s]+)?$`, "i").test(String(text || "").trim());
}

function getTodayParts(timeZone, overrideIso = null) {
  if (overrideIso) {
    const matched = /^(\d{4})-(\d{2})-(\d{2})$/.exec(overrideIso);
    if (!matched) {
      throw new Error(`Invalid --today value: ${overrideIso}`);
    }

    return {
      year: Number.parseInt(matched[1], 10),
      month: Number.parseInt(matched[2], 10),
      day: Number.parseInt(matched[3], 10),
    };
  }

  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });

  const parts = formatter.formatToParts(new Date());
  const lookup = Object.fromEntries(parts.map((part) => [part.type, part.value]));

  return {
    year: Number.parseInt(lookup.year, 10),
    month: Number.parseInt(lookup.month, 10),
    day: Number.parseInt(lookup.day, 10),
  };
}

function buildDateKey({ year, month, day }) {
  return year * 10000 + month * 100 + day;
}

function formatHumanDate({ day, month }, locale, timeZone, year) {
  return new Intl.DateTimeFormat(locale, {
    day: "numeric",
    month: "long",
    timeZone,
  }).format(new Date(Date.UTC(year, month - 1, day)));
}

function parseScheduleDate(name, todayParts) {
  const matched = /(^|\s)(\d{1,2})\s+([А-Яа-яЁё]+)/.exec(name);
  if (!matched) {
    return null;
  }

  const day = Number.parseInt(matched[2], 10);
  const month = MONTHS.get(matched[3].toLowerCase());
  if (!month) {
    return null;
  }

  return {
    year: todayParts.year,
    month,
    day,
  };
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      "user-agent": "telegram-schedule-bot/1.0",
    },
  });

  if (!response.ok) {
    throw new Error(`Request to ${url} failed with status ${response.status}.`);
  }

  return response.json();
}

async function listYandexFiles(publicUrl) {
  const collected = [];
  let offset = 0;
  let total = 1;

  while (offset < total) {
    const url = new URL(YANDEX_API_URL);
    url.searchParams.set("public_key", publicUrl);
    url.searchParams.set("limit", "100");
    url.searchParams.set("offset", String(offset));

    const payload = await fetchJson(url);
    const embedded = payload._embedded;
    if (!embedded || !Array.isArray(embedded.items)) {
      throw new Error("Yandex Disk response does not contain an item list.");
    }

    total = Number(embedded.total || embedded.items.length);
    offset += embedded.items.length;
    collected.push(...embedded.items);

    if (embedded.items.length === 0) {
      break;
    }
  }

  return collected.filter((item) => item.type === "file" && item.mime_type === "application/pdf");
}

function pickScheduleFiles(items, config, options) {
  const todayParts = getTodayParts(config.timeZone, options.todayIso);
  const todayKey = buildDateKey(todayParts);

  return items
    .map((item) => {
      const parsed = parseScheduleDate(item.name, todayParts);
      if (!parsed || !item.file) {
        return null;
      }

      return {
        ...item,
        scheduleDate: parsed,
        scheduleKey: buildDateKey(parsed),
      };
    })
    .filter(Boolean)
    .filter((item) => item.scheduleKey >= todayKey)
    .sort((left, right) => left.scheduleKey - right.scheduleKey || left.name.localeCompare(right.name, "ru"));
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

async function telegramRequest(token, method, payload) {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: {
      "content-type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(`Telegram ${method} failed with HTTP ${response.status}.`);
  }

  const body = await response.json();
  if (!body.ok) {
    throw new Error(`Telegram ${method} error: ${body.description || "unknown error"}`);
  }

  return body.result;
}

async function loadUpdates(token, offset) {
  const result = await telegramRequest(token, "getUpdates", {
    offset,
    limit: 100,
    timeout: 0,
    allowed_updates: ["message"],
  });

  return Array.isArray(result) ? result : [];
}

function buildKeyboard(buttonText) {
  return {
    keyboard: [[{ text: buttonText }]],
    resize_keyboard: true,
    selective: true,
  };
}

async function sendText(token, chatId, text, config, extra = {}) {
  return telegramRequest(token, "sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: config.telegramParseMode,
    ...extra,
  });
}

async function sendDocument(token, chatId, fileUrl, caption, config) {
  return telegramRequest(token, "sendDocument", {
    chat_id: chatId,
    document: fileUrl,
    caption,
    parse_mode: config.telegramParseMode,
  });
}

function parseAllowedChatIds() {
  const raw = process.env.TELEGRAM_ALLOWED_CHAT_IDS || "";

  return new Set(
    raw
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
}

function isAllowedChat(chatId, allowedChatIds) {
  if (allowedChatIds.size === 0) {
    return true;
  }

  return allowedChatIds.has(String(chatId));
}

function buildSummary(files, config) {
  const lines = files.map((file) => {
    const label = formatHumanDate(file.scheduleDate, config.locale, config.timeZone, file.scheduleDate.year);
    return `• ${escapeHtml(label)} — ${escapeHtml(file.name)}`;
  });

  return [
    `Нашёл ${files.length} файл(а) начиная с сегодняшней даты:`,
    ...lines,
  ].join("\n");
}

async function sendScheduleBundle(token, chatId, config, options, cachedFiles) {
  const files = cachedFiles.value ?? pickScheduleFiles(await listYandexFiles(config.yandexPublicUrl), config, options);
  cachedFiles.value = files;
  const todayParts = getTodayParts(config.timeZone, options.todayIso);
  const todayLabel = formatHumanDate(todayParts, config.locale, config.timeZone, todayParts.year);

  if (files.length === 0) {
    await sendText(
      token,
      chatId,
      `Начиная с <b>${escapeHtml(todayLabel)}</b> на Яндекс Диске пока нет PDF-файлов расписания.`,
      config,
    );
    return;
  }

  await sendText(token, chatId, buildSummary(files, config), config);

  for (const file of files) {
    const label = formatHumanDate(file.scheduleDate, config.locale, config.timeZone, file.scheduleDate.year);
    await sendDocument(
      token,
      chatId,
      file.file,
      `${escapeHtml(label)}\n${escapeHtml(file.name)}`,
      config,
    );
  }
}

async function processUpdates(token, config, options, state) {
  const updates = await loadUpdates(token, state.lastUpdateId || 0);
  const allowedChatIds = parseAllowedChatIds();
  const cachedFiles = { value: null };
  let lastUpdateId = state.lastUpdateId || 0;

  for (const update of updates) {
    lastUpdateId = Math.max(lastUpdateId, update.update_id + 1);

    const message = update.message;
    if (!message || typeof message.text !== "string") {
      continue;
    }

    const chatId = message.chat?.id;
    const text = message.text.trim();

    if (normalizeBotCommand(text, "start")) {
      await sendText(
        token,
        chatId,
        [
          `Привет. Я могу отправить PDF-файлы расписания с Яндекс Диска.`,
          `Нажми кнопку <b>${escapeHtml(config.buttonText)}</b> или отправь команду <code>/schedule</code>.`,
          `Команда <code>/whoami</code> покажет твой chat id.`,
        ].join("\n"),
        config,
        {
          reply_markup: buildKeyboard(config.buttonText),
        },
      );
      continue;
    }

    if (normalizeBotCommand(text, "whoami")) {
      await sendText(token, chatId, `Твой chat id: <code>${escapeHtml(chatId)}</code>`, config);
      continue;
    }

    const normalized = normalizeCommand(text);
    const wantsSchedule =
      normalized === normalizeCommand(config.buttonText) ||
      normalizeBotCommand(text, "schedule");

    if (!wantsSchedule) {
      continue;
    }

    if (!isAllowedChat(chatId, allowedChatIds)) {
      await sendText(
        token,
        chatId,
        `Этот бот настроен только для разрешённых chat id. Отправь <code>/whoami</code> и добавь свой id в secret <code>TELEGRAM_ALLOWED_CHAT_IDS</code>.`,
        config,
      );
      continue;
    }

    await sendScheduleBundle(token, chatId, config, options, cachedFiles);
  }

  return {
    lastUpdateId,
    updatedAt: new Date().toISOString(),
  };
}

async function saveState(state) {
  await mkdir(path.dirname(STATE_PATH), { recursive: true });
  await writeFile(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

async function runDryMode(config, options) {
  const files = pickScheduleFiles(await listYandexFiles(config.yandexPublicUrl), config, options);
  const todayParts = getTodayParts(config.timeZone, options.todayIso);
  const todayLabel = formatHumanDate(todayParts, config.locale, config.timeZone, todayParts.year);

  console.log(`Today: ${todayLabel}`);
  console.log(`Matched files: ${files.length}`);

  for (const file of files) {
    const label = formatHumanDate(file.scheduleDate, config.locale, config.timeZone, file.scheduleDate.year);
    console.log(`${label} -> ${file.name}`);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const config = await readJson(CONFIG_PATH, null);
  if (!config) {
    throw new Error(`Missing config file: ${CONFIG_PATH}`);
  }

  if (options.dryRun) {
    await runDryMode(config, options);
    return;
  }

  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    throw new Error("TELEGRAM_BOT_TOKEN is not set.");
  }

  const state = await readJson(STATE_PATH, { lastUpdateId: 0, updatedAt: null });
  const nextState = await processUpdates(token, config, options, state);
  await saveState(nextState);
  console.log(`Processed updates up to offset ${nextState.lastUpdateId}.`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
