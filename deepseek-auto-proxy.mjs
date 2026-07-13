import http from "node:http";
import https from "node:https";

const LISTEN_HOST = "127.0.0.1";
const LISTEN_PORT = Number(process.env.DS_PROXY_PORT ?? 8787);

const UPSTREAM_HOST = "api.deepseek.com";
const UPSTREAM_PREFIX = "/anthropic";

// 关闭 keep-alive，避免复用已被服务端关闭的连接导致 TLS 握手失败。
const upstreamAgent = new https.Agent({ keepAlive: false });

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function isSecurityClassifier(body) {
  if (!body || typeof body !== "object") {
    return false;
  }

  const noTools =
    !Array.isArray(body.tools) ||
    body.tools.length === 0;

  // The classifier carries exactly one system message and no tools.
  // Normal conversation messages have hundreds of messages + tools.
  const msgCount = Array.isArray(body.messages)
    ? body.messages.length
    : 0;

  // stream may be undefined (absent), false, or true.
  // Classifier is never streaming.
  if (body.stream !== true && noTools && msgCount === 1) {
    return true;
  }

  return false;
}

function copyRequestHeaders(headers, bodyLength) {
  const result = {};

  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();

    if (
      lower === "host" ||
      lower === "content-length" ||
      HOP_BY_HOP.has(lower)
    ) {
      continue;
    }

    if (value !== undefined) {
      result[name] = value;
    }
  }

  result["content-length"] = String(bodyLength);
  return result;
}

function copyResponseHeaders(headers) {
  const result = {};

  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();

    if (HOP_BY_HOP.has(lower)) {
      continue;
    }

    if (value !== undefined) {
      result[name] = value;
    }
  }

  return result;
}

const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
    });

    res.end(JSON.stringify({ ok: true }));
    return;
  }

  const chunks = [];

  req.on("data", (chunk) => {
    chunks.push(chunk);
  });

  req.on("end", () => {
    let bodyBuffer = Buffer.concat(chunks);
    let patched = false;

    const contentType = String(
      req.headers["content-type"] ?? "",
    );

    if (
      bodyBuffer.length > 0 &&
      contentType.includes("application/json")
    ) {
      try {
        const body = JSON.parse(
          bodyBuffer.toString("utf8"),
        );

        if (isSecurityClassifier(body)) {
          body.thinking = {
            type: "disabled",
          };

          // delete legacy params
          delete body.reasoning_effort;
          delete body.output_config;

          bodyBuffer = Buffer.from(
            JSON.stringify(body),
            "utf8",
          );

          patched = true;
        }
      } catch {
        // keep original request on parse failure
      }
    }

    const upstreamPath =
      `${UPSTREAM_PREFIX}${req.url ?? "/"}`;

    let retried = false;

    function sendUpstream() {
      const upstreamReq = https.request(
        {
          hostname: UPSTREAM_HOST,
          port: 443,
          method: req.method,
          path: upstreamPath,
          headers: copyRequestHeaders(
            req.headers,
            bodyBuffer.length,
          ),
          agent: upstreamAgent,
        },
        (upstreamRes) => {
          const status =
            upstreamRes.statusCode ?? 502;

          console.log(
            `${new Date().toISOString()} ` +
            `${req.method} ${req.url} ` +
            `${patched
              ? "[classifier patched]"
              : "[pass]"} -> ${status}`,
          );

          res.writeHead(
            status,
            copyResponseHeaders(
              upstreamRes.headers,
            ),
          );

          upstreamRes.pipe(res);
        },
      );

      upstreamReq.on("error", (error) => {
        console.error(
          "Upstream error:",
          `[${error.code ?? "no_code"}]`,
          error.message || "(no message)",
        );

        // TLS/连接级别的瞬时错误，重试一次。
        if (
          !retried &&
          (error.code === "ECONNRESET" ||
           error.code === "ETIMEDOUT" ||
           error.code === "EPIPE" ||
           !error.message ||
           /disconnected before secure TLS/.test(
             error.message ?? "",
           ))
        ) {
          retried = true;
          console.log(`  ↳ retrying...`);
          sendUpstream();
          return;
        }

        if (!res.headersSent) {
          res.writeHead(502, {
            "content-type":
              "application/json; charset=utf-8",
          });
        }

        res.end(
          JSON.stringify({
            error: "upstream_error",
            message: error.message,
          }),
        );
      });

      if (bodyBuffer.length > 0) {
        upstreamReq.write(bodyBuffer);
      }

      upstreamReq.end();
    }

    sendUpstream();
  });

  req.on("error", (error) => {
    console.error(
      "Client request error:",
      error.message,
    );

    if (!res.headersSent) {
      res.writeHead(400);
    }

    res.end();
  });
});

server.listen(
  LISTEN_PORT,
  LISTEN_HOST,
  () => {
    console.log(
      `DeepSeek Auto Mode proxy: ` +
      `http://${LISTEN_HOST}:${LISTEN_PORT}`,
    );

    console.log(
      "Upstream: " +
      "https://api.deepseek.com/anthropic",
    );
  },
);
