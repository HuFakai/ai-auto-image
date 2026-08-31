# AI 图文工坊文档索引

本文档集服务于“根据主题、文案、长文、URL 或商品资料自动生成可发布图文”的项目研发。当前实现已经进入可演示 Beta；请优先阅读当前状态和当前路线图。

## 当前有效文档

1. [当前项目状态与代码审查报告](./current-status.md)：截至 2026-08-31 的代码、测试、部署和风险结论。
2. [当前开发路线图](./current-roadmap.md)：已完成能力、发布阻断项、Beta 和后续扩展顺序。
3. [开发与环境说明](./development.md)：本地开发、环境变量、命令、目录和故障排查。
4. [服务器部署手册](./deployment.md)：Docker、1Panel、外部 PostgreSQL/Redis、HTTPS、备份和上线清单。

## 方案与参考基线

5. [GitHub 项目与 Skills 调研](./01-research-and-reference.md)：早期技术选型、可参考项目和复用边界。
6. [总体开发规划方案](./02-master-development-plan.md)：产品愿景、领域模型和长期架构基线。
7. [AI 图文基础框架解决方案](./04-ai-image-framework-solution.md)：从 Auto-AI-Video 提取的任务、Provider、渲染和资产设计；其中“初期 SQLite”是历史决策，当前实现已演进为 PostgreSQL 方言 + PGlite/远程 PostgreSQL。

## 阶段设计基线（历史范围）

以下文档记录最初的阶段范围、验收想法和未来能力，可能与当前实现的先后顺序不同。当前执行以 [current-status.md](./current-status.md) 和 [current-roadmap.md](./current-roadmap.md) 为准：

- [阶段 0：工程基础与技术验证](./phases/00-foundation-and-validation.md)
- [阶段 1：图文生成 MVP](./phases/01-mvp-carousel-generation.md)
- [阶段 2：漫画与高级视觉](./phases/02-comic-and-advanced-visuals.md)
- [阶段 3：工作流与平台发布](./phases/03-workflow-and-publishing.md)
- [阶段 4：运营闭环与平台化](./phases/04-growth-and-platformization.md)

## 架构决策记录（ADR）

- [ADR-0001：模型层与 OpenAI-compatible Wire](./adr/0001-model-provider-layer.md)
- [ADR-0002：进程内 Runner、租约与恢复](./adr/0002-sqlite-jobs-and-recovery.md)
- [ADR-0003：原生文字与确定性文字双模式](./adr/0003-dual-text-rendering.md)
- [ADR-0004：`/data` 持久卷与原子落盘](./adr/0004-storage-layout-and-volumes.md)
- [ADR-0005：PostgreSQL / Redis / 独立 Worker 迁移策略](./adr/0005-migration-to-postgres-redis.md)

ADR 记录决策背景和演进关系，不等同于当前待办。

## UI 设计档案

[`ui-proposals/`](./ui-proposals/) 保存高保真静态稿。方案 A「暗室暗房」v2 已落地到当前 Studio；方案 B/C 是已归档的备选方向，仅用于设计回溯。

## 文档维护规则

- 新的事实先更新 `current-status.md`，新的工作顺序更新 `current-roadmap.md`。
- 方案基线、阶段设计和 ADR 不用来表达当前完成度；如果与代码冲突，要在当前文档中明确说明。
- 任何会影响上线安全、计费、数据迁移和部署的变化，都要同步更新开发/部署文档并留下验证结果。
