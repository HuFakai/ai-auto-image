# Pixelle HyperFrames 本地渲染服务

这里是双引擎方案中 HyperFrames 路线的本地 Producer 服务，已经接入生产队列。

## 环境

- Node.js 22+
- Chrome/Chromium
- FFmpeg
- HyperFrames / `@hyperframes/producer` 固定为 `0.8.4`

## 命令

```bash
npm install
npm run serve
npm run doctor
npm run check
npm run benchmark
npm run stability
```

Linux 部署推荐使用仓库内的专用镜像：

```bash
docker compose build hyperframes-renderer
docker compose up -d hyperframes-renderer api
docker compose exec hyperframes-renderer npm run doctor
```

镜像固定 Node.js 22、FFmpeg、CJK 字体与 HyperFrames 管理的 Chrome，并通过共享的
`/app/data`、`/app/output` 与 API 交换项目和成片。渲染服务不作为 API 的启动依赖；即使
它不可用，原生图片 + HTML 生产仍能运行，已开启 `fallback_to_native` 的频道会自动接管。

生产任务会按需自动启动服务；`npm run serve` 仅用于独立调试。服务默认只监听 `127.0.0.1:8788`。接口包括 `POST /renders`、`GET /renders/:id`、`POST /renders/:id/cancel` 和 `GET /ready`；API 自动启动时会把可变任务状态写入忽略 Git 的 `data/hyperframes-renderer-runtime/`，与独立调试服务隔离。状态文件使用唯一临时文件、Windows 重命名重试及安全的原地写入回退，避免索引器或杀毒软件短暂锁定状态文件导致视频渲染失败；服务重启时未完成任务会转为可安全重试的明确失败状态。可通过 `HYPERFRAMES_PROJECTS_ROOT` 限制允许读取的项目根目录。Windows 默认一次只运行一个渲染任务、每任务一个 worker，并用 `auto` 探测浏览器 GPU；硬件可用时启用流式捕获以降低临时磁盘与内存压力，不可用时自动回退软件模式。其他平台默认不限任务并发、每任务最多两个 worker。可用正整数 `HYPERFRAMES_MAX_CONCURRENT` 和请求中的 `workers` 显式覆盖，也可用 `PRODUCER_BROWSER_GPU_MODE=software` 强制确定性软件渲染。`PIXELLE_HYPERFRAMES_AUTOSTART=false` 可关闭自动启动。

`benchmark` 会先检查火柴人心理学验证项目，再执行一次草稿渲染；`stability` 使用同一个 `HYPERFRAMES_RUN_ID` 连续执行 20 次。两者都会校验尺寸、帧率、编码和 100ms 时长误差，并将单轮耗时、进程树峰值内存、残留浏览器进程和输出大小写入 `benchmark-results/`。生成目录不提交 Git。

`.github/workflows/hyperframes-linux.yml` 在 Ubuntu 24.04 上安装 HyperFrames 管理的
`chrome-headless-shell`，执行 20 次连续渲染，并由 `npm run verify:linux` 强制校验运行平台、
浏览器类型、版本、输出数量、时长和浏览器进程残留。报告与 MP4 会保留为 7 天的 Actions
构建产物；任一轮失败都会阻断门禁。

macOS 基准会自动复用 `/Applications/Google Chrome.app`，避免首次运行下载独立浏览器；其他环境可显式设置 `HYPERFRAMES_BROWSER_PATH`。普通 Chrome 会走截图捕获路径，正式性能门禁仍应在部署环境使用 `chrome-headless-shell` 重跑。

2026-08-19 首次基准：1080×1920、30fps、H.264、8.000 秒，草稿文件 1,054,862 字节，检查与渲染总耗时 23.323 秒。基准产物默认忽略，不进入 Git。

同日 macOS 20 次稳定性基准全部通过：平均渲染 13.421 秒，P95 13.971 秒，进程树峰值 1,799.2 MB；每次输出均为 8.000 秒且结束后无浏览器残留。

2026-08-20 的 [Ubuntu 24.04 Actions 门禁](https://github.com/HuFakai/Pixelle-Video/actions/runs/32362924170) 也已通过：管理的 `chrome-headless-shell 152.0.7977.42` 连续渲染 20/20 成功，平均 17.984 秒、P95 18.198 秒、进程树峰值 1,516.6 MB；所有 MP4 均为 H.264、1080×1920、30fps、8.000 秒，结束后浏览器 worker 增量为 0。

单频道 20 条真实生产灰度使用独立脚本，报告会持续原子写入
`data/gray-tests/`，中断后仍能核对已提交任务：

```bash
uv run python scripts/run_channel_gray_test.py \
  --channel stickman_psychology \
  --engine hyperframes \
  --count 20 \
  --max-in-flight 1 \
  --require-engine \
  --no-allow-native-fallback
```

正式连续生产建议不加 `--require-engine` 并保留原生回退；独立验收 HyperFrames 时才关闭
回退，以避免把原生接管误记为 HyperFrames 通过。

阶段状态与后续模板计划见：`docs/roadmap/2026-08-19-image-html-video-plan.md`。
