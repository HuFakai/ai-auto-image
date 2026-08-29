# grok2api 接入指南

本 Fork 原生支持以下模型：

| 能力 | 工作流键 |
|---|---|
| 图片生成/编辑 | `api/grok/grok-imagine-image` |
| 高质量图片生成/编辑 | `api/grok/grok-imagine-image-quality` |
| 文生、首帧图生、参考图视频 | `api/grok/grok-imagine-video` |

## 配置

推荐启动 FastAPI 和 Next.js 生产台后，打开 `http://127.0.0.1:13123/settings`，新增或编辑一个 `grok2api` 渠道：

- `Grok API Key`：grok2api 发放的访问密钥；
- `grok2api Base URL`：可以是站点根地址，也可以以 `/v1` 结尾；
- `Grok 任务存储目录`：默认 `data/grok_jobs`；
- 是否使用公共本地代理；
- 分别登记并选择文字、图片和视频模型。

“测试 /models”只读取模型目录，不会触发文字、图片或视频生成。保存使用原子替换并把 `config.yaml` 权限设为 `0600`；API Key 不会从后端返回浏览器，输入框留空会保留已保存密钥。

也可以复制 `config.example.yaml` 为 `config.yaml` 后编辑：

```yaml
model_settings:
  channels:
    grok:
      name: "Grok / grok2api"
      api_format: "grok2api"
      base_url: "https://你的-grok2api-地址/v1"
      api_key: "你的 Key"
      enabled: true
      use_proxy: false
      user_agent: "python-httpx/0.28.1"
      models:
        text: ["grok-4.5"]
        image: ["grok-imagine-image-quality"]
        video: ["grok-imagine-video"]
      job_store_dir: "data/model_jobs/grok"
      request_timeout: 300
      poll_interval: 5
      poll_timeout: 1800
      retry_count: 3
  routing:
    text: {channel_id: "grok", model: "grok-4.5"}
    image: {channel_id: "grok", model: "grok-imagine-image-quality"}
    video: {channel_id: "grok", model: "grok-imagine-video"}

runtime:
  local_proxy: ""
  print_model_input: false
```

`config.yaml` 已被 `.gitignore` 排除，不要提交密钥。

## 使用 Grok 媒体模型

1. 启动 API 与生产台，进入 `/settings`。
2. 保存 grok2api 渠道，并分别激活三个模型路由。
3. 频道媒体模型选择“跟随设置页默认视频模型”；也可保留固定工作流。
4. 新任务创建时会把当前路由冻结为具体 `api/<channel>/<model>`，保证可复现。

图片编辑和图生视频会将本地图片编码为 Data URL，并按照 grok2api 的对象协议发送：`{"url": "..."}`。参考图视频使用对象数组 `reference_images`。

## 中断恢复

`grok-imagine-video` 是异步接口。Provider 会按以下顺序工作：

1. 提交 `POST /v1/videos/generations`；
2. 将返回的 `request_id` 原子写入频道配置的 `job_store_dir/<job_key>.json`；
3. 轮询 `GET /v1/videos/{request_id}`；
4. 完成后原子下载 `/v1/videos/{request_id}/content`；
5. 将 job 标记为 `completed`。

若进程在第 2–4 步退出，执行：

```bash
uv run python scripts/resume_grok_jobs.py
```

恢复命令会遍历设置页中所有已启用的 `grok2api` 渠道，并扫描各自恢复目录里已经取得 `request_id` 的非终态任务，继续轮询和下载，不再次调用创建接口。命令会输出带 `channel_id` 的 JSON 结果；任一任务恢复失败时退出码为 1，方便 systemd、Docker healthcheck 或其他调度器识别。

job 文件不会保存 API Key 或 Authorization，也不会保存完整 Base64 图片，只保留请求摘要、素材指纹、输出路径、状态和上游 `request_id`。

## Docker 持久化

若使用 Docker，必须把以下目录挂载到持久卷：

```text
data/model_jobs
output
```

只持久化 `output` 而不持久化 job 目录，会导致重启后无法找到尚未完成的上游 `request_id`。

## 当前恢复边界

- 恢复命令负责已经成功提交到 grok2api 的视频任务。
- 图片调用是同步接口，不需要 `request_id` 恢复。
- Pixelle 顶层 FastAPI 异步任务已经持久化，服务启动时会用同一 `task_id` 自动重新排队；详见 [持久化任务说明](DURABLE_TASKS.md)。
- 持续栏目、库存水位和单机 Runner 租约现已实现，参见 [持续视频生产 Runner](PRODUCTION_RUNNER.md)。
- FastAPI 顶层任务存储仍面向单个 API Worker；不要让多个 API Worker 共享同一个 `data/api_tasks.json`。
- 不要同时在多个进程中对同一个 Grok job 目录运行手动恢复命令；常驻 Production Runner 自身有 SQLite 单实例租约。
