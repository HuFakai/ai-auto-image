# ADR-0004：持久化布局 — `/data` 持久卷与原子落盘

状态：已接受（2026-08-29；文件布局决策仍有效，SQLite 数据库部分已被当前实现替代）

> 演进说明（2026-08-31）：生产业务数据已经迁移到外部 PostgreSQL。 `/data` 现在主要持久化生成资产、导出包和运行密钥文件；本地运行时无 `DATABASE_URL` 使用进程内 PGlite，不再把 `/data/db/app.db` 视为生产数据库。

## 背景

单台 Linux 服务器、Docker 单容器部署需要保证容器重建后资产和导出文件仍然存在。数据库、模型调用和文件资产的生命周期不同，不能把所有数据都假设为同一个本地文件。

## 决策

1. 生产目录布局：

```text
/data
  ├─ assets/       生成与合成图片（runs/{runId}/pages/...）
  ├─ exports/      导出包与 manifest（{runId}/manifest.json）
  └─ .secret       未配置 APP_SECRET 时的本地密钥文件（生产应优先显式配置 APP_SECRET）
```

2. 生产 PostgreSQL 数据由数据库服务自身持久化和备份；不把 PostgreSQL 数据目录映射到 Web 容器的 `/data`。
3. 文件落盘三原则：先写 `.part` 临时文件 → 校验（非空 + PNG/JPEG/WebP/GIF 魔数）→ 原子 `rename`；远程下载用流式管道 + 逐块 SHA-256，中断文件不会看起来完整。
4. 迁移文件进入版本控制（`packages/storage/drizzle/`），应用启动和 `pnpm db:migrate` 都执行迁移；健康检查 `/api/health` 触发真实 DB 读取。
5. 生产镜像使用 standalone 运行文件、静态资源、迁移 SQL 和中文字体；非 root 用户运行；健康检查使用 Node 内置 fetch。
6. 备份分开处理：PostgreSQL 使用原生备份/1Panel 备份，`/data` 使用 Docker volume 备份；恢复演练必须同时验证业务表、资产和导出包。

## 后果

- 字体通过 `FONT_DIR` 注入，与源码布局解耦。
- 本地无 `DATABASE_URL` 的 PGlite 运行适合测试和快速试验；需要可复用本地业务数据时，应使用开发 PostgreSQL 或显式设计 PGlite 持久化，而不是假设存在 SQLite 文件。
- 资产路径保持相对 `/data`，未来迁移到 S3/R2 只替换 AssetStore 实现，不改变资产血缘和版本语义。
