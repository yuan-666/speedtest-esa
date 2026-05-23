const base = process.env.SPEEDTEST_BASE || "http://127.0.0.1:8787";

async function readBytes(path) {
  const response = await fetch(`${base}${path}`, { cache: "no-store" });
  if (!response.ok) throw new Error(`${path} -> ${response.status}`);
  const reader = response.body.getReader();
  let bytes = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
  }
  return bytes;
}

async function main() {
  const config = await fetch(`${base}/api/config`).then((response) => response.json());
  const ping = await fetch(`${base}/api/ping`).then((response) => response.json());
  const downloadBytes = await readBytes("/api/download?bytes=1048576");
  const uploadResponse = await fetch(`${base}/api/upload`, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: new Uint8Array(512 * 1024)
  }).then((response) => response.json());

  console.log(
    JSON.stringify(
      {
        config: config.serviceName,
        ping: ping.ok,
        downloadBytes,
        uploadBytes: uploadResponse.bytes
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
