import { mkdir, readFile, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const CONFIG_PATH = path.join(ROOT_DIR, "blocklist.config.json");
const OUTPUT_DIR = path.join(ROOT_DIR, "generated");
const OUTPUT_TXT_PATH = path.join(OUTPUT_DIR, "proxy-blocklist.txt");
const OUTPUT_JSON_PATH = path.join(OUTPUT_DIR, "proxy-blocklist.json");

const SOURCES = [
  {
    name: "aws",
    type: "aws-ip-ranges",
    url: "https://ip-ranges.amazonaws.com/ip-ranges.json",
  },
  {
    name: "google-cloud",
    type: "google-cloud",
    url: "https://www.gstatic.com/ipranges/cloud.json",
  },
  {
    name: "tor-exit-nodes",
    type: "line-ip-list",
    url: "https://check.torproject.org/torbulkexitlist",
  },
];

function normalizeIpEntry(value) {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  if (trimmed.includes("/")) {
    return trimmed;
  }

  const ipVersion = isIP(trimmed);
  if (ipVersion === 4) {
    return `${trimmed}/32`;
  }

  if (ipVersion === 6) {
    return `${trimmed}/128`;
  }

  return null;
}

async function fetchText(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);

  try {
    const response = await fetch(url, {
      headers: {
        "user-agent": "proxy-blocklist-builder/1.0",
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`Request failed with status ${response.status}.`);
    }

    return await response.text();
  } finally {
    clearTimeout(timeout);
  }
}

async function readConfig() {
  try {
    const raw = await readFile(CONFIG_PATH, "utf8");
    const parsed = JSON.parse(raw);
    const customCidrs = Array.isArray(parsed.customCidrs)
      ? parsed.customCidrs.map(normalizeIpEntry).filter(Boolean)
      : [];
    const customNotes = Array.isArray(parsed.customNotes)
      ? parsed.customNotes.map((value) => String(value))
      : [];

    return {
      customCidrs,
      customNotes,
    };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return {
        customCidrs: [],
        customNotes: [],
      };
    }

    throw error;
  }
}

function parseAwsIpRanges(raw) {
  const parsed = JSON.parse(raw);
  const cidrs = [];

  for (const entry of parsed.prefixes || []) {
    if (entry.ipv4_prefix) {
      cidrs.push(entry.ipv4_prefix);
    }
  }

  for (const entry of parsed.ipv6_prefixes || []) {
    if (entry.ipv6_prefix) {
      cidrs.push(entry.ipv6_prefix);
    }
  }

  return cidrs;
}

function parseGoogleCloudRanges(raw) {
  const parsed = JSON.parse(raw);
  const cidrs = [];

  for (const entry of parsed.prefixes || []) {
    if (entry.ipv4Prefix) {
      cidrs.push(entry.ipv4Prefix);
    }

    if (entry.ipv6Prefix) {
      cidrs.push(entry.ipv6Prefix);
    }
  }

  return cidrs;
}

function parseLineIpList(raw) {
  return raw
    .split(/\r?\n/g)
    .map(normalizeIpEntry)
    .filter(Boolean);
}

function parseSource(source, raw) {
  if (source.type === "aws-ip-ranges") {
    return parseAwsIpRanges(raw);
  }

  if (source.type === "google-cloud") {
    return parseGoogleCloudRanges(raw);
  }

  if (source.type === "line-ip-list") {
    return parseLineIpList(raw);
  }

  throw new Error(`Unsupported source type: ${source.type}`);
}

async function build() {
  const config = await readConfig();
  const bySource = [];
  const allCidrs = new Set(config.customCidrs);

  for (const source of SOURCES) {
    const raw = await fetchText(source.url);
    const cidrs = parseSource(source, raw);

    for (const cidr of cidrs) {
      allCidrs.add(cidr);
    }

    bySource.push({
      name: source.name,
      url: source.url,
      count: cidrs.length,
    });
  }

  const orderedCidrs = Array.from(allCidrs).sort((left, right) => left.localeCompare(right));
  const payload = {
    generatedAt: new Date().toISOString(),
    totalCount: orderedCidrs.length,
    sources: bySource,
    customCidrs: config.customCidrs.length,
    customNotes: config.customNotes,
    outputFile: path.relative(ROOT_DIR, OUTPUT_TXT_PATH),
  };

  await mkdir(OUTPUT_DIR, { recursive: true });
  await writeFile(OUTPUT_TXT_PATH, `${orderedCidrs.join("\n")}\n`, "utf8");
  await writeFile(OUTPUT_JSON_PATH, `${JSON.stringify(payload, null, 2)}\n`, "utf8");

  console.log(`Saved ${orderedCidrs.length} CIDRs/IPs to ${OUTPUT_TXT_PATH}`);
  for (const source of bySource) {
    console.log(`${source.name}: ${source.count}`);
  }
  if (config.customCidrs.length > 0) {
    console.log(`custom: ${config.customCidrs.length}`);
  }
}

build().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
