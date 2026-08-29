# Pixelle Video · Grok 持续短视频生产台

这是一个针对 `grok2api` 改造的短视频生产系统：用 Grok 生成脚本、图像和视频，Edge TTS 生成旁白，FFmpeg 完成字幕与合成，并由耐久 Runner 按栏目库存水位持续补货。

当前主链路只保留：

- LLM：OpenAI 兼容接口（当前使用 Grok 4.5）
- 图像：`grok-imagine-image-quality`
- 视频：`grok-imagine-video`
- 配音：Edge TTS
- 编排：FastAPI 异步任务 + SQLite 生产台账 + 可恢复 Runner
- 前端：Next.js 生产控制台

ComfyUI、RunningHub、数字人口播和动作迁移已从运行时、界面、依赖及工作流目录移除。

## 快速启动

### Windows 小白一键启动

64 位 Windows 10 / 11 用户可直接双击项目根目录的 `Windows一键启动.bat`。脚本会从空白电脑开始检测并安装 Python 3.11+、Node.js 22+、FFmpeg、虚拟环境、全部项目依赖和 Playwright Chromium，并在多个国内镜像之间自动重试，最后启动 API 与网页控制台。

首次使用和故障排查见 [Windows 一键启动说明](Windows一键启动说明.md)。持续生产 Runner 由 API 托管，在网页控制台顶部直接开关；为避免意外产生模型费用，首次使用时默认关闭。需停止 Windows 后台服务时，双击 `Windows一键关闭.bat`。

### macOS / Linux / 手工启动

准备环境与配置：

```bash
uv sync --extra dev
cp config.example.yaml config.yaml
```

首次可在 `config.yaml` 中填写模型渠道，也可以先启动 API 与生产台，再打开 `http://127.0.0.1:13123/settings` 完成配置。设置页支持多个 OpenAI-compatible / grok2api 渠道，并可分别选择文字、图片、视频模型。真实密钥只写入本地配置，不会返回浏览器或提交到 Git。

启动 API：

```bash
uv run python api/app.py --host 127.0.0.1 --port 18123
```

启动新生产台：

```bash
cd studio
cp .env.example .env.local
npm install
npm run dev
```

打开 `http://127.0.0.1:13123`。生产台默认读取 `http://127.0.0.1:18123`，可通过 `PIXELLE_API_URL` 修改。持续生产 Runner 不需单独的终端，由控制台顶部开关管理。生产台支持频道创建/复制/参数热更新、暂停/恢复、测试样片、队列取消/重试、成片审核与标记发布，以及带影响预检的安全删除。右上角“模型与系统设置”进入独立设置页。

设置页提供：

- 多渠道 Base URL、API Key、API 格式、代理、超时、轮询和恢复目录；
- 通过只读 `/models` 请求测试连接并导入模型目录；
- 文字、图片、视频三条独立模型路由；
- Edge TTS、默认模板、全局提示词和显式网络代理。

新频道默认跟随设置页的视频路由，并在任务创建时冻结具体渠道与模型；已有任务不会因后续切换而改变。已有频道若固定了 `api/<channel>/<model>`，仍优先使用其固定模型。

## 栏目与连续生产

Runner 配置位于：

- `production/runner.yaml`：轮询、租约、数据库和 API 地址
- `production/channels/*.yaml`：每个栏目的选题策略、日产量、库存目标与视频参数

当前频道包括每日早安电台、一分钟科普、火柴人心理学、中国古诗词，以及默认停用、通过测试后再开放的少儿寓言故事。Runner 使用单实例租约、幂等提交、失败重试、连续失败熔断和 Grok request ID 持久化，意外重启后可继续执行。

## 常用接口

- `GET /health`：API 健康状态
- `GET /ready`：数据库、磁盘、FFmpeg、配置和备份就绪检查
- `POST /api/video/generate/async`：提交视频任务
- `GET /api/tasks/{task_id}`：查询视频任务
- `GET /api/production/status`：栏目库存总览
- `GET /api/production/jobs`：生产任务列表
- `GET /api/production/library/videos`：成片审核库
- `GET /api/production/events`：生产状态 SSE
- `GET/PUT /api/settings`：读取或原子保存脱敏后的模型与系统设置
- `POST /api/settings/models/test`：通过非生成式 `/models` 请求测试渠道
- `POST/PATCH /api/production/channels`：创建或修改频道
- `POST /api/production/jobs/{id}/approve|reject|retry|cancel`：安全操作
- `POST /api/production/channels/{id}/publish`：标记库存已发布
- `GET/DELETE /api/production/deletions/{resource}/{id}`：预检并删除视频或关联资源

完整接口可在 API 启动后访问 `http://127.0.0.1:18123/docs`。

## 验证

```bash
uv run pytest -q
cd studio && npm run lint && npm run build
```

更多说明见 [Grok 接入](docs/GROK2API.md)、[持续生产 Runner](docs/PRODUCTION_RUNNER.md)、[运维与备份](docs/OPERATIONS.md) 和 [升级路线图](docs/roadmap/2026-08-12-studio-upgrade/README.md)。

## 本地提交策略

本次改造使用主题分支 `refactor/grok-only-core`，按核心精简、生产 API、前端创作台和文档分别提交。仓库不会自动推送到远端。

Apache-2.0 License。
