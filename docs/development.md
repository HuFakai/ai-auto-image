# 开发文档：环境配置与启动指南

> 本文按当前代码（2026-08-31）编写。当前生产数据库已经是 PostgreSQL；无 `DATABASE_URL` 的本地/测试运行时使用进程内 PGlite，早期文档中的 SQLite 说明不再适用于当前运行时。
> 产品状态与待办见 [current-status.md](./current-status.md)，当前开发顺序见 [current-roadmap.md](./current-roadmap.md)。

## 1. 环境要求

| 依赖 | 版本 | 说明 |
|---|---|---|
| Node.js | 22+ | 与 Dockerfile 的 node:22-alpine 对齐 |
| pnpm | 11+ | 根目录 `package.json` 固定 package manager 为 pnpm 11.8 |
| Docker | 服务器需要 | 本轮审查机未安装，目标服务器按部署手册验证 |

## 2. 本地快速启动

```bash
pnpm install
cp .env.example .env
pnpm dev
```

默认打开 `http://localhost:1235`。如果 `.env` 中设置了其他 `PORT`，以该端口为准。

当前运行时行为：

- 未设置 `DATABASE_URL`：使用进程内 PGlite；当前 Web runtime 不把 PGlite 数据库句柄持久化到 `DATA_DIR`，适合本地快速试验和测试。
- 设置 `DATABASE_URL`：使用 `postgres.js` 连接远程 PostgreSQL，启动时自动执行 `packages/storage/drizzle/` 中的迁移。
- 未配置真实文本/图片渠道：可使用 Mock Provider 完成零费用占位图卡流程。
- 新建、重试和单页重生统一由图片模型直接生成包含中文的最终图片；项目不再提供确定性正文排版开关。文本和图片模型仅服从后台渠道级并发配置，默认 `0` 不限制。
- 失败作品可通过 `POST /api/runs/{id}/retry` 选择 `checkpoint` 或 `restart`：前者复用已成功节点和资产，后者创建一条新作品；失败页面可通过 `POST /api/runs/{id}/pages/{index}/regenerate` 只重试该页。

首次打开应用后，可在 Studio 的渠道设置中分别配置文本和图片渠道；Brand Kit、计费和支付配置分别由设置页/管理后台维护。

## 3. 环境变量

完整模板见根目录 `.env.example`。常用配置如下：

| 变量 | 用途 |
|---|---|
| `DATABASE_URL` | 生产/远程开发 PostgreSQL 连接串；Docker 中必填 |
| `REDIS_URL` | Redis 预留配置；当前进程内 Runner 不依赖它 |
| `APP_SECRET` | 渠道密钥 AES-256-GCM 加密主密钥；生产必须固定并妥善保管 |
| `REGISTER_ENABLED` / `REGISTER_INVITE_CODE` | 注册开关与邀请码 |
| `TEXT_*` / `IMAGE_*` | 首次启动自动导入的文本/图片渠道配置 |
| `OPENAI_API_KEY` / `XAI_API_KEY` | 官方 Provider 备用密钥；当前首启自动导入建议仍使用显式 `TEXT_*` / `IMAGE_*` |
| `DATA_DIR` / `ASSETS_DIR` / `EXPORTS_DIR` | 运行时数据、生成资产和导出文件目录 |
| `STARTER_CREDITS` | 新用户初始点数 |
| `PAY_NOTIFY_BASE_URL` 及支付变量 | 支付宝/微信支付预下单、验签和回调 |

文本和图片模型不再读取全局并发环境变量。唯一的模型限流入口位于“管理后台 → 模型渠道 → 模型调用并发上限”：默认值 `0` 表示不限制，正整数表示该渠道在所有用户、所有任务之间共享的并发上限。文本生成、图片生成、图生图、封面、返修和发布文案都会服从同一渠道配置。

## 4. 常用命令

```bash
pnpm dev
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm eval
pnpm db:migrate
pnpm db:seed
pnpm verify:live
pnpm verify:openai
pnpm verify:xai
```

说明：

- `pnpm db:migrate` 在没有 `DATABASE_URL` 时只对本次进程内 PGlite 执行迁移并退出，不会产生当前 Web runtime 可复用的本地 SQLite 文件。
- `verify:openai` / `verify:xai` 会产生真实模型费用，必须先确认密钥、模型、预算和输出目录。
- `pg:export` / `pg:import` 是旧 SQLite → PostgreSQL 数据导入工具，现已按当前 22 张表维护白名单、记录源库缺表并校验 JSONL 校验和；它仍不是 PostgreSQL 正式备份方案，生产备份优先使用 PG 原生备份。

## 5. 当前代码结构

```text
apps/web/                  Next.js Studio、API、登录、计费与进程内 Runner
packages/shared-schemas/   Brief、Storyboard、Recipe、渲染和状态 Schema
packages/ai-core/          Provider 接口、路由回退、错误归一、信号量
packages/provider-openai/  OpenAI-compatible Wire 与官方 OpenAI 适配
packages/provider-xai/     xAI/Grok 适配
packages/provider-compatible/ 自定义兼容端点
packages/provider-mock/    零费用 Mock Provider
packages/workflow-engine/  知识卡片/漫画/封面/返修/导出管线与 Job Runner
packages/render-engine/    原生图片资产处理、品牌水印/签名叠加
packages/storage/          Drizzle PostgreSQL 方言、PGlite/远程 PG、Repository、迁移
packages/config/           共享 TypeScript 配置
infra/                     Dockerfile、生产 Compose、部署验证脚本
scripts/                   迁移、种子、真实调用和评测脚本
fixtures/                  评测输入与报告
docs/                      当前状态、路线图、部署手册和设计基线
```

## 6. 数据与资产目录

生产 Docker 容器中的目录约定：

```text
/data/
  ├─ assets/       生成图片、定妆图、返修版本等
  ├─ exports/      ZIP、manifest 和发布清单
  └─ .secret       未配置 APP_SECRET 时的本地密钥文件（生产不建议依赖）
```

生产业务表位于外部 PostgreSQL，不在 `/data/db/app.db` 中。`/data` 仍必须使用持久卷并备份，因为资产、导出文件和可能的密钥文件都在其中。

资产写入采用 `.part` 临时文件、魔数/非空校验、SHA-256 和原子重命名；运行重启后 Job Runner 会从数据库恢复未完成作业，已成功节点按幂等语义跳过。

失败恢复使用新 Job，不修改已经失败的旧 Job。检查点恢复会清除 Run 的失败摘要并重新执行缺失节点；图片页成功后会再次检查所有页面，只有页面齐全才恢复为成功。用户主动重试产生的真实模型调用按现有计费规则处理，复用的已完成节点不会重复生成。

## 7. 浏览器、Playwright 与视觉测试的边界

当前生产镜像**不包含** Chromium、Playwright 或测试依赖，图文生成不需要常驻浏览器，因此不会因为浏览器测试额外占用服务器内存。

浏览器/视觉测试的作用是另一层质量保障：启动临时浏览器访问真实页面，验证登录、创作表单、生成详情、图片预览、下载和响应式布局是否能被用户正常操作；截图或 OCR/视觉比对可发现“代码构建通过但页面错位、按钮不可点、图片不显示”的问题。它适合在 CI 或开发机按需执行，不应作为生产服务常驻进程。

当前仓库本轮审查未执行浏览器视觉测试；该项属于后续质量波次，不是当前 Docker 运行前置条件。

## 8. 当前验证基线

截至本轮修复：

- `pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm build` 均通过。
- `pnpm eval` 通过（Mock 12 个用例、48 页；结构化解析和页面渲染指标均达到阈值）。
- storage、Web 的 PGlite/计费集成测试已配置合理默认超时；全仓测试 19/19 个任务通过。
- 支付 mock 生产硬关闭、额度预留/结算/释放、重复节点结算保护和当前 22 张表迁移工具已纳入代码与测试。

不要把上述状态写成“全仓测试全绿”，发布门禁以 [current-status.md](./current-status.md) 为准。

## 9. 生产部署入口

```bash
docker compose --env-file .env -f infra/docker-compose.yml up -d --build
docker compose --env-file .env -f infra/docker-compose.yml logs -f app
curl http://127.0.0.1:1235/api/health
```

生产部署、外部 PostgreSQL/Redis、1Panel 反代、HTTPS、备份和安全检查见 [deployment.md](./deployment.md)。
