import { connect } from "cloudflare:sockets";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const WEBSOCKET_OPEN = 1;
const COMMAND_TCP = 0x01;
const COMMAND_UDP = 0x02;
const ADDRESS_TYPE_IPV4 = 0x01;
const ADDRESS_TYPE_DOMAIN = 0x02;
const ADDRESS_TYPE_IPV6 = 0x03;
const DEFAULT_DOH_URL = "https://1.1.1.1/dns-query";
const DEFAULT_FALLBACK_URL = "https://www.cloudflare.com/";
const DEFAULT_NICKNAME = "CF-Workers-VPN";
const BLOCKED_HTTP_PORTS = new Set([80, 443]);
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[089ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const config = readConfig(env, url.hostname);
    const upgradeHeader = request.headers.get("Upgrade");

    if (upgradeHeader && upgradeHeader.toLowerCase() === "websocket") {
      if (url.pathname !== `/${config.wsPath}`) {
        return new Response("WebSocket path not found.", { status: 404 });
      }

      if (!config.ready) {
        return json(
          {
            ok: false,
            error: "Worker is not configured.",
            missing: config.missing,
          },
          500,
        );
      }

      return handleWebSocketSession(config, request);
    }

    if (url.pathname === "/") {
      return renderHome(config, url);
    }

    if (url.pathname === "/health") {
      return json(
        {
          ok: true,
          configured: config.ready,
          host: config.host,
          wsPath: config.wsPath ? `/${config.wsPath}` : null,
          missing: config.missing,
        },
        200,
      );
    }

    if (!config.ready) {
      return json(
        {
          ok: false,
          error: "Worker is not configured.",
          missing: config.missing,
        },
        500,
      );
    }

    if (url.pathname === `/sub/${config.subscriptionToken}`) {
      return handleSubscription(config, url);
    }

    if (url.pathname === `/config/${config.subscriptionToken}`) {
      return renderConfigPage(config, url);
    }

    if (url.pathname === `/client/${config.subscriptionToken}/sing-box.json`) {
      return renderSingBoxConfig(config, url);
    }

    if (config.fallbackUrl) {
      return Response.redirect(config.fallbackUrl, 302);
    }

    return new Response("Not found.", { status: 404 });
  },
};

function readConfig(env, host) {
  const uuid = sanitizeUuid(env.UUID);
  const wsPath = sanitizePathToken(env.WS_PATH);
  const subscriptionToken = sanitizePathToken(env.SUBSCRIPTION_TOKEN);
  const userNickname = sanitizeLabel(env.USER_NICKNAME) || DEFAULT_NICKNAME;
  const dnsOverHttpsUrl = sanitizeHttpUrl(env.DNS_OVER_HTTPS) || DEFAULT_DOH_URL;
  const fallbackUrl = sanitizeHttpUrl(env.FALLBACK_URL) || DEFAULT_FALLBACK_URL;

  const missing = [];

  if (!uuid) {
    missing.push("UUID");
  }

  if (!wsPath) {
    missing.push("WS_PATH");
  }

  if (!subscriptionToken) {
    missing.push("SUBSCRIPTION_TOKEN");
  }

  return {
    ready: missing.length === 0,
    missing,
    host,
    uuid,
    wsPath,
    subscriptionToken,
    userNickname,
    dnsOverHttpsUrl,
    fallbackUrl,
  };
}

function sanitizeUuid(value) {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  return UUID_PATTERN.test(normalized) ? normalized : null;
}

function sanitizePathToken(value) {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim().replace(/^\/+|\/+$/g, "");
  if (!normalized) {
    return null;
  }

  if (!/^[a-zA-Z0-9._~!$&'()*+,;=:@-]+$/.test(normalized)) {
    return null;
  }

  return normalized;
}

function sanitizeLabel(value) {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim();
  return normalized || null;
}

function sanitizeHttpUrl(value) {
  if (typeof value !== "string") {
    return null;
  }

  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      return null;
    }

    return url.toString();
  } catch {
    return null;
  }
}

function handleWebSocketSession(config, request) {
  const webSocketPair = new WebSocketPair();
  const client = webSocketPair[0];
  const server = webSocketPair[1];
  const webSocketProtocol = readWebSocketProtocolToken(
    request.headers.get("sec-websocket-protocol"),
  );
  const earlyData = webSocketProtocol ? decodeBase64Url(webSocketProtocol) : null;

  server.accept();
  startVlessSession(server, config, earlyData).catch((error) => {
    console.error("Failed to initialize VLESS session.", describeError(error));
    closeWebSocket(server, 1011, formatCloseReason(error, "Proxy session failed"));
  });

  const headers = webSocketProtocol
    ? {
        "sec-websocket-protocol": webSocketProtocol,
      }
    : undefined;

  return new Response(null, {
    status: 101,
    headers,
    webSocket: client,
  });
}

async function startVlessSession(webSocket, config, initialChunk = null) {
  let remoteSocket = null;
  let remoteWriter = null;
  let closed = false;
  let ready = false;
  let mode = "init";
  let writeChain = Promise.resolve();

  const closeSession = async (code = 1000, reason = "Closed") => {
    if (closed) {
      return;
    }

    closed = true;

    try {
      if (remoteWriter) {
        await remoteWriter.close();
      }
    } catch {
      // Ignore close races from half-open sockets.
    }

    try {
      if (remoteSocket) {
        await remoteSocket.close();
      }
    } catch {
      // Ignore repeated socket closes.
    }

    closeWebSocket(webSocket, code, reason);
  };

  webSocket.addEventListener("close", () => {
    void closeSession(1000, "Client closed");
  });

  webSocket.addEventListener("error", () => {
    void closeSession(1011, "WebSocket error");
  });

  const queueChunk = (chunk) => {
    if (!chunk || closed) {
      return;
    }

    writeChain = writeChain
      .then(async () => {
        if (!ready) {
          const parsed = parseVlessRequest(chunk, config.uuid);
          if (parsed.command === COMMAND_TCP) {
            if (BLOCKED_HTTP_PORTS.has(parsed.port)) {
              throw new Error(
                "Cloudflare Workers block proxying web traffic to ports 80/443, so this cannot work as a normal web VPN.",
              );
            }

            remoteSocket = connect(
              { hostname: parsed.address, port: parsed.port },
              { allowHalfOpen: true },
            );
            await remoteSocket.opened;
            remoteWriter = remoteSocket.writable.getWriter();

            if (parsed.payload.length > 0) {
              await remoteWriter.write(parsed.payload);
            }

            ready = true;
            mode = "tcp";

            webSocket.send(new Uint8Array([parsed.version, 0]));
            void pipeSocketToWebSocket(remoteSocket, webSocket, closeSession);
            return;
          }

          if (parsed.command === COMMAND_UDP) {
            if (parsed.port !== 53) {
              throw new Error("Only UDP DNS on port 53 is supported.");
            }

            ready = true;
            mode = "udp";
            webSocket.send(new Uint8Array([parsed.version, 0]));

            if (parsed.payload.length > 0) {
              await handleUdpDnsFrames(parsed.payload, webSocket, config.dnsOverHttpsUrl);
            }
            return;
          }

          throw new Error("Unsupported VLESS command.");
        }

        if (mode === "tcp") {
          await remoteWriter.write(chunk);
          return;
        }

        if (mode === "udp") {
          await handleUdpDnsFrames(chunk, webSocket, config.dnsOverHttpsUrl);
          return;
        }

        throw new Error("Invalid session mode.");
      })
      .catch(async (error) => {
        console.error("VLESS session failed.", describeError(error), {
          mode,
          ready,
        });
        await closeSession(1011, formatCloseReason(error, "Proxy session failed"));
      });
  };

  webSocket.addEventListener("message", (event) => {
    const chunk = normalizeIncomingChunk(event.data);
    queueChunk(chunk);
  });

  if (initialChunk && initialChunk.length > 0) {
    queueChunk(initialChunk);
  }
}

async function pipeSocketToWebSocket(socket, webSocket, closeSession) {
  const reader = socket.readable.getReader();

  try {
    while (webSocket.readyState === WEBSOCKET_OPEN) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }

      if (!(value instanceof Uint8Array) || value.length === 0) {
        continue;
      }

      webSocket.send(value);
    }
  } catch {
    await closeSession(1011, "Remote socket read failed");
    return;
  } finally {
    reader.releaseLock();
  }

  await closeSession(1000, "Remote socket closed");
}

async function handleUdpDnsFrames(chunk, webSocket, dnsOverHttpsUrl) {
  let offset = 0;

  while (offset + 2 <= chunk.length) {
    const packetLength = (chunk[offset] << 8) | chunk[offset + 1];
    offset += 2;

    if (packetLength === 0 || offset + packetLength > chunk.length) {
      throw new Error("Invalid UDP packet frame.");
    }

    const query = chunk.slice(offset, offset + packetLength);
    offset += packetLength;

    const response = await relayDnsQuery(query, dnsOverHttpsUrl);
    const framedResponse = new Uint8Array(response.length + 2);
    framedResponse[0] = (response.length >> 8) & 0xff;
    framedResponse[1] = response.length & 0xff;
    framedResponse.set(response, 2);
    webSocket.send(framedResponse);
  }

  if (offset !== chunk.length) {
    throw new Error("Trailing UDP bytes detected.");
  }
}

async function relayDnsQuery(packet, dnsOverHttpsUrl) {
  const response = await fetch(dnsOverHttpsUrl, {
    method: "POST",
    headers: {
      "content-type": "application/dns-message",
      accept: "application/dns-message",
    },
    body: packet,
  });

  if (!response.ok) {
    throw new Error(`DNS-over-HTTPS upstream failed with ${response.status}.`);
  }

  const buffer = await response.arrayBuffer();
  return new Uint8Array(buffer);
}

function parseVlessRequest(chunk, expectedUuid) {
  if (!(chunk instanceof Uint8Array)) {
    throw new Error("Invalid client data.");
  }

  if (chunk.length < 24) {
    throw new Error("VLESS header is too short.");
  }

  const version = chunk[0];
  const userId = chunk.slice(1, 17);
  const clientUuid = uuidBytesToString(userId);

  if (clientUuid !== expectedUuid) {
    throw new Error("UUID mismatch.");
  }

  const optionsLength = chunk[17];
  const commandIndex = 18 + optionsLength;
  if (chunk.length < commandIndex + 4) {
    throw new Error("Incomplete VLESS command section.");
  }

  const command = chunk[commandIndex];
  const port = (chunk[commandIndex + 1] << 8) | chunk[commandIndex + 2];
  const addressType = chunk[commandIndex + 3];
  const addressIndex = commandIndex + 4;

  const { address, nextIndex } = readAddress(chunk, addressType, addressIndex);
  const payload = chunk.slice(nextIndex);

  if (!address) {
    throw new Error("Destination address is empty.");
  }

  if (port < 1 || port > 65535) {
    throw new Error("Destination port is invalid.");
  }

  return {
    version,
    command,
    port,
    address,
    payload,
  };
}

function readAddress(chunk, addressType, startIndex) {
  if (addressType === ADDRESS_TYPE_IPV4) {
    if (chunk.length < startIndex + 4) {
      throw new Error("IPv4 address is incomplete.");
    }

    const octets = Array.from(chunk.slice(startIndex, startIndex + 4));
    return {
      address: octets.join("."),
      nextIndex: startIndex + 4,
    };
  }

  if (addressType === ADDRESS_TYPE_DOMAIN) {
    if (chunk.length < startIndex + 1) {
      throw new Error("Domain length is missing.");
    }

    const length = chunk[startIndex];
    const domainStart = startIndex + 1;
    const domainEnd = domainStart + length;

    if (chunk.length < domainEnd) {
      throw new Error("Domain name is incomplete.");
    }

    return {
      address: textDecoder.decode(chunk.slice(domainStart, domainEnd)),
      nextIndex: domainEnd,
    };
  }

  if (addressType === ADDRESS_TYPE_IPV6) {
    if (chunk.length < startIndex + 16) {
      throw new Error("IPv6 address is incomplete.");
    }

    const bytes = chunk.slice(startIndex, startIndex + 16);
    const segments = [];
    for (let index = 0; index < 16; index += 2) {
      segments.push(bytes[index].toString(16).padStart(2, "0") + bytes[index + 1].toString(16).padStart(2, "0"));
    }

    return {
      address: segments.join(":"),
      nextIndex: startIndex + 16,
    };
  }

  throw new Error("Unsupported address type.");
}

function uuidBytesToString(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length !== 16) {
    throw new Error("Invalid UUID bytes.");
  }

  const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
}

function normalizeIncomingChunk(data) {
  if (data instanceof Uint8Array) {
    return data;
  }

  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }

  if (typeof data === "string") {
    return textEncoder.encode(data);
  }

  if (data && data.buffer instanceof ArrayBuffer) {
    return new Uint8Array(data.buffer, data.byteOffset || 0, data.byteLength || data.length || 0);
  }

  return null;
}

function readWebSocketProtocolToken(value) {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value
    .split(",")
    .map((entry) => entry.trim())
    .find(Boolean);

  if (!normalized) {
    return null;
  }

  return normalized;
}

function decodeBase64Url(value) {
  try {
    const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
    const paddingLength = (4 - (normalized.length % 4 || 4)) % 4;
    const padded = normalized + "=".repeat(paddingLength);
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);

    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }

    return bytes;
  } catch {
    return null;
  }
}

function describeError(error) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }

  return {
    message: String(error),
  };
}

function formatCloseReason(error, fallback) {
  const message =
    error instanceof Error && error.message
      ? error.message
      : typeof error === "string"
        ? error
        : fallback;

  return message.replace(/[\r\n]+/g, " ").trim().slice(0, 123) || fallback;
}

function handleSubscription(config, url) {
  const subscription = buildVlessUri(config, url.hostname);
  const format = url.searchParams.get("format");

  if (format === "base64") {
    return new Response(encodeBase64(subscription), {
      status: 200,
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store",
      },
    });
  }

  return new Response(subscription, {
    status: 200,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function renderSingBoxConfig(config, url) {
  const host = url.hostname;
  const dnsServerUrl = new URL(config.dnsOverHttpsUrl);
  const dnsServerType = dnsServerUrl.protocol === "https:" ? "https" : "http";
  const dnsServerPort = dnsServerUrl.port
    ? Number(dnsServerUrl.port)
    : dnsServerUrl.protocol === "https:"
      ? 443
      : 80;

  const outbound = {
    type: "vless",
    tag: "proxy",
    server: host,
    server_port: 443,
    uuid: config.uuid,
    network: "tcp",
    tls: {
      enabled: true,
      server_name: host,
    },
    transport: {
      type: "ws",
      path: `/${config.wsPath}`,
      headers: {
        Host: host,
      },
    },
  };

  const body = {
    log: {
      level: "warn",
    },
    dns: {
      servers: [
        {
          type: dnsServerType,
          tag: "remote-doh",
          server: dnsServerUrl.hostname,
          server_port: dnsServerPort,
          path: `${dnsServerUrl.pathname}${dnsServerUrl.search}`,
          detour: "proxy",
          tls:
            dnsServerType === "https"
              ? {
                  enabled: true,
                  server_name: dnsServerUrl.hostname,
                }
              : undefined,
        },
        {
          type: "local",
          tag: "local",
        },
      ],
      final: "remote-doh",
    },
    inbounds: [
      {
        type: "tun",
        tag: "tun-in",
        interface_name: "singbox-tun",
        address: ["172.19.0.1/30", "fdfe:dcba:9876::1/126"],
        auto_route: true,
        strict_route: true,
        sniff: true,
      },
    ],
    outbounds: [
      outbound,
      {
        type: "direct",
        tag: "direct",
      },
      {
        type: "block",
        tag: "block",
      },
    ],
    route: {
      auto_detect_interface: true,
      final: "proxy",
    },
  };

  return new Response(JSON.stringify(body, null, 2), {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function renderHome(config, url) {
  const title = "Cloudflare Workers VPN";
  const subtitle = config.ready
    ? "Worker is deployed, but Cloudflare blocks normal web proxying to ports 80 and 443."
    : "Worker code is deployed, but secrets are still missing.";

  const details = config.ready
    ? `
      <li>WebSocket path: <code>/${escapeHtml(config.wsPath)}</code></li>
      <li>Subscription page: <code>/config/&lt;SUBSCRIPTION_TOKEN&gt;</code></li>
      <li>Health check: <code>/health</code></li>
      <li>Important: this Worker cannot browse normal websites because Cloudflare blocks outbound TCP proxying to ports <code>80</code> and <code>443</code>.</li>
    `
    : `<li>Missing secrets: <code>${escapeHtml(config.missing.join(", "))}</code></li>`;

  const body = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title}</title>
    <style>
      :root {
        color-scheme: dark;
        --bg: #09111b;
        --panel: rgba(13, 27, 42, 0.88);
        --line: rgba(120, 186, 255, 0.28);
        --text: #f4f8ff;
        --muted: #b7c6dc;
        --accent: #69c7ff;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        background:
          radial-gradient(circle at top, rgba(77, 151, 255, 0.22), transparent 34%),
          linear-gradient(135deg, #050b12 0%, #09111b 38%, #0f2031 100%);
        color: var(--text);
        font-family: "Segoe UI", system-ui, sans-serif;
        padding: 24px;
      }
      .card {
        width: min(760px, 100%);
        background: var(--panel);
        border: 1px solid var(--line);
        border-radius: 24px;
        padding: 28px;
        box-shadow: 0 20px 80px rgba(0, 0, 0, 0.35);
        backdrop-filter: blur(18px);
      }
      h1 {
        margin: 0 0 10px;
        font-size: clamp(32px, 4vw, 46px);
      }
      p, li {
        color: var(--muted);
        line-height: 1.65;
        font-size: 16px;
      }
      ul {
        padding-left: 20px;
      }
      code {
        color: var(--accent);
        font-family: Consolas, "Courier New", monospace;
      }
      .pill {
        display: inline-flex;
        border: 1px solid var(--line);
        border-radius: 999px;
        padding: 8px 14px;
        color: var(--accent);
        margin-bottom: 18px;
      }
      .footer {
        margin-top: 22px;
        font-size: 14px;
      }
      a { color: var(--accent); }
    </style>
  </head>
  <body>
    <article class="card">
      <div class="pill">${config.ready ? "READY" : "SETUP REQUIRED"}</div>
      <h1>${title}</h1>
      <p>${subtitle}</p>
      <ul>${details}</ul>
      <p class="footer">
        Host: <code>${escapeHtml(url.hostname)}</code><br />
        This project uses VLESS over WebSocket on Cloudflare Workers rather than a real WireGuard/OpenVPN tunnel.
      </p>
    </article>
  </body>
</html>`;

  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function renderConfigPage(config, url) {
  const host = url.hostname;
  const subscriptionLink = `${url.origin}/sub/${config.subscriptionToken}`;
  const base64SubscriptionLink = `${subscriptionLink}?format=base64`;
  const singBoxLink = `${url.origin}/client/${config.subscriptionToken}/sing-box.json`;
  const vlessUri = buildVlessUri(config, host);

  const body = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Client Config</title>
    <style>
      :root {
        --bg: #fff7ed;
        --panel: #fffdf8;
        --text: #241100;
        --muted: #735437;
        --accent: #cc6a16;
        --line: rgba(204, 106, 22, 0.18);
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        background:
          radial-gradient(circle at top left, rgba(255, 186, 105, 0.35), transparent 28%),
          linear-gradient(180deg, #ffe8cc 0%, #fff7ed 38%, #fffdf8 100%);
        color: var(--text);
        font-family: "Segoe UI", system-ui, sans-serif;
        padding: 24px;
      }
      .wrap {
        width: min(920px, 100%);
        margin: 0 auto;
      }
      .panel {
        background: rgba(255, 253, 248, 0.9);
        border: 1px solid var(--line);
        border-radius: 24px;
        padding: 28px;
        box-shadow: 0 24px 80px rgba(102, 54, 8, 0.12);
        margin-bottom: 18px;
      }
      h1, h2 {
        margin-top: 0;
      }
      p, li {
        color: var(--muted);
        line-height: 1.7;
      }
      a { color: var(--accent); }
      code, pre {
        font-family: Consolas, "Courier New", monospace;
      }
      pre {
        white-space: pre-wrap;
        word-break: break-word;
        background: #2a1806;
        color: #fff6ea;
        padding: 18px;
        border-radius: 18px;
        overflow: auto;
      }
      ul {
        padding-left: 20px;
      }
    </style>
  </head>
  <body>
    <main class="wrap">
      <section class="panel">
        <h1>Client Config</h1>
        <p>Use the URI below only for experiments with non-web TCP protocols. Cloudflare Workers cannot proxy ordinary web browsing on ports 80 and 443.</p>
        <pre>${escapeHtml(vlessUri)}</pre>
      </section>
      <section class="panel">
        <h2>Quick Links</h2>
        <ul>
          <li>Plain subscription: <a href="${escapeHtml(subscriptionLink)}">${escapeHtml(subscriptionLink)}</a></li>
          <li>Base64 subscription: <a href="${escapeHtml(base64SubscriptionLink)}">${escapeHtml(base64SubscriptionLink)}</a></li>
          <li>sing-box config: <a href="${escapeHtml(singBoxLink)}">${escapeHtml(singBoxLink)}</a></li>
        </ul>
      </section>
      <section class="panel">
        <h2>Important Limits</h2>
        <ul>
          <li>This is a proxy-based setup, not a full L3 VPN tunnel.</li>
          <li>Cloudflare Workers block outbound TCP proxying to ports 80 and 443, so regular website browsing will fail.</li>
          <li>Generic UDP is not supported. Only DNS over HTTPS is relayed for UDP port 53.</li>
          <li>Cloudflare Workers block outbound TCP to Cloudflare IP ranges, so some Cloudflare-hosted destinations may fail.</li>
        </ul>
      </section>
    </main>
  </body>
</html>`;

  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function buildVlessUri(config, host) {
  const params = new URLSearchParams({
    encryption: "none",
    security: "tls",
    sni: host,
    type: "ws",
    host,
    path: `/${config.wsPath}`,
  });

  return `vless://${config.uuid}@${host}:443?${params.toString()}#${encodeURIComponent(config.userNickname)}`;
}

function encodeBase64(value) {
  const bytes = textEncoder.encode(value);
  let binary = "";

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary);
}

function closeWebSocket(webSocket, code, reason) {
  if (webSocket.readyState === WEBSOCKET_OPEN) {
    try {
      webSocket.close(code, reason.slice(0, 123));
    } catch {
      // Ignore duplicate websocket closes.
    }
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function json(payload, status) {
  return new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}
