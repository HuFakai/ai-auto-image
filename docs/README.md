# AI 图文自动创作项目文档

本文档集用于指导“根据文案、主题、文章、URL 或商品资料，全自动生成一套可发布图文”的产品研发。目标平台包括小红书、抖音、微信公众号及后续扩展平台，内容类型包括图文带货、产品宣传、知识卡片、科普漫画、文章拆解和图书推荐等。

## 文档导航

1. [GitHub 项目与 Skills 调研报告](./01-research-and-reference.md)
2. [总体开发规划方案](./02-master-development-plan.md)
3. [实现评审与下一步开发路线图](./03-implementation-review-and-roadmap.md)
3. [阶段 0：工程基础与技术验证](./phases/00-foundation-and-validation.md)
4. [阶段 1：图文生成 MVP](./phases/01-mvp-carousel-generation.md)
5. [阶段 2：漫画与高级视觉](./phases/02-comic-and-advanced-visuals.md)
6. [阶段 3：工作流与平台发布](./phases/03-workflow-and-publishing.md)
7. [阶段 4：运营闭环与平台化](./phases/04-growth-and-platformization.md)

## 阅读顺序

- 产品、技术负责人先阅读调研报告和总体规划。
- 开发团队按阶段文档实施，不跨阶段提前引入重型基础设施。
- 每一阶段只有在“退出条件”全部满足后，才能进入下一阶段。
- 阶段范围发生变化时，先更新总体规划，再同步对应阶段文档。

## 当前状态

- 当前仓库为新项目，尚未初始化工程代码。
- 已完成 GitHub、Agent Skills、模型兼容方式和参考架构调研。
- 已确认初期采用单机服务器 Docker 部署、SQLite 数据库、Docker 持久卷资产存储和进程内任务执行器。
- PostgreSQL、Redis/BullMQ 和独立 Worker 延后到核心功能基本完成后的阶段 3。
- 默认使用主力图片模型直接生成包含中文的完整图片；Satori/SVG + Sharp 确定性文字渲染作为可控兜底，默认关闭。
- 用户可以自定义图片生成并发，但受服务器安全上限和 Provider 限流约束；本地 Sharp 后处理并发独立限制。
- 下一步从阶段 0 的工程初始化和模型能力验证开始。
