# SQLite → PostgreSQL 迁移演练手册（迭代 4-4.1）

> 前置：PG 12+ 可用；`DATABASE_URL=postgres://...` 已配置。本机无 PG 时，导出步骤可执行，
> 导入/校验需在具备 PG 的环境（或 docker compose 临时 pg 服务）运行。

## 1. 导出（SQLite 侧，随时可执行）

```bash
pnpm pg:export            # 产出 pg-dump/*.jsonl + manifest.json
```

- 每表一个 JSONL（列名与 Drizzle schema 一致，时间戳为 epoch 毫秒整数，JSON 字段为 TEXT）。
- manifest.json 记录每表行数与 SHA-256，导入后必须逐表核对。

## 2. 建表（PG 侧）

```bash
DATABASE_URL=postgres://... pnpm --filter @aai/storage db:pg-init   # 由 Drizzle PG dialect 生成并执行 DDL
```

> 表结构与 `packages/storage/src/schema.ts` 等价：TEXT 主键、BIGINT 时间戳、JSONB 内容列、
> 索引与唯一约束一一对应（见 schema.ts 内注释）。

## 3. 导入

```bash
pnpm pg:import --dir pg-dump   # 按依赖顺序：projects → workflow_runs → node_runs → assets → ...
```

导入使用逐表事务 + 每 500 行一批提交；冲突策略为跳过已存在主键（幂等，可中断重跑）。

## 4. 校验（双读验证）

1. 行数核对：每表 COUNT 对比 manifest.rows，不一致即中止。
2. 抽样校验和：每表随机 100 行，按主键排序后 JSON 序列化 SHA-256 对比。
3. 双读开关：应用配置 `SQLITE_PATH` + `DATABASE_URL` 同时存在时，读走 PG、写仍走 SQLite（只读期），
   确认一周无差异后切换主写并停用 SQLite。

## 5. 回滚

- 切换后保留 SQLite 文件只读快照至少两周；
- 回滚 = 将连接配置切回 SQLITE_PATH（应用层无状态，重启即回）；
- 迁移期间产生的增量 PG 数据以 updated_at 增量回写 SQLite（工具：`pnpm pg:export --since <ts>`）。

## 6. Redis/BullMQ（后续批次）

jobs 表未完成任务在切换日转换：`SELECT * FROM jobs WHERE status IN ('queued','running','retry_waiting')`
→ BullMQ Job（payload_json 为任务数据），保留 job.id 作为 externalId 便于审计对账。
