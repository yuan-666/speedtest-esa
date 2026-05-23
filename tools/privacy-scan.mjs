import { execFile } from "node:child_process";
import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = new URL("..", import.meta.url).pathname;

const blockedPathPatterns = [
  /(^|\/)\.env($|\.)/,
  /(^|\/)dist\//,
  /(^|\/)dist-edge\//,
  /(^|\/)node_modules\//
];

const allowedPathPatterns = [
  /(^|\/)\.env\.example$/
];

const secretPatterns = [
  {
    name: "embedded build token config",
    pattern: /__SPEEDTEST_BUILD_CONFIG__\s*=\s*\{[^;]*(accessTokens|"accessTokens")/s
  },
  {
    name: "hard-coded access token array",
    pattern: /accessTokens\s*:\s*\[\s*["'][A-Za-z0-9_-]{32,}["']/s
  },
  {
    name: "private key",
    pattern: /-----BEGIN (RSA |EC |OPENSSH |)PRIVATE KEY-----/
  },
  {
    name: "cloud access key",
    pattern: /(ALIYUN|ALIBABA|AWS|CLOUDFLARE|GITHUB)_[A-Z0-9_]*(SECRET|TOKEN|KEY)\s*=\s*['"]?[A-Za-z0-9_./+=-]{16,}/
  }
];

const textExtensions = new Set([
  ".css",
  ".html",
  ".js",
  ".json",
  ".md",
  ".mjs",
  ".txt",
  ".vue",
  ".yml",
  ".yaml"
]);

const files = await listCandidateFiles();
const failures = [];

for (const file of files) {
  if (isAllowedPath(file)) continue;
  if (isBlockedPath(file)) {
    failures.push(`${file}: blocked path should not be included in public repo`);
    continue;
  }

  if (!isLikelyTextFile(file)) continue;
  const text = await readFile(join(root, file), "utf8").catch(() => "");
  for (const check of secretPatterns) {
    if (check.pattern.test(text)) {
      failures.push(`${file}: ${check.name}`);
    }
  }
}

if (failures.length > 0) {
  console.error("Privacy scan failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`Privacy scan passed (${files.length} file candidates checked)`);

async function listCandidateFiles() {
  try {
    const { stdout } = await execFileAsync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
      cwd: root
    });
    const gitFiles = stdout.split("\n").map((item) => item.trim()).filter(Boolean);
    if (gitFiles.length > 0) return gitFiles;
  } catch {}

  return walk(".");
}

async function walk(dir) {
  const entries = await readdir(join(root, dir));
  const files = [];

  for (const entry of entries) {
    const rel = dir === "." ? entry : `${dir}/${entry}`;
    if (rel === ".git" || rel.startsWith(".git/")) continue;
    if (isBlockedPath(rel) && !isAllowedPath(rel)) continue;

    const info = await lstat(join(root, rel));
    if (info.isDirectory()) {
      files.push(...(await walk(rel)));
    } else if (info.isFile()) {
      files.push(rel);
    }
  }

  return files;
}

function isBlockedPath(file) {
  return blockedPathPatterns.some((pattern) => pattern.test(file));
}

function isAllowedPath(file) {
  return allowedPathPatterns.some((pattern) => pattern.test(file));
}

function isLikelyTextFile(file) {
  const index = file.lastIndexOf(".");
  if (index === -1) return false;
  return textExtensions.has(file.slice(index).toLowerCase());
}
