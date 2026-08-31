# ADR-0002：任务执行模型 — 进程内 Runner、租约与恢复

状态：已接受（2026-08-29；当前仍有效）
原始背景：SQLite 阶段的单机资源约束

> 演进说明（2026-08-31）：本 ADR 记录的是 Job/NodeRun/事件的执行语义，不再限定当前数据库必须是 SQLite。当前实现使用 PostgreSQL 方言，生产连接远程 PostgreSQL，本地/测试无连接串时使用 PGlite；Redis/BullMQ 和独立 Worker 尚未启用。

## 背景

图片生成是分钟级长任务，HTTP 请求不可依赖；应用重启后必须从持久层恢复。最初的单机资源约束排除了 Redis/BullMQ，因此采用进程内 Runner + 数据库作业表。状态机、attempts/recoveries、租约、看门狗和熔断等机制来自既有内容生产系统的实践，并已按本项目数据模型独立实现。

## 决策

1. `jobs` 表承载生命周期：`queued → running → succeeded | retry_waiting → running | needs_review | cancelled | failed`；终态不可被覆盖。
2. 认领时抢占：单条 UPDATE 带状态条件（乐观并发），同时给 running 任务写租约（holder + expires_at）；租约过期的 running 可被重新认领，认领即 `recoveries+1`。
3. 心跳续租（`onProgress`）+ 看门狗回收：先持久化终态（retry_waiting/failed），再 abort 执行中的 AbortController，防止 watchdog 与执行器竞态。
4. 启动恢复：单实例部署假设下，启动时把遗留 running 直接释放回队列并记 `orphan_recovered` 事件；多实例部署或需要分布式调度时再引入 Redis 队列。
5. 幂等键复用：同 kind + key 且非 cancelled 的任务直接返回；显式取消视为放弃，允许同 key 重建。
6. 作业事件（`job_events`）与尝试记录（`provider_attempts`）构成审计时间线。

## 后果

- 当前仍是进程内 Runner；生产 Compose 将 `JOB_RUNNER_CONCURRENCY` 起步值设为 2，图片 API 并发由独立信号量控制。
- Node 级幂等：流水线所有节点按“已成功即跳过”重入，天然支持单页重试和断点恢复。
- 数据库从 SQLite 切换到 PostgreSQL 后，Job/NodeRun/事件语义保持不变；未来拆分 Worker 时也必须保持相同的状态、幂等、取消和恢复契约。
