# APP 接入协议

基础地址使用你的 ESA 函数域名，例如：

```text
https://speed.example.com
```

如果构建部署时启用了 `SPEEDTEST_TOKEN` 或 `SPEEDTEST_TOKENS`，所有非公开测速接口都带上：

```http
X-Speedtest-Token: <build-time-speedtest-token>
```

## 1. 配置

```http
GET /api/config
```

响应字段：

```json
{
  "serviceName": "ESA Edge Speed",
  "defaultSingleBytes": 67108864,
  "maxDownloadBytes": 536870912,
  "maxFlowBytes": 1073741824,
  "maxUploadBytes": 67108864,
  "minBytes": 65536,
  "chunkBytes": 262144,
  "defaultFlowSeconds": 12,
  "maxParallel": 8,
  "authRequired": false,
  "edge": {}
}
```

## 2. 延迟

```http
GET /api/ping?r=<random>
```

APP 端建议连续请求 6-10 次，去掉最高和最低后取平均值作为延迟，连续样本差值平均值作为抖动。

## 3. 单次下载测速

```http
GET /api/download?bytes=67108864&r=<random>
```

客户端读取完整 body，按以下公式计算：

```text
Mbps = receivedBytes * 8 / elapsedSeconds / 1_000_000
```

建议大小：

- 弱网或蜂窝：`8-32 MiB`
- 宽带：`64-256 MiB`
- 千兆或以上：`256-512 MiB`

## 4. 持续打流测速

```http
GET /api/flow?bytes=536870912&stream=0&r=<random>
```

APP 端发起多个并发下载流，按固定时长中止请求。推荐流程：

1. 从 `/api/config` 读取 `maxParallel` 和 `maxFlowBytes`。
2. 启动 `min(4, maxParallel)` 个并发流。
3. 每 500 ms 统计增量字节数，计算实时 Mbps 和峰值 Mbps。
4. 达到目标时长后主动取消所有请求。

推荐参数：

- 默认时长：`10-15 s`
- 高速链路：`20-30 s`
- 默认并发：`4`
- 高速链路并发：`6-8`

## 5. 上传测速

```http
POST /api/upload?r=<random>
Content-Type: application/octet-stream
X-Speedtest-Bytes: 8388608

<binary body>
```

客户端按发送耗时计算上传速率。默认上传大小建议 `4-16 MiB`，不要超过 `/api/config` 返回的 `maxUploadBytes`。

## 6. 错误处理

常见状态码：

- `401`：缺少或错误的 `X-Speedtest-Token`。
- `403`：`Origin` 不在 allowlist。
- `413`：请求体或测速大小超过上限。
- `408`：上传读取超时。

## 7. 客户端注意事项

- 每次请求带随机参数 `r`，避免浏览器、WebView 或代理复用缓存。
- 下载和打流接口响应头已经设置 `Cache-Control: no-store, no-transform`，客户端也应使用 no-cache/no-store 策略。
- 不要无限打流；使用固定时长并主动取消请求。
- 在 APP 后台或低电量模式下停止测速，避免系统限速导致结果失真。
- 统计时以客户端实际收到/发送的字节数为准，不要只信任 `Content-Length`。
- 不要把令牌放进 URL；使用 `X-Speedtest-Token` 请求头。
