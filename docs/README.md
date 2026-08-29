# AI 图文自动创作项目文档

本文档集用于指导“根据文案、主题、文章、URL 或商品资料，全自动生成一套可发布图文”的产品研发。目标平台包括小红书、抖音、微信公众号及后续扩展平台，内容类型包括图文带货、产品宣传、知识卡片、科普漫画、文章拆解和图书推荐等。

## 文档导航

0. [开发文档：环境配置与启动指南](./development.md)
1. [GitHub 项目与 Skills 调研报告](./01-research-and-reference.md)
2. [总体开发规划方案](./02-master-development-plan.md)
3. [实现评审与下一步开发路线图](./03-implementation-review-and-roadmap.md)
4. [基于 Auto-AI-Video 提取的 AI 图文基础框架解决方案](./04-ai-image-framework-solution.md)
5. [阶段 0：工程基础与技术验证](./phases/00-foundation-and-validation.md)
6. [阶段 1：图文生成 MVP](./phases/01-mvp-carousel-generation.md)
7. [阶段 2：漫画与高级视觉](./phases/02-comic-and-advanced-visuals.md)
8. [阶段 3：工作流与平台发布](./phases/03-workflow-and-publishing.md)
9. [阶段 4：运营闭环与平台化](./phases/04-growth-and-platformization.md)

## 阅读顺序

- 产品、技术负责人先阅读调研报告和总体规划。
- 开发团队按阶段文档实施，不跨阶段提前引入重型基础设施。
- 每一阶段只有在“退出条件”全部满足后，才能进入下一阶段。
- 阶段范围发生变化时，先更新总体规划，再同步对应阶段文档。

## 当前状态

- 阶段 0 工程代码已初始化：TypeScript Monorepo（pnpm + Turborepo），`apps/web` + 8 个 packages。
- 已实现：统一 Schema（Zod）、Provider 层（openai / xai / compatible / mock + 路由回退）、
  SQLite 存储（Drizzle，10 表迁移入库）、进程内 Job Runner（租约 / 心跳 / 重启恢复）、
  知识卡片 Spike 流水线（native 默认 + deterministic 兜底）、暗房风格 Web Studio。
- 已通过：全仓 lint / typecheck / test / build 全绿；Mock 全流程、单页重试、重启恢复、
  取消、双文字模式均集成测试通过；生产 standalone 启动与 `/api/health` 验证通过。
- 待办：在 Linux 服务器执行 `docker compose up -d` 验证部署；配置
  `OPENAI_API_KEY` / `XAI_API_KEY` 后运行 `pnpm verify:openai` / `pnpm verify:xai`
  完成真实调用验证（脚本与报告输出已就绪）。
- 架构决策记录见 [docs/adr/](./adr/)。
