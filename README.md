# AI Auto Image（图文工坊）

根据主题、文案、文章或商品资料自动生成成套可发布图文（小红书 / 抖音 / 微信公众号）。

**当前状态**：阶段 0–4 核心功能已实现并通过真实 API 端到端验证（Monorepo、双 Provider、双文字渲染模式、SQLite 作业、四种 Recipe + 科普漫画、平台草稿 Adapter、开放平台基础）。

## 快速开始（本地开发）

```bash
# 1. 依赖（Node 22+，pnpm 9+）
pnpm install
bash scripts/fetch-fonts.sh   # 下载确定性渲染所需中文字体（~33MB，不入库）

# 2. 配置
cp apps/web/.env.example apps/web/.env.local  # 填入真实 Provider Key

# 3. 启动
pnpm dev                      # http://localhost:3000
```

作业 Runner 在首个 API 请求时懒启动（原生模块限制），重启后的首个请求会自动从 SQLite `jobs` 表恢复未完成任务。

## 生产部署（单机 Docker）

```bash
cd infra
cp ../apps/web/.env.example .env    # 填入真实 Key
docker compose up -d --build
curl http://localhost:3000/api/health
```

- 单容器，SQLite（WAL）+ 资产全部挂载 `/data` 持久卷
- 多阶段构建，镜像不含 Chromium / Playwright / 开发依赖
- 默认图片并发 1（服务器上限 4），Sharp 后处理并发 1
- 健康检查 + 日志轮转 + 内存限额（1g）已内置

## 架构

```text
apps/web          Next.js 15（UI + REST API + 进程内 Job Runner）
packages/
  ai-core         统一模型协议、错误归一化、并发信号量、流式下载
  provider-openai 文本 Provider（OpenAI-compatible）
  provider-xai    Grok/xAI 图片 Provider（generations/edits）
  provider-compatible  自定义 OpenAI-compatible Provider（能力显式声明）
  workflow-engine 节点执行器 + jobs 表生命周期（可替换为 BullMQ）
  render-engine   双模式渲染：native 落盘校验 + Satori/Sharp 确定性合成
  shared-schemas  Zod 领域模型（Brief/Storyboard/漫画/工作流/开放平台）
infra             Dockerfile + docker-compose（单机部署）
```

## 核心机制

- **双文字渲染模式**：默认 `native`——把精确文案写入图片 Prompt，由主力图片模型直接生成含中文的完整图片；`deterministic` 为兜底（AI 画视觉层，中文由程序渲染，文字可编辑、零 AI 费用改版）。
- **图片并发**：实际生效 = min(用户请求, 服务器上限, Provider 限流)；429 指数退避；图片流式落盘，API 并发与本地后处理并发分离。
- **局部返修**：单页文案修改在确定性模式下仅触发本地重渲染；原生模式下提示需要重新生成该页（费用前置提示）。单页重生成不影响其他页。
- **任务恢复**：节点状态持久化在 SQLite，重启后已完成节点跳过、失败节点续跑。
- **全程可追溯**：`node_runs`（输入输出/尝试次数/费用）、`provider_usages`（成本账本）、`asset_relations`（血缘）、`quality_reports`。
- **发布安全**：平台写操作走独立 Adapter + 幂等键 + 显式授权记录；重复提交不会重复写草稿。

## 文档

完整调研、总体规划与阶段方案见 [docs/README.md](./docs/README.md)。
