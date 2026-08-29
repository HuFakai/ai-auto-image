# 开发文档：环境配置与启动指南

> 本文档说明如何在本地与服务器上配置、启动和验证 AI Auto Image 项目（阶段 0）。
> 架构与阶段规划见 [总体规划](./02-master-development-plan.md) 与 [基础框架方案](./04-ai-image-framework-solution.md)。

## 1. 环境要求

| 依赖 | 版本 | 说明 |
|---|---|---|
| Node.js | ≥ 22（推荐 24） | 本地开发与生产运行 |
| pnpm | ≥ 10（推荐 11） | 包管理，`corepack enable` 可自动获取 |
| Docker | 可选 | 仅服务器部署需要 |

## 2. 快速启动（本地开发）

```bash
# 1. 安装依赖（workspace 全量安装）
pnpm install

# 2. 配置环境变量（模型渠道密钥）
cp .env.example .env
#    然后编辑 .env，填入 TEXT_* / IMAGE_* 渠道配置（见第 3 节）

# 3. 下载中文字体（确定性渲染兜底需要，OFL 许可，不入 Git）
pnpm fonts

# 4. 初始化数据库（SQLite，WAL 模式，10 张表）
pnpm db:migrate
#    可选：插入种子数据
pnpm db:seed

# 5. 启动开发服务器（Next.js + 进程内 Job Runner）
pnpm dev
#    打开 http://localhost:3000
```

启动后即可在 Studio 页面输入主题生成成套图文：

- 输入主题 → 选择比例 / 文字模式 / 并发 → 「生成整套图文」。
- 运行详情页实时展示节点进度、逐页显影、Token 与费用账本。
- 未配置任何真实渠道时自动使用 Mock Provider（占位图卡，零费用）。

## 3. 模型渠道配置

渠道在 **Studio「渠道设置」页**（`/settings`）管理，不再依赖环境变量：

- **文本与图片渠道分离配置**，各自支持添加多个，按顺序优先、失败逐个回退。
- 密钥使用 AES-256-GCM 加密落库（主密钥来自 `APP_SECRET` 环境变量；未设置时自动生成并
  持久化在 `DATA_DIR/.secret`），界面只显示末四位。
- 每个渠道支持：启停、排序（↑↓，越靠前越优先）、编辑（密钥留空表示不变）、删除、
  连通性测试（只读 `GET /models`，无模型调用费用）。
- 图片渠道可按网关配置参数风格：`aspect_ratio`（grok2api）或 `size`（OpenAI 官方）、
  返回格式 `b64_json` / `url`、可选分辨率透传。
- 保存立即生效，无需重启；正在运行的任务继续使用启动时的渠道。
- API：`GET/POST /api/channels`、`PATCH/DELETE /api/channels/:id`、
  `POST /api/channels/:id/test`、`POST /api/channels/reorder`。

### 3.1 环境变量的角色

- **自动导入**：首次启动时若渠道表为空且 `.env` 中有 `TEXT_* / IMAGE_*` 配置，
  会自动导入为两条渠道（名称带「自动导入」标记）。之后删除该渠道请同时清理 `.env`，
  否则重启会再次导入。
- **回退**：某侧未配置任何启用渠道时，该侧自动使用 Mock Provider（占位图卡，零费用）；
  配置了真实渠道的侧**不会混入 Mock**，真实调用失败不会被静默降级。
- `OPENAI_API_KEY` / `XAI_API_KEY` 为整体渠道备选，优先级低于设置页渠道。

### 3.2 已验证的网关差异（内建支持）

| 网关行为 | 处理方式 |
|---|---|
| WAF 拦截 `OpenAI/JS` User-Agent（403） | Wire 客户端固定 UA 为 `ai-auto-image/0.1` |
| 图片参数用 `aspect_ratio` 而非 `size` | 渠道配置「比例参数风格 = aspect_ratio」 |
| 响应格式需显式声明 | 渠道配置「返回格式 = b64_json」 |
| 图片 URL 需要鉴权才能下载 | 用 `b64_json` 绕开；`url` 模式会立即流式转存 |
| 推理模型消耗 reasoning token 导致空响应 | 结构化输出默认 `max_tokens=8192`，空响应按可重试错误指数退避 |
| LLM 输出 1-based 页码 | Storyboard 生成后统一归一化为 0-based |

## 4. 常用命令

```bash
pnpm dev             # 开发服务器（Next.js + 进程内 Job Runner）
pnpm build           # 全仓构建（含 Next.js standalone 产物）
pnpm typecheck       # 全仓类型检查
pnpm test            # 全仓测试（vitest，65 项：单测 + 集成）
pnpm lint            # ESLint（仓库根统一执行）

pnpm fonts           # 下载中文字体（Noto Sans SC，OFL）
pnpm db:migrate      # 创建/更新 SQLite 表结构
pnpm db:seed         # 插入种子数据（演示项目 + Prompt 版本）

pnpm eval            # 评测：6 用例双模式（Mock 零费用），输出解析/渲染成功率指标
pnpm verify:live     # 真实渠道验证：Storyboard → 原生中文出图 → 转存 → 报告
pnpm verify:openai   # OpenAI 官方渠道验证（需 OPENAI_API_KEY）
pnpm verify:xai      # xAI/Grok 官方渠道验证（需 XAI_API_KEY）

bash infra/verify-deployment.sh   # 服务器部署验证（见 docs/deployment-checklist.md）
```

验证报告输出到 `fixtures/reports/*.json`，验证图片输出到 `data/assets/verify/`。

## 5. 数据与资产目录

运行时数据默认在 `apps/web/data/`（`DATA_DIR=./data` 相对于运行目录）：

```text
apps/web/data/
  ├─ db/app.db        SQLite（WAL）；10 张表迁移由 drizzle 管理
  ├─ assets/          生成图片（runs/{runId}/pages/page-N.png）
  └─ exports/         导出清单（{runId}/manifest.json，含预期文案与用量）
```

重启安全：应用重启后 Job Runner 从 `jobs` 表恢复未完成任务，已成功页面不会重新生成
（Runner 对运行中任务自动心跳续租，慢推理调用不会被误判为孤儿）。
**运行中取消**：详情页「作废本次运行」即时中断进行中的模型调用（signal 贯穿到 HTTP 层，
取消不触发重试，已成功页面保留）。
**单页返修**：详情页每页可改标题/正文——native 模式重新出图（提示费用），
deterministic 模式「重新排版」零费用；旧版本资产保留（Revision 版本链），返修后回到待审。
**导出 ZIP**：详情页「导出 ZIP」产出按序图片 + LLM 生成的发布文案（失败降级模板）+ manifest + 发布清单。
**长文/URL**：创建表单支持粘贴参考资料（按要点密度拆为 6–10 页）与 URL 导入（实验能力，失败降级粘贴）。
**评审**：运行完成后可标记通过/驳回，工作台按评审状态筛选。

## 6. 生产部署

生产部署步骤与阶段 0 验收基准见 [docs/deployment-checklist.md](./deployment-checklist.md)；
服务器上执行 `bash infra/verify-deployment.sh` 可一键完成部署断言并输出报告。

### 6.1 本机 standalone 运行

```bash
pnpm build
DATA_DIR=/绝对路径/data PORT=3000 \
  node apps/web/.next/standalone/apps/web/server.js
```

### 6.2 Docker（单容器，目标环境 1 vCPU / 1GB RAM）

```bash
cd infra
docker compose up -d
docker compose logs -f app
curl http://localhost:3000/api/health
```

- 多阶段构建，镜像不含 Chromium / Playwright / 测试依赖；非 root 运行。
- `/data` 持久卷（SQLite + 资产 + 导出），容器重建数据不丢。
- 内置健康检查与 1GB 内存限制；并发默认 1、上限 4（`IMAGE_GENERATION_CONCURRENCY_MAX`）。
- 密钥通过 compose 的 `${OPENAI_API_KEY}` 等注入；使用 `TEXT_* / IMAGE_*` 时在
  `infra/docker-compose.yml` 的 `environment` 段补充对应变量。

## 7. 项目结构

```text
apps/web/                  Next.js Studio（暗房风格 UI）+ API + 进程内 Runner
packages/
  shared-schemas/          Zod Schema：Brief / Storyboard / 并发 / 错误分类 / 状态机
  ai-core/                 Provider 接口、多路由回退、错误归一、并发信号量
  provider-openai/         通用 OpenAI-compatible Wire 实现（含 grok2api 差异参数）
  provider-xai/            xAI/Grok 官方端点适配
  provider-compatible/     自定义兼容端点（能力显式声明）
  provider-mock/           Mock Provider（占位图卡、可注入失败）
  workflow-engine/         Job Runner（租约/恢复/幂等）+ 知识卡片流水线
  render-engine/           原生资产处理链 + Satori/Sharp 确定性渲染（兜底）
  storage/                 Drizzle + SQLite（10 表）+ Repository + 原子落盘
  config/                  共享 tsconfig
infra/                     Dockerfile + docker-compose
scripts/                   字体下载、迁移、种子、真实调用验证
docs/adr/                  架构决策记录（模型层 / 作业 / 渲染 / 持久化 / 迁移）
fixtures/                  评测输入与验证报告
```

## 8. 测试

```bash
pnpm test    # 58 项：Schema 校验、错误归一、路由回退、并发信号量、
             # 结构化解析、原子落盘、Job 生命周期、
             # 集成（Mock 全流程 / 单页重试 / 重启恢复 / 取消）、确定性渲染
```

关键集成场景（无需真实 Key，CI 可跑）：

- Mock 全流程 DAG：brief → storyboard → 4 页并行 → manifest。
- 单页失败仅重试该页，其余页面不重新生成。
- 应用中断后从 `jobs` 表恢复任务（`orphan_recovered` → 继续执行）。
- 幂等键复用、取消语义、资产 `.part` 原子写、路径逃逸防护。

## 9. 常见问题

| 现象 | 原因与处理 |
|---|---|
| 文本/图片调用 403 | 网关 WAF 拦截 SDK UA；已内建覆盖 UA，若仍 403 检查密钥与来源 IP 白名单 |
| 文本返回空内容 | 推理模型耗尽输出预算；已默认 `max_tokens=8192` 并按可重试错误退避 |
| 确定性渲染报「Chinese fonts not found」 | 运行 `pnpm fonts` 下载字体（原生模式不需要字体） |
| 页面一直「排队中」 | Job Runner 未启动（查启动日志 `job runner started`）；或并发被占满 |
| 单页显示「生成失败」 | 任务会自动重试该页；也可在详情页观察 `errorSummary` 与 `provider_attempts` |
| 数据想换位置 | 设置 `DATA_DIR`（或 `SQLITE_PATH / ASSETS_DIR / EXPORTS_DIR`）后重启 |
| 改了渠道配置不生效 | Runtime 单例在进程内缓存，重启 dev server 生效 |

## 10. 当前边界（阶段 0）

- 单机单容器 + SQLite + 进程内 Runner；PostgreSQL / Redis / 独立 Worker 到阶段 3（见 [ADR-0005](./adr/0005-migration-to-postgres-redis.md)）。
- 仅知识卡片 Recipe；商品带货/文章拆解等独立 Recipe 在后续迭代（密度拆页与上传能力已就绪）。
- 原生模式文字审查需 `TEXT_VISION=1`（视觉模型）；当前渠道的 deepseek-v4-flash 不支持图片输入，审查自动跳过并记录。
- 无自动发布；导出为 ZIP/manifest 由阶段 1 交付。
