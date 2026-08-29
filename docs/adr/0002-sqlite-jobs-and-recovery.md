# ADR-0002：SQLite 作业模型 — 进程内 Runner、租约与恢复

状态：已接受（2026-08-29）

## 背景

图片生成是分钟级长任务，HTTP 请求不可依赖；应用重启后必须从持久层恢复。
单机 Docker、1 vCPU/1GB 的资源约束排除了 Redis/BullMQ（docs/02 §5.3）。
Auto-AI-Video 的 Durable Tasks（状态机 + attempts/recoveries）与 Production Runner
（租约 + 看门狗 + 熔断）已验证该模型。

## 决策

1. `jobs` 表承载生命周期：`queued → running → succeeded | retry_waiting → running |
   needs_review | cancelled | failed`；终态不可被覆盖。
2. 认领时抢占：单条 UPDATE 带状态条件（乐观并发），同时给 running 任务写租约
   （holder + expires_at）；租约过期的 running 可被重新认领，认领即 `recoveries+1`。
3. 心跳续租（`onProgress`）+ 看门狗回收：先持久化终态（retry_waiting/failed），
   再 abort 执行中的 AbortController，防止 watchdog 与执行器竞态。
4. 启动恢复：单实例部署假设下，启动时把遗留 running 直接释放回队列并记
   `orphan_recovered` 事件；多实例部署是引入 Redis 队列的触发条件之一。
5. 幂等键复用：同 kind + key 且非 cancelled 的任务直接返回（显式取消视为放弃，
   允许同 key 重建）。
6. 作业事件（`job_events`）与尝试记录（`provider_attempts`）构成审计时间线。

## 后果

- 默认 `JOB_RUNNER_CONCURRENCY=1`；图片 API 并发由独立的信号量控制（ADR-0003 配套）。
- Node 级幂等：流水线所有节点按「已成功即跳过」重入，天然实现单页重试与断点恢复。
- 迁移 PostgreSQL/Redis 时保持相同的 Job/NodeRun/事件语义（ADR-0005）。
