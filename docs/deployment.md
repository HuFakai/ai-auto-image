# 服务器部署手册（Docker · 1Panel · 外部 PostgreSQL）

> 本手册按当前 Compose 配置编写。推荐目标为 1Panel 托管的 Linux/ARM 服务器；Web 以单容器运行，生产数据库使用外部 PostgreSQL，Redis 先作为预留服务，不代表当前应用已经切换到 Redis Worker。
> 本次代码审查机未安装 Docker，以下步骤必须在目标服务器执行并留存实际输出。

## 1. 部署形态

```text
Internet
   │
1Panel OpenResty + HTTPS
   │ 反代到 127.0.0.1:1235
   ▼
ai-auto-image Web 容器
   ├─ 外部 PostgreSQL：业务数据、用户、计费、订单
   ├─ 外部 Redis：当前预留，独立 Worker 阶段再启用
   └─ /data 持久卷：生成资产、导出包、运行密钥文件
```

当前单容器方案的目标是节省资源、降低运维复杂度；当多实例、持续高并发、队列优先级或多人协作成为真实需求时，再启用 Redis/BullMQ 和独立 Worker。

## 2. 服务器前置检查

```bash
uname -m
docker --version
docker compose version
docker network ls | grep -i 1panel
```

ARM 服务器通常应显示 `aarch64`。确认 1Panel PostgreSQL/Redis 容器与应用加入同一个 Docker 网络；Compose 默认网络名是 `1panel-network`，不一致时设置 `DOCKER_NETWORK`。

服务器只需要对外放行 80/443。1235 仅绑定回环地址，5432/6379 不应直接暴露公网。

## 3. 获取代码与准备环境变量

```bash
cd /opt
git clone https://github.com/HuFakai/ai-auto-image.git
cd ai-auto-image
cp .env.example .env
```

编辑根目录 `.env`，至少配置：

```dotenv
DATABASE_URL=postgres://<user>:<password>@<postgres-container>:5432/<database>
APP_SECRET=<高强度随机值>
REGISTER_ENABLED=0
DOCKER_NETWORK=1panel-network
```

渠道 API Key 在库里是 AES-256-GCM 加密的，**唯一的解密密钥 = `APP_SECRET` 环境变量**；未设置时仍兼容回退到 `DATA_DIR/.secret`，但生产环境必须显式设置 `APP_SECRET`。

开发库中的渠道数据是用开发机的 `apps/web/data/.secret`（64 位随机 hex）加密的，该值**已固化到开发机 `.env` 的 `APP_SECRET=`**。因此：

- **服务器 `.env` 的 `APP_SECRET` 必须填与开发机 `.env` 完全相同的值**（从开发机 `.env` 复制 `APP_SECRET=` 那一行）——否则渠道密钥全部解不开（表现为渠道测试报解密失败）。
- 若不沿用旧渠道：服务器可设全新的 `APP_SECRET`，启动后在「渠道设置」重新录入各渠道 API Key。
- 密码哈希（登录）与该密钥无关（scrypt 单向哈希，不涉及解密）。

如果暂时不接 Redis，`REDIS_URL` 可以为空；Compose 仍要求 `DATABASE_URL`，因为生产路径不应回退到 PGlite。

模型渠道可以通过 `.env` 首次自动导入，也可以在应用的渠道设置页录入。支付和模型密钥不要提交 Git，不要写入日志或部署截图。

## 4. 数据库与密钥

- 当前 PostgreSQL Schema 共 22 张表，应用启动时自动执行 `packages/storage/drizzle/` 迁移。
- 首次启动后可在 PostgreSQL 容器中检查表：

  ```bash
  docker exec -it <postgres-container> psql -U <user> -d <database> -c '\dt'
  ```

- `APP_SECRET` 是渠道 API Key 的加密主密钥。若导入已有渠道数据，必须使用加密时的同一个值；若无法安全迁移旧密钥，应在服务器上重新录入渠道密钥。
- `/data` 中的 `assets/` 和 `exports/` 必须持久化；生产 PostgreSQL 数据由数据库自身备份，不要只备份 `/data`。
- 当前 `pg:export` / `pg:import` 仍是旧 SQLite → PostgreSQL 导入工具，但已覆盖当前 22 张表、记录源库缺表并校验 JSONL 校验和。它不是正式备份方案，生产正式备份仍优先使用 PostgreSQL 原生备份和 1Panel 备份策略。

## 5. 构建、启动和健康检查

```bash
docker compose -f infra/docker-compose.yml up -d --build
docker compose -f infra/docker-compose.yml ps
docker compose -f infra/docker-compose.yml logs --tail=200 app
curl http://127.0.0.1:1235/api/health
```

正常启动应看到迁移完成和 Job Runner 启动日志；健康检查应返回成功 JSON。镜像使用多阶段构建、Next standalone、非 root 用户和 Node 内置 fetch 健康检查，不包含 Chromium/Playwright。

当前 Compose 的资源/并发默认值：

| 配置 | 当前值 |
|---|---:|
| 容器内存上限 | 4G |
| 图片生成默认并发 | 2 |
| 图片生成服务器上限 | 6 |
| 图片后处理上限 | 2 |
| 进程内 Job Runner 并发 | 2 |

这些是起步值，不是性能承诺。应结合 Provider 限流、图片分辨率和目标服务器监控调整；用户请求并发不能突破服务器/Provider 上限。

## 6. 管理员和注册策略

推荐流程：

1. 保持 `REGISTER_ENABLED=0` 部署并完成健康检查。
2. 只在受控 HTTPS 环境短时设置 `REGISTER_ENABLED=1`，注册第一个管理员。
3. 立即改回 `REGISTER_ENABLED=0` 并重建/重启容器。
4. 后续增加成员时使用邀请码和人工审批；公网开放前补齐完整 RBAC、管理员审计和注册风控。

不要把“首个注册用户自动成为 admin”当作长期生产账户管理方案。

## 7. 上线前安全清单

- [ ] `APP_SECRET` 使用高强度随机值，且没有出现在 Git、日志、截图或聊天记录中。
- [ ] PostgreSQL/Redis 只对应用网络或白名单开放，不对公网开放。
- [ ] PostgreSQL 已做每日备份，并完成一次可恢复演练。
- [ ] `/data` Docker volume 已做备份和磁盘容量告警。
- [ ] 1235 只绑定 `127.0.0.1`，对外访问统一经过 HTTPS。
- [ ] 注册关闭或配置邀请码；管理员账号已单独验证。
- [ ] 生产环境已禁止 mock 订单和 `/api/pay/dev-confirm`；真实支付未就绪时必须 fail-closed。
- [ ] 支付宝/微信回调域名、证书、验签、公钥和商户配置已完成小额联调。
- [ ] 真实 OpenAI/Grok 渠道已完成预算受控的成功/失败调用验证。
- [ ] 中文字体已随镜像存在，native 与 deterministic 两种模式各有人工抽样结果。
- [ ] `pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm build` 在发布提交上全绿。
- [ ] 已记录健康检查、重启恢复、资产持久化、并发、CPU、内存、队列等待和错误日志结果。

## 8. 部署验证脚本

在目标服务器执行：

```bash
bash infra/verify-deployment.sh
```

该脚本覆盖构建/启动、健康检查、Mock 运行、重启持久性和基础资源观察。当前脚本的内存检查仍需要人工结合 `docker stats` 判断，不能替代完整压测；本轮审查没有执行它。

## 9. 更新、回滚和故障排查

更新：

```bash
cd /opt/ai-auto-image
git pull --ff-only origin main
docker compose -f infra/docker-compose.yml up -d --build
docker compose -f infra/docker-compose.yml logs --since=5m app
```

回滚前先备份 PostgreSQL 和 `/data`，再切到已验证的提交/标签重新构建。不要在生产运行未验证的迁移脚本或 `--truncate` 导入。

常见问题：

| 现象 | 排查方向 |
|---|---|
| 容器启动失败 | `docker compose logs app`；重点看 `DATABASE_URL`、网络名、迁移和 `APP_SECRET` |
| `/api/health` 失败 | 检查 PostgreSQL 网络/凭据、迁移错误和容器资源 |
| 页面无法访问 | 检查 1Panel 反代目标、HTTPS、回环端口和 WebSocket/SSE 配置 |
| 渠道密钥解密失败 | `APP_SECRET` 与录入/导入时不一致；重新录入渠道或恢复正确密钥 |
| 任务一直排队 | 查看 Runner 启动日志、Job 状态、Provider 限流和有效并发 |
| 图片文字异常 | native 结果走人工复核；需要精确文字时显式开启 deterministic 并确认字体 |
| 支付到账但点数异常 | 先冻结真实收费，检查订单幂等、回调验签和点数流水，不要手工重复补单 |
