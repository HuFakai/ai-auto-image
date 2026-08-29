# ADR-0005：中期迁移策略 — PostgreSQL / Redis / 独立 Worker

状态：已接受（2026-08-29，触发条件见下）

## 触发条件（任一出现即启动评估）

- 需要多应用副本或多台服务器；
- SQLite 写锁等待影响正常使用；
- 同时运行的生成任务长期 > 2；
- 需要任务优先级、多 Worker 或分布式限流；
- 多租户 / 平台发布进入生产使用。

## 迁移顺序（沿用 docs/phases/03 §3）

1. 暂停外部写入，备份 SQLite 与资产目录；
2. PostgreSQL 建表（Schema 与现有 Drizzle 定义等价）并导入数据，逐表校验行数与外键；
3. 双读验证后切换连接串 —— Repository 层已隔离 SQLite 专属行为，业务代码不改；
4. `jobs` 表未完成任务转换到 Redis/BullMQ，保留 Job/NodeRun/事件语义；
5. 进程内 Runner 拆分为独立 `apps/worker`，租约机制由 BullMQ 的分布式锁替代；
6. 保留 SQLite 只读快照至稳定观察期结束，可回退。

## 设计上已预留的迁移面

- 领域代码只通过 Repository 类访问数据库（无原生 SQL 泄漏）；
- 时间戳统一 epoch 毫秒整数，JSON 字段为 TEXT（PG 中可平移 jsonb）；
- Job 状态机、幂等键、尝试记录结构与 BullMQ 语义一一对应；
- 资产路径全部相对 `/data`，S3/R2 迁移只替换 AssetStore 实现。

## 明确不做

- 不在阶段 0–2 提前引入 PG/Redis（运维成本先于收益）；
- 不使用 SQLite 专属 SQL（`PRAGMA` 仅在连接层出现）；
- 不做在线双写迁移（单机规模下停机窗口可接受）。
