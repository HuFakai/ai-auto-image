# ADR-0004：持久化布局 — 单容器 + /data 持久卷 + 原子落盘

状态：已接受（2026-08-29）

## 背景

单台 Linux 服务器、Docker 单容器部署（docs/02 §5.3），SQLite、资产、导出文件
必须存活于容器重建。

## 决策

1. 目录布局：

```text
/data
  ├─ db/app.db        SQLite（WAL）
  ├─ assets/          生成与合成图片（runs/{runId}/pages/...）
  └─ exports/         导出包与 manifest（{runId}/manifest.json）
```

2. SQLite PRAGMA：`journal_mode=WAL`、`foreign_keys=ON`、`busy_timeout=5000`；
   写事务保持短事务，模型调用与图片下载绝不占用数据库事务。
3. 文件落盘三原则：先写 `.part` 临时文件 → 校验（非空 + PNG/JPEG/WebP/GIF 魔数）→
   原子 `rename`；远程下载用流式管道 + 逐块 SHA-256，中断文件不会看起来完整。
4. 迁移进版本控制（`packages/storage/drizzle/`），容器启动与 `pnpm db:migrate` 都执行
   `migrate()`；健康检查 `/api/health` 触发真实 DB 读取。
5. 生产镜像（node:22-alpine）只含 standalone 运行文件、静态资源、迁移 SQL 与中文字体；
   非 root 用户运行；`HEALTHCHECK` 用 node 内置 fetch 探测。
6. 备份策略：服务器 cron 对 `/data` 定期备份，备份前执行 `wal_checkpoint(TRUNCATE)`
   （关闭连接时也会自动执行）。

## 后果

- 字体通过 `FONT_DIR` 环境变量注入（`/app/fonts`），与源码布局解耦。
- 磁盘阈值与自动清理延后到阶段 1；阶段 0 只保证「不删除用户资产」。
- SQLite 数据库单文件，迁移 PostgreSQL 时可用 dump → 导入管道（ADR-0005）。
