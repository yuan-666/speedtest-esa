<script setup>
import { computed, onMounted, reactive, ref, watch } from "vue";
import {
  Activity,
  Download,
  Gauge,
  Play,
  Radio,
  RefreshCw,
  Server,
  ShieldCheck,
  SlidersHorizontal,
  Smartphone,
  Square,
  Upload
} from "lucide-vue-next";

const MiB = 1024 * 1024;
const API_BASE = (import.meta.env.VITE_API_BASE || "").replace(/\/$/, "");
const DEFAULT_FLOW_SECONDS = 12;

const config = reactive({
  serviceName: "ESA Edge Speed",
  maxDownloadBytes: 512 * MiB,
  maxFlowBytes: 1024 * MiB,
  maxUploadBytes: 64 * MiB,
  defaultSingleBytes: 64 * MiB,
  defaultFlowSeconds: DEFAULT_FLOW_SECONDS,
  maxParallel: 8,
  authRequired: false,
  edge: {}
});

const state = reactive({
  mode: "single",
  phase: "idle",
  status: "待机",
  error: "",
  singleSizeMiB: 64,
  uploadSizeMiB: 8,
  flowSeconds: DEFAULT_FLOW_SECONDS,
  parallel: 4,
  includeUpload: false
});

const storedToken =
  typeof localStorage !== "undefined" ? localStorage.getItem("speedtest-token") || "" : "";
const token = ref(storedToken);

const metrics = reactive({
  latencyMs: null,
  jitterMs: null,
  downloadMbps: 0,
  uploadMbps: 0,
  liveMbps: 0,
  peakMbps: 0,
  downloadedBytes: 0,
  uploadedBytes: 0,
  progress: 0,
  elapsedMs: 0
});

const rateSamples = ref([]);
const activeControllers = new Set();
let runId = 0;

watch(token, (value) => {
  if (typeof localStorage !== "undefined") {
    localStorage.setItem("speedtest-token", value.trim());
  }
});

const isRunning = computed(() => state.phase === "running");
const apiOriginLabel = computed(() => API_BASE || window.location.origin);
const selectedBytes = computed(() => clampBytes(state.singleSizeMiB * MiB, MiB, config.maxDownloadBytes));
const uploadBytes = computed(() => clampBytes(state.uploadSizeMiB * MiB, MiB, config.maxUploadBytes));
const resultMbps = computed(() => {
  if (metrics.liveMbps > 0) return metrics.liveMbps;
  if (metrics.downloadMbps > 0) return metrics.downloadMbps;
  return 0;
});
const gaugePercent = computed(() => {
  const speed = resultMbps.value;
  const scale = speed < 100 ? 100 : speed < 500 ? 500 : speed < 1000 ? 1000 : speed < 2500 ? 2500 : 5000;
  return Math.min(100, Math.round((speed / scale) * 100));
});
const gaugeStyle = computed(() => ({
  "--meter": `${gaugePercent.value}%`
}));
const chartBars = computed(() => {
  const tail = rateSamples.value.slice(-28);
  const max = Math.max(...tail, 1);
  return tail.map((value) => ({
    value,
    height: `${Math.max(10, (value / max) * 100)}%`
  }));
});
const edgeLabel = computed(() => {
  const edge = config.edge || {};
  return edge.pop || edge.region || edge.city || "ESA Edge";
});
const endpointRows = computed(() => [
  { method: "GET", path: "/api/ping" },
  { method: "GET", path: "/api/download?bytes=67108864" },
  { method: "GET", path: "/api/flow?bytes=536870912" },
  { method: "POST", path: "/api/upload" }
]);

const sizeOptions = [8, 16, 32, 64, 128, 256, 512];
const uploadOptions = [2, 4, 8, 16, 32, 64];

function clampBytes(value, min, max) {
  return Math.min(Math.max(Math.round(value), min), max);
}

function formatMbps(value) {
  if (!Number.isFinite(value) || value <= 0) return "0";
  if (value >= 1000) return (value / 1000).toFixed(value >= 10000 ? 1 : 2);
  if (value >= 100) return value.toFixed(0);
  if (value >= 10) return value.toFixed(1);
  return value.toFixed(2);
}

function speedUnit(value) {
  return value >= 1000 ? "Gbps" : "Mbps";
}

function formatBytes(bytes) {
  if (!bytes) return "0 B";
  if (bytes >= 1024 * MiB) return `${(bytes / (1024 * MiB)).toFixed(2)} GiB`;
  if (bytes >= MiB) return `${(bytes / MiB).toFixed(1)} MiB`;
  return `${(bytes / 1024).toFixed(0)} KiB`;
}

function formatDuration(ms) {
  if (!ms) return "0.0 s";
  if (ms < 1000) return `${Math.max(1, Math.round(ms))} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

function bytesToMbps(bytes, ms) {
  if (!bytes || !ms) return 0;
  return (bytes * 8) / (ms / 1000) / 1_000_000;
}

function cacheBust() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function apiUrl(path) {
  return `${API_BASE}${path}`;
}

function makeHeaders(headers = {}) {
  const next = new Headers(headers);
  const cleanToken = token.value.trim();
  if (cleanToken) next.set("X-Speedtest-Token", cleanToken);
  return next;
}

function makeController() {
  const controller = new AbortController();
  activeControllers.add(controller);
  return controller;
}

function releaseController(controller) {
  activeControllers.delete(controller);
}

async function fetchApi(path, options = {}) {
  const response = await fetch(apiUrl(path), {
    ...options,
    cache: "no-store",
    headers: makeHeaders(options.headers)
  });
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    try {
      const data = await response.json();
      message = data.error || data.message || message;
    } catch {
      const text = await response.text().catch(() => "");
      if (text) message = text.slice(0, 180);
    }
    throw new Error(message);
  }
  return response;
}

async function loadConfig() {
  try {
    const response = await fetchApi(`/api/config?r=${cacheBust()}`);
    const data = await response.json();
    Object.assign(config, data);
    state.singleSizeMiB = Math.min(Math.round(config.defaultSingleBytes / MiB), Math.round(config.maxDownloadBytes / MiB));
    state.flowSeconds = config.defaultFlowSeconds || DEFAULT_FLOW_SECONDS;
    state.parallel = Math.min(state.parallel, config.maxParallel || 8);
  } catch (error) {
    state.error = `配置读取失败：${error.message}`;
  }
}

function resetMetrics() {
  metrics.latencyMs = null;
  metrics.jitterMs = null;
  metrics.downloadMbps = 0;
  metrics.uploadMbps = 0;
  metrics.liveMbps = 0;
  metrics.peakMbps = 0;
  metrics.downloadedBytes = 0;
  metrics.uploadedBytes = 0;
  metrics.progress = 0;
  metrics.elapsedMs = 0;
  rateSamples.value = [];
}

function cancelRun() {
  if (!isRunning.value) return;
  runId += 1;
  state.status = "已停止";
  for (const controller of activeControllers) controller.abort();
  activeControllers.clear();
  state.phase = "idle";
}

function ensureActive(id) {
  if (id !== runId) {
    const error = new Error("测试已停止");
    error.cancelled = true;
    throw error;
  }
}

async function runLatency(id) {
  state.status = "测量延迟";
  const samples = [];

  for (let index = 0; index < 8; index += 1) {
    ensureActive(id);
    const controller = makeController();
    const started = performance.now();
    try {
      const response = await fetchApi(`/api/ping?r=${cacheBust()}&n=${index}`, {
        signal: controller.signal
      });
      await response.text();
      samples.push(performance.now() - started);
    } finally {
      releaseController(controller);
    }
    await new Promise((resolve) => setTimeout(resolve, 80));
  }

  samples.sort((a, b) => a - b);
  const trimmed = samples.slice(1, -1);
  const usable = trimmed.length ? trimmed : samples;
  const avg = usable.reduce((sum, item) => sum + item, 0) / usable.length;
  const jitter =
    usable.length > 1
      ? usable.slice(1).reduce((sum, item, index) => sum + Math.abs(item - usable[index]), 0) /
        (usable.length - 1)
      : 0;

  metrics.latencyMs = avg;
  metrics.jitterMs = jitter;
}

async function readDownload(endpoint, bytes, id, onChunk) {
  const controller = makeController();
  const started = performance.now();
  let received = 0;

  try {
    const response = await fetchApi(`${endpoint}?bytes=${bytes}&r=${cacheBust()}`, {
      signal: controller.signal
    });
    const reader = response.body?.getReader();
    if (!reader) {
      const buffer = await response.arrayBuffer();
      received = buffer.byteLength;
      onChunk?.(received, performance.now() - started);
    } else {
      while (true) {
        ensureActive(id);
        const { value, done } = await reader.read();
        if (done) break;
        received += value.byteLength;
        onChunk?.(received, performance.now() - started, value.byteLength);
      }
    }
  } finally {
    releaseController(controller);
  }

  return {
    bytes: received,
    ms: performance.now() - started
  };
}

async function runSingleDownload(id) {
  state.status = "单次下载";
  const bytes = selectedBytes.value;
  const result = await readDownload("/api/download", bytes, id, (received, elapsed) => {
    metrics.downloadedBytes = received;
    metrics.elapsedMs = elapsed;
    metrics.progress = Math.min(100, Math.round((received / bytes) * 100));
    metrics.liveMbps = bytesToMbps(received, elapsed);
  });

  metrics.downloadMbps = bytesToMbps(result.bytes, result.ms);
  metrics.liveMbps = metrics.downloadMbps;
  metrics.peakMbps = Math.max(metrics.peakMbps, metrics.downloadMbps);
  rateSamples.value.push(metrics.downloadMbps);
}

async function runFlowDownload(id) {
  state.status = "持续打流";
  const durationMs = clampBytes(state.flowSeconds, 3, 120) * 1000;
  const parallel = Math.min(Math.max(state.parallel, 1), config.maxParallel || 8);
  const deadline = performance.now() + durationMs;
  const flowBytes = Math.min(config.maxFlowBytes, Math.max(config.maxDownloadBytes, 64 * MiB));
  let total = 0;
  let lastBytes = 0;
  let lastTick = performance.now();

  const sampleTimer = setInterval(() => {
    const now = performance.now();
    const deltaBytes = total - lastBytes;
    const deltaMs = Math.max(now - lastTick, 1);
    metrics.liveMbps = bytesToMbps(deltaBytes, deltaMs);
    metrics.peakMbps = Math.max(metrics.peakMbps, metrics.liveMbps);
    metrics.elapsedMs = Math.min(durationMs, now - (deadline - durationMs));
    metrics.progress = Math.min(100, Math.round((metrics.elapsedMs / durationMs) * 100));
    rateSamples.value.push(metrics.liveMbps);
    if (rateSamples.value.length > 80) rateSamples.value = rateSamples.value.slice(-80);
    lastBytes = total;
    lastTick = now;
  }, 500);

  async function worker(index) {
    while (performance.now() < deadline) {
      ensureActive(id);
      const controller = makeController();
      const timeout = setTimeout(() => controller.abort(), Math.max(20, deadline - performance.now()));
      try {
        const response = await fetchApi(`/api/flow?bytes=${flowBytes}&stream=${index}&r=${cacheBust()}`, {
          signal: controller.signal
        });
        const reader = response.body?.getReader();
        if (!reader) {
          const buffer = await response.arrayBuffer();
          total += buffer.byteLength;
          continue;
        }
        while (performance.now() < deadline) {
          ensureActive(id);
          const { value, done } = await reader.read();
          if (done) break;
          total += value.byteLength;
          metrics.downloadedBytes = total;
        }
      } catch (error) {
        if (performance.now() < deadline - 50 && !controller.signal.aborted) throw error;
      } finally {
        clearTimeout(timeout);
        releaseController(controller);
      }
    }
  }

  try {
    await Promise.all(Array.from({ length: parallel }, (_, index) => worker(index)));
  } finally {
    clearInterval(sampleTimer);
  }

  metrics.downloadedBytes = total;
  metrics.elapsedMs = durationMs;
  metrics.progress = 100;
  metrics.downloadMbps = bytesToMbps(total, durationMs);
  metrics.liveMbps = metrics.downloadMbps;
  metrics.peakMbps = Math.max(metrics.peakMbps, metrics.downloadMbps);
}

function makeUploadBlob(bytes) {
  const chunkSize = Math.min(MiB, bytes);
  const chunk = new Uint8Array(chunkSize);
  for (let index = 0; index < chunk.length; index += 1) {
    chunk[index] = (index * 31 + 17) & 255;
  }

  const parts = [];
  let remaining = bytes;
  while (remaining > 0) {
    const size = Math.min(chunk.byteLength, remaining);
    parts.push(size === chunk.byteLength ? chunk : chunk.slice(0, size));
    remaining -= size;
  }
  return new Blob(parts, { type: "application/octet-stream" });
}

async function runUpload(id) {
  state.status = "上传测速";
  const bytes = uploadBytes.value;
  const payload = makeUploadBlob(bytes);
  const controller = makeController();
  const started = performance.now();

  try {
    await fetchApi(`/api/upload?r=${cacheBust()}`, {
      method: "POST",
      body: payload,
      headers: {
        "Content-Type": "application/octet-stream",
        "X-Speedtest-Bytes": String(bytes)
      },
      signal: controller.signal
    });
  } finally {
    releaseController(controller);
  }

  ensureActive(id);
  const ms = performance.now() - started;
  metrics.uploadedBytes = bytes;
  metrics.uploadMbps = bytesToMbps(bytes, ms);
}

async function runTest() {
  if (isRunning.value) return;
  runId += 1;
  const id = runId;
  resetMetrics();
  state.error = "";
  state.phase = "running";
  state.status = "准备测试";

  try {
    await runLatency(id);
    ensureActive(id);
    if (state.mode === "flow") {
      await runFlowDownload(id);
    } else {
      await runSingleDownload(id);
    }
    ensureActive(id);
    if (state.includeUpload) await runUpload(id);
    state.phase = "done";
    state.status = "完成";
  } catch (error) {
    if (!error.cancelled && error.name !== "AbortError") {
      state.error = error.message || "测试失败";
      state.phase = "error";
      state.status = "异常";
    }
  } finally {
    for (const controller of activeControllers) controller.abort();
    activeControllers.clear();
    if (state.phase === "running") state.phase = "idle";
  }
}

onMounted(loadConfig);
</script>

<template>
  <main class="app-shell">
    <header class="topbar">
      <div class="brand-lockup">
        <div class="brand-mark" aria-hidden="true">
          <Gauge :size="22" :stroke-width="1.8" />
        </div>
        <div>
          <p class="eyebrow">{{ edgeLabel }}</p>
          <h1>{{ config.serviceName }}</h1>
        </div>
      </div>

      <div class="topbar-actions">
        <div class="status-pill" :class="state.phase">
          <Activity :size="16" :stroke-width="2" />
          <span>{{ state.status }}</span>
        </div>
        <button class="icon-button" type="button" title="刷新配置" aria-label="刷新配置" @click="loadConfig">
          <RefreshCw :size="17" :stroke-width="2" />
        </button>
      </div>
    </header>

    <section class="workbench">
      <aside class="panel controls-panel">
        <div class="section-title">
          <SlidersHorizontal :size="18" :stroke-width="2" />
          <h2>测试控制</h2>
        </div>

        <div class="segmented" role="tablist" aria-label="测速模式">
          <button type="button" :class="{ active: state.mode === 'single' }" @click="state.mode = 'single'">
            <Download :size="16" :stroke-width="2" />
            <span>单次测速</span>
          </button>
          <button type="button" :class="{ active: state.mode === 'flow' }" @click="state.mode = 'flow'">
            <Radio :size="16" :stroke-width="2" />
            <span>持续打流</span>
          </button>
        </div>

        <div class="control-stack">
          <label v-if="state.mode === 'single'" class="field">
            <span>下载大小</span>
            <select v-model.number="state.singleSizeMiB">
              <option v-for="size in sizeOptions" :key="size" :value="size" :disabled="size * MiB > config.maxDownloadBytes">
                {{ size }} MiB
              </option>
            </select>
          </label>

          <label v-if="state.mode === 'flow'" class="field">
            <span>打流时长</span>
            <input v-model.number="state.flowSeconds" type="range" min="3" max="60" step="1" />
            <strong>{{ state.flowSeconds }} s</strong>
          </label>

          <label v-if="state.mode === 'flow'" class="field">
            <span>并发连接</span>
            <input v-model.number="state.parallel" type="range" min="1" :max="config.maxParallel" step="1" />
            <strong>{{ state.parallel }}</strong>
          </label>

          <label class="check-row">
            <input v-model="state.includeUpload" type="checkbox" />
            <span>包含上传</span>
          </label>

          <label v-if="state.includeUpload" class="field">
            <span>上传大小</span>
            <select v-model.number="state.uploadSizeMiB">
              <option
                v-for="size in uploadOptions"
                :key="size"
                :value="size"
                :disabled="size * MiB > config.maxUploadBytes"
              >
                {{ size }} MiB
              </option>
            </select>
          </label>

          <label class="field">
            <span>访问令牌</span>
            <input v-model="token" type="password" autocomplete="off" placeholder="可选" />
          </label>
        </div>

        <div class="action-row">
          <button class="primary-action" type="button" :disabled="isRunning" @click="runTest">
            <Play :size="18" :stroke-width="2.2" />
            <span>{{ isRunning ? "运行中" : "开始测速" }}</span>
          </button>
          <button class="stop-action" type="button" :disabled="!isRunning" title="停止" aria-label="停止测试" @click="cancelRun">
            <Square :size="17" :stroke-width="2.2" />
          </button>
        </div>

        <p v-if="state.error" class="error-text">{{ state.error }}</p>
      </aside>

      <section class="meter-panel">
        <div class="meter-grid">
          <div class="meter" :style="gaugeStyle">
            <div class="meter-face">
              <span class="meter-label">当前下载</span>
              <strong>{{ formatMbps(resultMbps) }}</strong>
              <small>{{ speedUnit(resultMbps) }}</small>
            </div>
          </div>

          <div class="result-grid">
            <div class="metric">
              <Activity :size="18" :stroke-width="2" />
              <span>延迟</span>
              <strong>{{ metrics.latencyMs === null ? "--" : metrics.latencyMs.toFixed(1) }}</strong>
              <small>ms</small>
            </div>
            <div class="metric">
              <Radio :size="18" :stroke-width="2" />
              <span>抖动</span>
              <strong>{{ metrics.jitterMs === null ? "--" : metrics.jitterMs.toFixed(1) }}</strong>
              <small>ms</small>
            </div>
            <div class="metric">
              <Download :size="18" :stroke-width="2" />
              <span>峰值</span>
              <strong>{{ formatMbps(metrics.peakMbps) }}</strong>
              <small>{{ speedUnit(metrics.peakMbps) }}</small>
            </div>
            <div class="metric">
              <Upload :size="18" :stroke-width="2" />
              <span>上传</span>
              <strong>{{ formatMbps(metrics.uploadMbps) }}</strong>
              <small>{{ speedUnit(metrics.uploadMbps) }}</small>
            </div>
          </div>
        </div>

        <div class="progress-strip" aria-label="测试进度">
          <span :style="{ width: `${metrics.progress}%` }"></span>
        </div>

        <div class="chart" aria-label="实时速率">
          <span v-for="(bar, index) in chartBars" :key="`${index}-${bar.value}`" :style="{ height: bar.height }"></span>
        </div>

        <div class="summary-row">
          <div>
            <span>已下载</span>
            <strong>{{ formatBytes(metrics.downloadedBytes) }}</strong>
          </div>
          <div>
            <span>已上传</span>
            <strong>{{ formatBytes(metrics.uploadedBytes) }}</strong>
          </div>
          <div>
            <span>耗时</span>
            <strong>{{ formatDuration(metrics.elapsedMs) }}</strong>
          </div>
        </div>
      </section>

      <aside class="panel integration-panel">
        <div class="section-title">
          <Smartphone :size="18" :stroke-width="2" />
          <h2>APP 端点</h2>
        </div>

        <div class="origin-box">
          <Server :size="17" :stroke-width="2" />
          <span>{{ apiOriginLabel }}</span>
        </div>

        <div class="endpoint-list">
          <div v-for="row in endpointRows" :key="row.path" class="endpoint-row">
            <span>{{ row.method }}</span>
            <code>{{ row.path }}</code>
          </div>
        </div>

        <div class="security-note">
          <ShieldCheck :size="17" :stroke-width="2" />
          <span>{{ config.authRequired ? "令牌保护已启用" : "令牌保护未启用" }}</span>
        </div>
      </aside>
    </section>
  </main>
</template>
