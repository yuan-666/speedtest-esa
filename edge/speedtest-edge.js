const STATIC_ASSETS =
  typeof globalThis !== "undefined" && globalThis.__SPEEDTEST_STATIC_ASSETS__
    ? globalThis.__SPEEDTEST_STATIC_ASSETS__
    : {};

const BUILD_CONFIG =
  typeof globalThis !== "undefined" && globalThis.__SPEEDTEST_BUILD_CONFIG__
    ? globalThis.__SPEEDTEST_BUILD_CONFIG__
    : {};

const DEFAULT_CONFIG = {
  serviceName: "ESA Edge Speed",
  allowedOrigins: ["*"],
  accessTokens: [],
  allowQueryToken: false,
  defaultSingleBytes: 64 * 1024 * 1024,
  maxDownloadBytes: 512 * 1024 * 1024,
  maxFlowBytes: 1024 * 1024 * 1024,
  maxUploadBytes: 64 * 1024 * 1024,
  minBytes: 64 * 1024,
  chunkBytes: 256 * 1024,
  defaultFlowSeconds: 12,
  maxParallel: 8,
  uploadReadTimeoutMs: 30 * 1000,
  staticMaxAge: 31536000
};

const CONFIG = normalizeConfig({
  ...DEFAULT_CONFIG,
  ...BUILD_CONFIG
});

const CHUNK_CACHE = new Map();

if (typeof addEventListener === "function") {
  addEventListener("fetch", (event) => {
    event.respondWith(handleRequest(event.request));
  });
}

if (typeof globalThis !== "undefined") {
  globalThis.speedtestEdge = { handleRequest, CONFIG };
}

async function handleRequest(request) {
  const url = new URL(request.url);

  if (request.method === "OPTIONS") {
    return handleOptions(request);
  }

  if (url.pathname.startsWith("/api/")) {
    return handleApi(request, url);
  }

  if (request.method !== "GET" && request.method !== "HEAD") {
    return textResponse("Method Not Allowed", 405, request, {
      Allow: "GET, HEAD, OPTIONS"
    });
  }

  return serveStatic(request, url);
}

async function handleApi(request, url) {
  if (!isOriginAllowed(request)) {
    return jsonResponse({ error: "origin_not_allowed" }, 403, request);
  }

  const pathname = url.pathname;
  const publicPaths = new Set(["/api/config", "/api/health"]);
  if (!publicPaths.has(pathname) && !isAuthorized(request, url)) {
    return jsonResponse({ error: "unauthorized" }, 401, request, {
      "WWW-Authenticate": 'SpeedtestToken realm="esa-edge-speed"'
    });
  }

  if (pathname === "/api/config" && request.method === "GET") {
    return jsonResponse(publicConfig(request), 200, request);
  }

  if (pathname === "/api/health" && request.method === "GET") {
    return jsonResponse(
      {
        ok: true,
        serviceName: CONFIG.serviceName,
        serverTime: new Date().toISOString(),
        edge: detectEdge(request)
      },
      200,
      request
    );
  }

  if (pathname === "/api/ping" && (request.method === "GET" || request.method === "HEAD")) {
    return pingResponse(request);
  }

  if (pathname === "/api/download" && (request.method === "GET" || request.method === "HEAD")) {
    const bytes = readSize(url, CONFIG.defaultSingleBytes, CONFIG.maxDownloadBytes);
    return binaryResponse(request, bytes, "download");
  }

  if (pathname === "/api/flow" && (request.method === "GET" || request.method === "HEAD")) {
    const bytes = readSize(url, CONFIG.maxFlowBytes, CONFIG.maxFlowBytes);
    return binaryResponse(request, bytes, "flow");
  }

  if (pathname === "/api/upload" && request.method === "POST") {
    return handleUpload(request);
  }

  return jsonResponse({ error: "not_found" }, 404, request);
}

function handleOptions(request) {
  if (!isOriginAllowed(request)) {
    return new Response(null, {
      status: 403,
      headers: apiHeaders(request)
    });
  }

  return new Response(null, {
    status: 204,
    headers: apiHeaders(request, {
      "Access-Control-Max-Age": "86400"
    })
  });
}

function publicConfig(request) {
  return {
    serviceName: CONFIG.serviceName,
    defaultSingleBytes: CONFIG.defaultSingleBytes,
    maxDownloadBytes: CONFIG.maxDownloadBytes,
    maxFlowBytes: CONFIG.maxFlowBytes,
    maxUploadBytes: CONFIG.maxUploadBytes,
    minBytes: CONFIG.minBytes,
    chunkBytes: CONFIG.chunkBytes,
    defaultFlowSeconds: CONFIG.defaultFlowSeconds,
    maxParallel: CONFIG.maxParallel,
    authRequired: CONFIG.accessTokens.length > 0,
    edge: detectEdge(request)
  };
}

function pingResponse(request) {
  const headers = apiHeaders(request, {
    "Content-Type": "application/json; charset=utf-8",
    "X-Speedtest-Mode": "ping",
    "Server-Timing": "edge;desc=\"ESA\""
  });

  if (request.method === "HEAD") {
    return new Response(null, { status: 204, headers });
  }

  return new Response(
    JSON.stringify({
      ok: true,
      serverTime: new Date().toISOString(),
      edge: detectEdge(request)
    }),
    { status: 200, headers }
  );
}

function binaryResponse(request, bytes, mode) {
  const headers = apiHeaders(request, {
    "Content-Type": "application/octet-stream",
    "Content-Length": String(bytes),
    "Content-Disposition": `inline; filename="${mode}-${bytes}.bin"`,
    "X-Speedtest-Bytes": String(bytes),
    "X-Speedtest-Mode": mode,
    "Accept-Ranges": "none"
  });

  if (request.method === "HEAD") {
    return new Response(null, { status: 204, headers });
  }

  return new Response(makeByteStream(bytes), {
    status: 200,
    headers
  });
}

async function handleUpload(request) {
  const contentLength = toInt(request.headers.get("Content-Length"), 0);
  if (contentLength > CONFIG.maxUploadBytes) {
    return jsonResponse(
      { error: "payload_too_large", maxUploadBytes: CONFIG.maxUploadBytes },
      413,
      request
    );
  }

  const started = Date.now();
  let result;
  try {
    result = await readRequestBody(request, CONFIG.maxUploadBytes);
  } catch (error) {
    return jsonResponse(
      {
        error: error.message || "upload_failed",
        maxUploadBytes: CONFIG.maxUploadBytes
      },
      error.status || 500,
      request
    );
  }
  const elapsedMs = Math.max(Date.now() - started, 1);

  return jsonResponse(
    {
      ok: true,
      bytes: result.bytes,
      elapsedMs,
      serverMbps: (result.bytes * 8) / (elapsedMs / 1000) / 1_000_000,
      serverTime: new Date().toISOString()
    },
    200,
    request,
    {
      "X-Speedtest-Bytes": String(result.bytes),
      "X-Speedtest-Mode": "upload"
    }
  );
}

async function readRequestBody(request, maxBytes) {
  if (request.body && typeof request.body.getReader === "function") {
    const reader = request.body.getReader();
    let bytes = 0;
    const deadline = Date.now() + CONFIG.uploadReadTimeoutMs;

    while (true) {
      if (Date.now() > deadline) {
        try {
          await reader.cancel();
        } catch {}
        const error = new Error("upload_timeout");
        error.status = 408;
        throw error;
      }

      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength || value.length || 0;
      if (bytes > maxBytes) {
        try {
          await reader.cancel();
        } catch {}
        const error = new Error("payload_too_large");
        error.status = 413;
        throw error;
      }
    }

    return { bytes };
  }

  const buffer = await request.arrayBuffer();
  if (buffer.byteLength > maxBytes) {
    const error = new Error("payload_too_large");
    error.status = 413;
    throw error;
  }
  return { bytes: buffer.byteLength };
}

function makeByteStream(totalBytes) {
  const chunk = getPatternChunk(CONFIG.chunkBytes);
  let sent = 0;

  return new ReadableStream({
    pull(controller) {
      if (sent >= totalBytes) {
        controller.close();
        return;
      }

      const remaining = totalBytes - sent;
      if (remaining >= chunk.byteLength) {
        controller.enqueue(chunk);
        sent += chunk.byteLength;
      } else {
        controller.enqueue(chunk.slice(0, remaining));
        sent += remaining;
      }
    },
    cancel() {
      sent = totalBytes;
    }
  });
}

function getPatternChunk(size) {
  const safeSize = Math.max(1024, Math.min(size, 1024 * 1024));
  if (CHUNK_CACHE.has(safeSize)) return CHUNK_CACHE.get(safeSize);

  const chunk = new Uint8Array(safeSize);
  let seed = 0x6d2b79f5;
  for (let index = 0; index < chunk.length; index += 1) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    chunk[index] = seed & 255;
  }
  CHUNK_CACHE.set(safeSize, chunk);
  return chunk;
}

function readSize(url, fallback, maxBytes) {
  const requested = toInt(url.searchParams.get("bytes"), fallback);
  return Math.min(Math.max(requested, CONFIG.minBytes), maxBytes);
}

function normalizeConfig(config) {
  return {
    ...config,
    allowedOrigins: normalizeStringList(config.allowedOrigins),
    accessTokens: normalizeStringList(config.accessTokens)
  };
}

function normalizeStringList(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item || "").trim()).filter(Boolean);
  }
  if (typeof value === "string") {
    return value
      .split(/[,\n\r]+/)
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
}

function toInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function isAuthorized(request, url) {
  if (CONFIG.accessTokens.length === 0) return true;

  const headerToken = request.headers.get("X-Speedtest-Token") || "";
  const queryToken = CONFIG.allowQueryToken ? url.searchParams.get("token") || "" : "";
  const candidate = headerToken || queryToken;
  return CONFIG.accessTokens.some((token) => constantTimeEqual(candidate, token));
}

function constantTimeEqual(left, right) {
  const a = String(left || "");
  const b = String(right || "");
  let diff = a.length ^ b.length;
  const max = Math.max(a.length, b.length);
  for (let index = 0; index < max; index += 1) {
    diff |= (a.charCodeAt(index) || 0) ^ (b.charCodeAt(index) || 0);
  }
  return diff === 0;
}

function isOriginAllowed(request) {
  const origin = request.headers.get("Origin");
  if (!origin) return true;
  if (CONFIG.allowedOrigins.includes("*")) return true;
  return CONFIG.allowedOrigins.includes(origin);
}

function corsHeaders(request) {
  const origin = request.headers.get("Origin");
  const headers = {
    Vary: "Origin",
    "Access-Control-Allow-Methods": "GET, POST, HEAD, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Speedtest-Token, X-Speedtest-Bytes, X-Requested-With",
    "Access-Control-Expose-Headers":
      "Content-Length, Content-Type, X-Speedtest-Bytes, X-Speedtest-Mode, Server-Timing"
  };

  if (CONFIG.allowedOrigins.includes("*")) {
    headers["Access-Control-Allow-Origin"] = origin || "*";
  } else if (origin && CONFIG.allowedOrigins.includes(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
  }

  return headers;
}

function securityHeaders(extra = {}) {
  return {
    "Content-Security-Policy":
      "default-src 'self'; connect-src 'self' https: http://localhost:* http://127.0.0.1:*; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'self'",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Cross-Origin-Resource-Policy": "cross-origin",
    "Timing-Allow-Origin": "*",
    ...extra
  };
}

function apiHeaders(request, extra = {}) {
  return new Headers({
    ...securityHeaders({
      "Cache-Control": "no-store, no-cache, max-age=0, no-transform",
      Pragma: "no-cache"
    }),
    ...corsHeaders(request),
    ...extra
  });
}

function staticHeaders(path, asset) {
  const immutable = path.startsWith("/assets/");
  return new Headers(
    securityHeaders({
      "Content-Type": asset.contentType || "application/octet-stream",
      "Cache-Control": immutable
        ? `public, max-age=${CONFIG.staticMaxAge}, immutable`
        : "no-cache, no-store, must-revalidate",
      ETag: asset.etag || `"${path}:${asset.body.length}"`
    })
  );
}

function jsonResponse(data, status, request, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: apiHeaders(request, {
      "Content-Type": "application/json; charset=utf-8",
      ...extraHeaders
    })
  });
}

function textResponse(text, status, request, extraHeaders = {}) {
  return new Response(text, {
    status,
    headers: apiHeaders(request, {
      "Content-Type": "text/plain; charset=utf-8",
      ...extraHeaders
    })
  });
}

function serveStatic(request, url) {
  const path = normalizeAssetPath(url.pathname);
  let asset = STATIC_ASSETS[path];

  if (!asset && wantsHtml(request) && STATIC_ASSETS["/index.html"]) {
    asset = STATIC_ASSETS["/index.html"];
  }

  if (!asset) {
    return fallbackHtml();
  }

  return new Response(request.method === "HEAD" ? null : decodeAsset(asset), {
    status: 200,
    headers: staticHeaders(path, asset)
  });
}

function normalizeAssetPath(pathname) {
  if (!pathname || pathname === "/") return "/index.html";
  const decoded = safeDecode(pathname);
  if (decoded.includes("..")) return "/index.html";
  return decoded.startsWith("/") ? decoded : `/${decoded}`;
}

function wantsHtml(request) {
  const accept = request.headers.get("Accept") || "";
  return accept.includes("text/html") || accept.includes("*/*");
}

function decodeAsset(asset) {
  if (asset.encoding !== "base64") return asset.body;
  const raw = atob(asset.body);
  const bytes = new Uint8Array(raw.length);
  for (let index = 0; index < raw.length; index += 1) {
    bytes[index] = raw.charCodeAt(index);
  }
  return bytes;
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function fallbackHtml() {
  return new Response(
    `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${CONFIG.serviceName}</title></head><body><main style="font-family:system-ui,sans-serif;max-width:720px;margin:12vh auto;padding:24px;line-height:1.6"><h1>${CONFIG.serviceName}</h1><p>边缘测速 API 已启动。运行 <code>npm run build:edge</code> 后部署 <code>dist-edge/edge.js</code> 可同时提供 Vue 前端。</p></main></body></html>`,
    {
      status: 200,
      headers: new Headers(
        securityHeaders({
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store"
        })
      )
    }
  );
}

function detectEdge(request) {
  const headers = request.headers;
  return compactObject({
    pop:
      headers.get("Ali-Edge-Pop") ||
      headers.get("X-Edge-Pop") ||
      headers.get("X-ESAPOP") ||
      headers.get("X-POP"),
    region: headers.get("Ali-Region") || headers.get("X-Region"),
    city: headers.get("Ali-City") || headers.get("X-City"),
    ip:
      headers.get("Ali-Cdn-Real-Ip") ||
      headers.get("X-Forwarded-For")?.split(",")[0]?.trim() ||
      headers.get("X-Real-IP")
  });
}

function compactObject(value) {
  const next = {};
  for (const key of Object.keys(value)) {
    if (value[key]) next[key] = value[key];
  }
  return next;
}
