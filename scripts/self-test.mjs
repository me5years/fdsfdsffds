const DEFAULTS = {
  workerHost: "cf-vpn-ft6yok.5yearsme5.workers.dev",
  wsPath: "8ie27gsoxrktad",
  uuid: "116a2ae6-ec7c-48de-8167-6df2cff1b712",
  targetHost: "example.com",
  targetPort: 443,
  timeoutMs: 15000,
};

delete process.env.HTTP_PROXY;
delete process.env.HTTPS_PROXY;
delete process.env.ALL_PROXY;
delete process.env.NO_PROXY;
delete process.env.http_proxy;
delete process.env.https_proxy;
delete process.env.all_proxy;
delete process.env.no_proxy;

const encoder = new TextEncoder();

function parseArgs(argv) {
  const config = { ...DEFAULTS };

  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];

    if (!key.startsWith("--") || value == null) {
      continue;
    }

    if (key === "--worker-host") {
      config.workerHost = value;
      index += 1;
      continue;
    }

    if (key === "--ws-path") {
      config.wsPath = value.replace(/^\/+/, "");
      index += 1;
      continue;
    }

    if (key === "--uuid") {
      config.uuid = value;
      index += 1;
      continue;
    }

    if (key === "--target-host") {
      config.targetHost = value;
      index += 1;
      continue;
    }

    if (key === "--target-port") {
      config.targetPort = Number.parseInt(value, 10);
      index += 1;
      continue;
    }

    if (key === "--timeout-ms") {
      config.timeoutMs = Number.parseInt(value, 10);
      index += 1;
    }
  }

  return config;
}

function uuidToBytes(value) {
  const hex = value.replace(/-/g, "");

  if (!/^[0-9a-fA-F]{32}$/.test(hex)) {
    throw new Error(`Invalid UUID: ${value}`);
  }

  const bytes = new Uint8Array(16);
  for (let index = 0; index < 16; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }

  return bytes;
}

function concatArrays(parts) {
  const totalLength = parts.reduce((sum, part) => sum + part.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;

  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }

  return result;
}

function buildVlessRequest({ uuid, targetHost, targetPort }) {
  const hostBytes = encoder.encode(targetHost);

  return concatArrays([
    Uint8Array.of(0),
    uuidToBytes(uuid),
    Uint8Array.of(0),
    Uint8Array.of(1),
    Uint8Array.of((targetPort >> 8) & 0xff, targetPort & 0xff),
    Uint8Array.of(2),
    Uint8Array.of(hostBytes.length),
    hostBytes,
  ]);
}

async function main() {
  const config = parseArgs(process.argv.slice(2));
  const request = buildVlessRequest(config);
  const url = `wss://${config.workerHost}/${config.wsPath}`;

  console.log(`Testing ${url} -> ${config.targetHost}:${config.targetPort}`);

  const outcome = await new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let acknowledged = false;

    const timeout = setTimeout(() => {
      try {
        ws.close();
      } catch {
        // Ignore duplicate closes during timeout handling.
      }

      reject(new Error(`Timed out after ${config.timeoutMs}ms.`));
    }, config.timeoutMs);

    const finish = (callback) => {
      clearTimeout(timeout);
      callback();
    };

    ws.binaryType = "arraybuffer";

    ws.addEventListener("open", () => {
      ws.send(request);
    });

    ws.addEventListener("message", (event) => {
      if (acknowledged) {
        return;
      }

      acknowledged = true;
      const chunk = event.data instanceof ArrayBuffer ? new Uint8Array(event.data) : new Uint8Array();

      finish(() => {
        resolve({
          ok: true,
          ack: Array.from(chunk),
        });
      });

      try {
        ws.close();
      } catch {
        // Ignore close races.
      }
    });

    ws.addEventListener("close", (event) => {
      if (acknowledged) {
        return;
      }

      finish(() => {
        reject(
          new Error(
            `Worker rejected the TCP proxy request with close code ${event.code}: ${event.reason || "no reason"}`,
          ),
        );
      });
    });

    ws.addEventListener("error", () => {
      finish(() => {
        reject(new Error("WebSocket connection to the Worker failed."));
      });
    });
  });

  console.log("Worker accepted the initial VLESS request.");
  console.log(`ACK bytes: ${outcome.ack.join(",")}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
