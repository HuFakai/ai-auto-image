# 服务器部署手册（1Panel · 甲骨文 4C24G ARM）

> 目标环境：甲骨文 4 核 24G（Ampere ARM，`uname -m` 应显示 `aarch64`）· 1Panel 已托管 PostgreSQL（`1Panel-postgresql-VkBl`）与 Redis（`1Panel-redis-d67m`）。
> 架构：web 容器仅在回环地址暴露 3000 端口，对外由 1Panel OpenResty 反代 + HTTPS。

## 0. 前置检查

```bash
uname -m                       # aarch64 → 直接在服务器上构建镜像（无需交叉编译）
docker network ls | grep -i 1panel   # 找到 1Panel 容器网络名（默认 1panel-network）
```

甲骨文双层防火墙放行 80/443（在「实例安全列表」放行后，1Panel「主机防火墙」通常已代管 iptables；若仍不通手动放行）。

## 1. 数据库初始化

1Panel 的 PG 数据库 `ai_image` 已创建。表结构由应用启动时自动迁移（drizzle migrations 打进镜像），无需手动执行。
如需手动校验：`docker exec -it 1Panel-postgresql-VkBl psql -U ai_image -d ai_image -c '\dt'`（应看到 15 张表）。

## 2. 准备代码与环境变量

```bash
cd /opt && git clone https://github.com/HuFakai/ai-auto-image.git && cd ai-auto-image
```

创建 `/opt/ai-auto-image/.env`（该文件已被 .gitignore，不会入库）：

```bash
DATABASE_URL=postgres://ai_image:<PG密码>@1Panel-postgresql-VkBl:5432/ai_image
REDIS_URL=redis://:<Redis密码>@1Panel-redis-d67m:6379
APP_SECRET=<见第 3 步>
REGISTER_ENABLED=0                # 上线先关闭注册；第一个注册用户自动成为管理员
REGISTER_INVITE_CODE=             # 开放注册时的邀请码（可选）
DOCKER_NETWORK=1panel-network     # 与第 0 步确认的网络名一致
```

## 3. 渠道密钥解密的关键一步（APP_SECRET）

渠道 API Key 在库里是 AES-256-GCM 加密的，**唯一的解密密钥 = `APP_SECRET` 环境变量**；未设置时回退用 `DATA_DIR/.secret` 文件中的随机密钥。

开发库中的渠道数据是用开发机的 `apps/web/data/.secret`（64 位随机 hex）加密的，该值**已固化到开发机 `.env` 的 `APP_SECRET=`**。因此：

- **服务器 `.env` 的 `APP_SECRET` 必须填与开发机 `.env` 完全相同的值**（从开发机 `.env` 复制 `APP_SECRET=` 那一行）——否则渠道密钥全部解不开（表现为渠道测试报解密失败）。
- 若不沿用旧渠道：服务器可设全新 `APP_SECRET`，启动后在「渠道设置」重新录入各渠道 API Key。
- 密码哈希（登录）与该密钥无关（scrypt 单向哈希，不涉及解密）。

## 4. 构建与启动

```bash
docker compose -f infra/docker-compose.yml up -d --build
docker compose -f infra/docker-compose.yml logs -f app     # 看到迁移与 job runner started 即正常
curl http://127.0.0.1:3000/api/health                       # {"ok":true,...,"database":"134.185.113.0:5432"}
```

镜像在服务器本地构建（ARM 原生）；首次构建约 3–6 分钟。better-sqlite3/sharp 均有 arm64 musl 预编译，无需编译工具链。

## 5. 初始化管理员

1. 临时开放注册：`.env` 中 `REGISTER_ENABLED=1`，`docker compose -f infra/docker-compose.yml up -d` 重建容器。
2. 浏览器访问站点 → 注册（第一个注册用户自动成为 **admin**）。
3. 关闭注册：`REGISTER_ENABLED=0` 再次重建。之后如需加人，设置 `REGISTER_INVITE_CODE` 并临时开启。

## 6. 1Panel 反代 + HTTPS

1. 1Panel「网站」→ 创建静态/反代站点，域名指向服务器 IP（A 记录）。
2. 反代目标 `http://127.0.0.1:3000`；开启 WebSocket 支持（SSE/轮询均兼容）。
3. 申请 Let's Encrypt 证书并开启强制 HTTPS。

## 7. 安全清单（上线必查）

- [ ] 3000 端口仅绑定 `127.0.0.1`（compose 已如此），甲骨文安全组**不放行** 5432/6379（当前 PG 的 5432 对全网开放，建议改为仅本机或按 IP 限制——1Panel 数据库「访问权限」可配）。
- [ ] PG/Redis 密码已轮换（曾出现在对话/本地文件中）。
- [ ] `APP_SECRET` 已按第 3 步配置。
- [ ] 注册已关闭或带邀请码。
- [ ] 1Panel 已为 PG 配置自动备份（每日全量 + binlog/WAL）。

## 8. 升级与回滚

```bash
cd /opt/ai-auto-image && git pull
docker compose -f infra/docker-compose.yml up -d --build   # 重建（数据在 PG 与 aai-data 卷中，不受影响）
docker compose -f infra/docker-compose.yml logs --since 5m app
```

- 生成中任务：重启会按恢复语义把 running 任务释放回队列重跑（幂等：已成功页面跳过）。
- 数据卷 `aai-data` 存放 assets/exports；PG 由 1Panel 备份。回滚 = `git checkout <上一版本 tag>` 后重建。

## 9. 故障排查

| 现象 | 排查 |
|---|---|
| 启动报 `DATABASE_URL` 相关连接错误 | `docker network inspect 1panel-network` 确认 aai-app 已加入；容器内 `nc -zv 1Panel-postgresql-VkBl 5432` |
| 渠道测试报解密失败 | APP_SECRET 与加密端不一致（见第 3 步） |
| /api/health 500 | 看 `docker logs aai-app`；多为迁移或 PG 连接问题 |
| 页面重定向到 /login 但无法登录 | `REGISTER_ENABLED` 与浏览器 cookie（Secure 需 HTTPS）检查 |
