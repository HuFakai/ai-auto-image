# 部署前检查清单（阶段 0 → 服务器）

> 目标：在 Linux 服务器上完成阶段 0 退出条件中的「Docker 部署实测 + 资源基准」。
> 本机无 Docker 时，以下步骤必须在目标服务器执行一次并归档报告。

## 1. 前置条件

```bash
# 服务器要求：Linux + Docker Engine ≥ 24 + docker compose v2
docker info && docker compose version
# 代码上线（含最新提交）
git pull   # 或首次 git clone
```

可选：配置真实渠道（也可启动后在设置页添加）：

```bash
cp .env.example .env && vi .env   # TEXT_* / IMAGE_*
```

## 2. 一键部署验证（推荐）

```bash
bash infra/verify-deployment.sh
```

脚本依次执行并输出 `infra/deployment-report.md`：

1. 多阶段构建镜像（无 Chromium / Playwright / 测试依赖）。
2. `docker compose up -d` 并等待 `/api/health` 就绪。
3. **镜像无浏览器断言**：容器内 `find` 检查 chromium/chrome/playwright 零命中。
4. **Mock 端到端**：创建一次零费用生成并等待完成。
5. **重启持久性**：`docker compose restart` 后健康恢复、历史运行与持久卷资产仍在。
6. **内存基准采样**：空闲内存自动记入报告（目标 ≤250MB）。

## 3. 手动逐项验证（等价于脚本内容）

```bash
cd infra && docker compose up -d && cd ..
curl -s http://127.0.0.1:3000/api/health          # {"ok":true,...}

# 浏览器断言（应无输出）
docker compose -f infra/docker-compose.yml exec app \
  sh -c "find / -maxdepth 6 \( -iname '*chromium*' -o -iname '*playwright*' \) -not -path '/proc/*' | head"

# 重启持久性
docker compose -f infra/docker-compose.yml restart app
curl -s http://127.0.0.1:3000/api/health

# 内存：空闲 ≤250MB；发起一次生成后采样峰值 ≤700MB
docker stats --no-stream $(docker compose -f infra/docker-compose.yml ps -q app)
```

## 4. 内存基准记录表（阶段 0 §11）

| 指标 | 目标 | 实测 | 备注 |
|---|---|---|---|
| 空闲应用内存 | ≤ 250 MB | 待服务器实测 | `docker stats --no-stream` |
| 单页高清合成峰值 | ≤ 700 MB | 待服务器实测 | 生成期间 `watch docker stats` |
| 默认图片并发 | 1 | ✅ `IMAGE_GENERATION_CONCURRENCY_DEFAULT=1` | 用户可调，上限 4 |
| 重启后数据/资产保留 | 是 | 待服务器实测 | `/data` 持久卷 |
| 镜像无 Chromium/Playwright | 是 | 待服务器实测 | verify 脚本断言 |
| 日志无密钥/Cookie | 是 | ✅ logger 脱敏 + 密钥仅内存 | 代码审查 |

## 5. 常见问题

| 现象 | 处理 |
|---|---|
| 端口 3000 被占 | compose 里改 `${PORT:-3000}:3000` 左侧端口 |
| `/data` 权限 | 容器以非 root（aai）运行；绑定挂载时 `chown -R 1000:1000 /data路径` |
| 渠道配置 | 启动后访问 `/settings` 添加；或 `.env` 注入后首次启动自动导入 |
| 构建慢 | 确认 `.dockerignore` 生效（排除 node_modules / Auto-AI-Video / data） |

## 6. 上线前强制项（docs/03 §6 摘录）

- [x] API Key 加密存储（AES-256-GCM）
- [ ] 登录/RBAC —— **当前为单用户假设，仅限内网/VPN 部署**；公网暴露前必须实现
- [ ] 本清单全部断言通过
- [ ] `.env` 密钥轮换一次（开发期 Key 已在多处流转）
