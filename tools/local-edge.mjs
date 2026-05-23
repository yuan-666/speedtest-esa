import { createServer } from "node:http";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
await import(resolve(__dirname, "../edge/speedtest-edge.js"));

const handleRequest = globalThis.speedtestEdge?.handleRequest;
if (!handleRequest) {
  throw new Error("Unable to load edge handler");
}

const port = Number.parseInt(process.env.PORT || "8787", 10);

const server = createServer(async (incoming, outgoing) => {
  try {
    const host = incoming.headers.host || `127.0.0.1:${port}`;
    const url = `http://${host}${incoming.url || "/"}`;
    const method = incoming.method || "GET";
    const headers = new Headers();

    for (const [key, value] of Object.entries(incoming.headers)) {
      if (Array.isArray(value)) {
        for (const item of value) headers.append(key, item);
      } else if (value !== undefined) {
        headers.set(key, value);
      }
    }

    const requestInit = { method, headers };
    if (method !== "GET" && method !== "HEAD") {
      requestInit.body = Readable.toWeb(incoming);
      requestInit.duplex = "half";
    }

    const response = await handleRequest(new Request(url, requestInit));
    outgoing.statusCode = response.status;
    outgoing.statusMessage = response.statusText;
    response.headers.forEach((value, key) => outgoing.setHeader(key, value));

    if (method === "HEAD" || !response.body) {
      outgoing.end();
      return;
    }

    Readable.fromWeb(response.body).pipe(outgoing);
  } catch (error) {
    outgoing.statusCode = error.status || 500;
    outgoing.setHeader("Content-Type", "application/json; charset=utf-8");
    outgoing.end(JSON.stringify({ error: error.message || "local_edge_error" }));
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`local ESA edge listening on http://127.0.0.1:${port}`);
});
