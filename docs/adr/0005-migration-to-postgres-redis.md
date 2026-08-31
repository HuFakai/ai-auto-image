# ADR-0005：PostgreSQL、Redis 与独立 Worker 的演进策略

状态：部分完成（2026-08-31；PostgreSQL 已完成，Redis/BullMQ/独立 Worker 待触发）

## 当前结论

- PostgreSQL：已完成。当前 Schema 使用 PostgreSQL 方言；生产通过 `DATABASE_URL` 使用 `postgres.js`，本地/测试无连接串时使用 PGlite。
- Redis/BullMQ：尚未接入运行时。Compose 可以注入 `REDIS_URL`，但当前作业仍由进程内 Runner 执行。
- 独立 Worker：尚未创建。单容器、单进程方案仍是当前节省资源的部署基线。
- 旧 SQLite 导出/导入脚本仍未覆盖当前用户和计费表，不能视为完整迁移工具；正式生产备份优先使用 PostgreSQL 原生方案。

## 触发条件（任一出现即启动 Redis/Worker 评估）

- 需要多应用副本或多台服务器；
- SQLite 写锁等待影响正常使用（历史兼容场景）或 PostgreSQL 连接/写入成为瓶颈；
- 同时运行的生成任务长期超过单进程可控范围；
- 需要任务优先级、多 Worker、分布式限流或多人协作；
- 多租户、平台发布和定时任务进入生产使用。

## 已完成的 PostgreSQL 切换面

1. Schema 已采用 Drizzle PostgreSQL 方言，覆盖当前业务、用户、计费和支付表。
2. Repository 层使用统一异步数据库接口，生产 postgres.js 与本地 PGlite 复用业务语义。
3. 应用启动和迁移脚本都支持 `DATABASE_URL`，生产 Compose 强制要求该变量。
4. 任务状态机、幂等键、尝试记录、事件和资产路径保持不变。

## 未来 Redis/Worker 顺序

1. 先建立 PostgreSQL 和 `/data` 可恢复备份，补齐当前数据导出/导入与回滚演练。
2. 记录进程内 Runner 的吞吐、队列等待、失败率、Provider 限流和内存数据，确认迁移有真实收益。
3. 引入 Redis/BullMQ，保留 Job/NodeRun/事件语义；为重复投递、取消、重试和租约增加合同测试。
4. 将 Runner 拆为独立 `apps/worker`，Web 只负责创建/查询/取消任务；逐步灰度后再扩展多实例。

## 设计上已预留的迁移面

- 领域代码只通过 Repository 类访问数据库，无原生 SQL 泄漏到业务层。
- 时间戳统一 epoch 毫秒整数，JSON 字段为 TEXT，领域模型不依赖具体数据库驱动。
- Job 状态机、幂等键、尝试记录和资产血缘可映射到分布式队列语义。
- 资产路径全部相对 `/data`，对象存储迁移只替换 AssetStore 实现。

## 明确不做

- 没有真实并发、可靠性或多人协作需求时，不为“看起来先进”提前引入 Redis/Worker。
- 不在线双写两套数据库；切换前使用可验证的停机窗口、备份和回滚方案。
