# AI 图文工坊

根据主题、文案、长文、URL 或商品资料，自动生成适合小红书、抖音、微信公众号等自媒体平台使用的成套中文图文。覆盖知识卡片、科普漫画、产品种草、图书推荐、文章拆解等场景。

## 当前状态

项目当前处于**可演示 Beta、上线前加固期**：核心生成、编辑导出、Brand Kit、登录、PostgreSQL、点数计费和支付管理后台已经具备。本轮已完成支付 fail-closed、图片额度预留/结算、迁移覆盖和根质量门禁修复；真实模型/支付联调和目标服务器实测仍待完成。

详细结论见 [当前项目状态与代码审查报告](./docs/current-status.md)，执行顺序见 [当前开发路线图](./docs/current-roadmap.md)。

## 主要能力

- 9 种内容类型，知识卡片与漫画两条工作流骨架。
- OpenAI、xAI/Grok、OpenAI-compatible 和 Mock Provider；文本/图片渠道可独立配置和回退。
- 由图片模型直接生成包含中文的最终图片；新建、重试和单页重生统一使用原生图片链路。
- 文本/图片模型仅按后台渠道配置限流，默认 `0` 表示不限制并发。
- 单页返修、版本链、封面候选、平台适配、Brand Kit、评审和 ZIP 导出。
- 失败作品支持从检查点恢复、从头创建新作品重试；失败页面支持单页重试并复用已完成内容。
- 充值中心的点数明细与订单支持分页、作品/任务标题、订单号；管理员调点同步形成可审计调整订单。
- 管理后台支持获取渠道模型目录、多选启用、默认模型、渠道/模型优先级、模型单次点数和图生图能力配置。
- 管理后台可控制用户是否在创作条自定义选择模型；开启后显示模型单次点数，漫画会自动过滤不支持图生图的图片模型。
- 文本、图片、封面、返修和发布文案按实际成功模型调用计费；模型失败或回退尝试会释放对应预留点数。
- 登录注册、资源隔离、套餐点数、订阅、订单、支付宝/微信支付接口和管理后台第一版。

## 本地快速开始

要求 Node.js 22+、pnpm 11+。本地未配置 `DATABASE_URL` 时使用进程内 PGlite，真实渠道未配置时可使用 Mock Provider。

```bash
pnpm install
cp .env.example .env
pnpm dev
```

打开 `http://localhost:1235`。模型渠道、Brand Kit 和支付配置优先在应用设置/管理后台维护；密钥由 `APP_SECRET` 保护。

## Docker 部署

生产 Compose 运行单个 Web 容器，连接外部 PostgreSQL（必填）和可选 Redis，资产与导出文件挂载到 `/data`：

```bash
docker compose --env-file .env -f infra/docker-compose.yml up -d --build
docker compose --env-file .env -f infra/docker-compose.yml logs -f app
curl http://127.0.0.1:1235/api/health
```

默认 1235 仅绑定本机；需要临时公网 IP 直连时，在 `.env` 设置 `APP_BIND_ADDRESS=0.0.0.0`，并按 [服务器部署手册](./docs/deployment.md) 放行云防火墙。生产环境建议使用 1Panel HTTPS 反向代理。完整步骤、备份、注册策略和上线安全项见 [服务器部署手册](./docs/deployment.md)。未完成 P0 安全项前，不要开放真实收费或公网注册。

## 常用命令

```bash
pnpm dev
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm eval
pnpm verify:openai   # 需要真实 OpenAI 密钥
pnpm verify:xai      # 需要真实 xAI 密钥
```

阶段性类型检查和相关工作流测试会随每个版本提交执行；完整的 lint、全量测试、构建和真实渠道验收在产品优化方案的全部阶段完成后统一执行。

## 文档

- [文档索引](./docs/README.md)
- [GitHub 与 Skills 调研](./docs/01-research-and-reference.md)
- [总体开发规划（战略基线）](./docs/02-master-development-plan.md)
- [AI 图文基础框架方案](./docs/04-ai-image-framework-solution.md)
- [开发与环境说明](./docs/development.md)
- [服务器部署手册](./docs/deployment.md)
- [架构决策记录](./docs/adr/)

## 许可证与复用

复用第三方项目、字体、Prompt、模型输出和平台接口前，请按 [调研报告](./docs/01-research-and-reference.md) 的许可证与合规说明逐项确认。
