# 运维、备份与长期运行

## 日常检查

`/health` 只用于进程存活检查。`/ready` 还会检查频道配置、SQLite `quick_check`、可用磁盘、FFmpeg/FFprobe 和最近备份。没有备份或备份过旧只产生 `warn`；数据库、磁盘、配置或媒体工具异常会返回 HTTP 503。

```bash
uv run python scripts/production_ops.py check
curl -fsS http://127.0.0.1:18123/ready
```

## 一致性备份

备份使用 SQLite Online Backup API，不需停止 Runner。每个备份包含 `production.db`、Runner 配置、所有频道 YAML 和 `config.yaml`；目录权限为 `0700`，文件为 `0600`。`manifest.json` 记录大小和 SHA-256。由于备份包含 API Key，不要同步到公开仓库。

```bash
uv run python scripts/production_ops.py backup
uv run python scripts/production_ops.py verify data/backups/pixelle-<timestamp>-<id>
```

备份成功后会立即自验。默认不自动删除旧备份，避免静默数据丢失；可根据磁盘告警人工转存和清理。

## Webhook 通知

在 `production/runner.yaml` 设置 `notifications.enabled: true` 和 `webhook_url`后，Runner 可发送 `job_ready`、`job_failed`、`channel_circuit_open` 和 `runner_error`。事件会先写入 SQLite，再发送；`event_key` 防止进程重启后重复通知，失败最多尝试 5 次。

如接收端需要 Bearer Token，在 Runner 进程环境设置 `PIXELLE_NOTIFICATION_WEBHOOK_TOKEN`，不要把 Token 写入频道文件或 Git。通知默认关闭，因此开发和测试不会产生外部请求。

## macOS LaunchAgent

先完成依赖、Studio 构建和本地备份：

```bash
uv sync
cd studio && npm install && npm run build && cd ..
uv run python scripts/production_ops.py backup
uv run python scripts/render_launchd.py
```

命令在 `data/launchd/` 生成 API、Runner、Studio 和每日 03:10 备份的 plist，日志写入 `data/logs/`。检查生成内容后，手动复制到 `~/Library/LaunchAgents/` 并用 `launchctl bootstrap gui/$(id -u) <plist>` 加载。生成器不会自动安装或替换系统服务。

当前上游 Client Key 尚不支持已配置的视频模型，在单条视频冒烟测试成功前，保持所有频道手动暂停。LaunchAgent 可以先运行 API/Studio，但不应恢复自动补产。
