# 服务器部署手册（Docker · 1Panel · Oracle 4 核 24G）

> 本手册针对当前项目的服务器测试环境：甲骨文云 4 vCPU / 24 GB RAM，已安装 1Panel，使用 Docker 部署，应用端口固定为 **1235**。
>
> 当前 Docker 生产形态是一个 Web 容器 + 外部 PostgreSQL。Redis 暂时只保留为基础设施预留，当前任务仍由应用进程内 Runner 执行，不能把 Redis 误认为已经启用的分布式 Worker。

## 1. 部署结构和资源策略

~~~text
公网
  │
Oracle VCN / 1Panel 防火墙
  │
1Panel OpenResty：HTTPS + 反向代理（推荐）
  │
127.0.0.1:1235（APP_BIND_ADDRESS 默认值）
  │
aai-app（Node.js 22、非 root、/data 持久卷）
  ├── 1Panel PostgreSQL（同 Docker 网络，必需）
  ├── 1Panel Redis（可选，当前不承载任务）
  └── 图片资产 / 导出包（/data）
~~~

针对 4 核 24G 主机，首次上线采用保守起步值：

| 项目 | 初始值 | 说明 |
| --- | ---: | --- |
| 应用容器内存上限 | 4G | 给 PostgreSQL、1Panel、系统和文件缓存留出余量 |
| 图片 API 默认并发 | 2 | 图片生成主要等待外部 Provider，但后续仍有本地解码/落盘 |
| 图片 API 服务器上限 | 4 | 用户请求值、Provider 上限和该值取最小值 |
| Sharp 后处理并发 | 2 | 防止大图合成时内存峰值过高 |
| 进程内 Job Runner | 2 | 当前单容器执行模型 |
| 文字确定性渲染 | 默认关闭 | 默认走模型原生中文图片；需要精确文字时按 Run 开启 |

先用上述值完成真实链路测试，再根据 docker stats、Provider 限流、图片尺寸和队列等待时间调整。不要一开始就把 24G 内存全部分配给应用，也不要把并发简单设置成 CPU 核数的数倍。

## 2. 1Panel 和服务器前置检查

### 2.1 在 1Panel 中确认 Docker

在 1Panel 的容器模块中确认 Docker Engine 和 Docker Compose 可用；也可以打开 1Panel 终端或 SSH 执行：

~~~bash
uname -m
nproc
free -h
df -h /
docker --version
docker compose version
docker ps
docker network ls
~~~

甲骨文 ARM 实例通常显示 aarch64。本项目镜像会在目标服务器上构建，4 核 24G 足够完成首次多阶段构建；本地没有 Docker 不影响服务器部署。

建议磁盘至少预留给 Docker 镜像、日志、数据库备份和生成资产，不要只看内存。上线前同时检查：

~~~bash
docker system df
df -h /var/lib/docker
~~~

### 2.2 Oracle 云和 1Panel 防火墙

本项目支持两种访问方式。生产环境推荐使用方式 A；方式 B 只适合临时通过公网 IP 验证。

**方式 A：1Panel 反向代理（推荐）**

- Oracle VCN/NSG 和 1Panel 防火墙只开放 80、443。
- SSH 22 只允许自己的固定 IP 或 VPN 网段。
- `.env` 保持 `APP_BIND_ADDRESS=127.0.0.1`。
- 1Panel 网站/反向代理目标填写 `http://127.0.0.1:1235`。
- PostgreSQL、Redis 和应用端口 1235 不对公网开放。

**方式 B：公网 IP 直连测试**

- `.env` 设置 `APP_BIND_ADDRESS=0.0.0.0`。
- 在 Oracle VCN Security List/NSG 和 1Panel 防火墙放行入站 TCP 1235，来源尽量限制为你的公网 IP `/32`，不要直接对全网开放。
- 修改配置后必须使用 `docker compose up -d --force-recreate`，仅 `restart` 不会重新读取端口绑定。
- 通过 `http://服务器公网IP:1235` 访问；测试结束后建议恢复为 `127.0.0.1` 并关闭 1235 入站规则。

无论哪种方式，5432 和 6379 都不应对公网开放。

### 2.3 确认 PostgreSQL/Redis 的 Docker 网络

先列出 1Panel 创建的容器和网络：

~~~bash
docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Ports}}'
docker network ls
~~~

查看 PostgreSQL 和 Redis 容器实际加入的网络：

~~~bash
docker inspect <postgres-container> --format '{{range $name, $_ := .NetworkSettings.Networks}}{{println $name}}{{end}}'
docker inspect <redis-container> --format '{{range $name, $_ := .NetworkSettings.Networks}}{{println $name}}{{end}}'
~~~

应用 Compose 默认使用外部网络 1panel-network。如果实际网络名不同，把真实名称写入根目录 .env 的 DOCKER_NETWORK。三个容器必须至少共享一个 Docker 网络；在同一网络内，DATABASE_URL 应使用 PostgreSQL 容器名或网络别名，不能使用 localhost。

如果现有 1Panel 服务没有共同网络，可以创建一个专用网络并将已存在的服务接入：

~~~bash
docker network create aai-network
docker network connect aai-network <postgres-container>
docker network connect aai-network <redis-container>
~~~

然后在 .env 中设置：

~~~dotenv
DOCKER_NETWORK=aai-network
~~~

不要为了“能连通”临时把 PostgreSQL 或 Redis 端口映射到公网。

## 3. 在 1Panel 准备 PostgreSQL

### 3.1 创建数据库

在 1Panel 的数据库/PostgreSQL 页面创建：

- 数据库：例如 ai_image
- 用户：例如 ai_image
- 密码：使用高强度密码
- 访问范围：应用所在 Docker 网络或内网，不开放公网

记录 PostgreSQL 容器名、数据库名、用户名和密码。容器之间通常使用 PostgreSQL 的内部端口 5432，不要把宿主机映射端口误填进容器网络地址。

如果密码包含 @、/、#、?、: 等 URL 保留字符，写入 DATABASE_URL 前必须进行 URL 编码；否则优先为该数据库用户设置只包含字母、数字和安全符号的密码。

### 3.2 Redis 的当前策略

测试阶段可以不配置 Redis：

~~~dotenv
REDIS_URL=
~~~

当前代码仍使用进程内 Job Runner；Redis/BullMQ 和独立 Worker 要等核心功能稳定、SQLite 写锁/任务量成为实际瓶颈后再单独迁移。即使 1Panel 已安装 Redis，也不代表当前应用已经把任务切换到 Redis。

## 4. 获取代码和配置 .env

### 4.1 获取仓库

首次部署（1Panel 默认应用目录）：

~~~bash
mkdir -p /opt/1panel/apps
cd /opt/1panel/apps
git clone https://github.com/HuFakai/ai-auto-image.git
cd /opt/1panel/apps/ai-auto-image
git rev-parse --short HEAD
~~~

后续更新已有目录：

~~~bash
cd /opt/1panel/apps/ai-auto-image
git fetch origin
git pull --ff-only origin main
git rev-parse --short HEAD
~~~

如果使用 1Panel 的 Compose 编排页面，也应让编排项目指向该目录中的 infra/docker-compose.yml；命令行 Compose 是本手册的验收基准。

### 4.2 创建运行时配置

~~~bash
cd /opt/1panel/apps/ai-auto-image
cp .env.example .env
chmod 600 .env
~~~

编辑根目录 .env。下面是服务器测试所需的配置骨架，尖括号内容必须替换，密钥不要粘贴到工单、截图或 Git：

~~~dotenv
# PostgreSQL 必填；使用同一 Docker 网络内的容器名
DATABASE_URL=postgres://<db-user>:<url-encoded-password>@<postgres-container>:5432/<db-name>

# 首次部署可以生成新值；一旦使用就不要随意更换
APP_SECRET=<高强度随机值>

# 对外网络和安全策略
DOCKER_NETWORK=<实际共享网络名>
REGISTER_ENABLED=0
REGISTER_INVITE_CODE=
PAYMENT_MOCK_ENABLED=0
PAY_NOTIFY_BASE_URL=https://<你的域名>

# 文本渠道：当前首启自动导入入口
TEXT_BASE_URL=https://api.openai.com/v1
TEXT_API_KEY=<text-api-key>
TEXT_MODEL=<text-model>
TEXT_VISION=0

# 图片渠道：gpt-image-2 或 grok-imagine-image-2.0 按实际端点选择
IMAGE_BASE_URL=https://api.x.ai/v1
IMAGE_API_KEY=<image-api-key>
IMAGE_MODEL=grok-imagine-image-2.0
IMAGE_ASPECT_RATIO_PARAM=aspect_ratio
IMAGE_RESPONSE_FORMAT=url
# IMAGE_RESOLUTION=2k

# 4 核服务器起步并发
IMAGE_GENERATION_CONCURRENCY_DEFAULT=2
IMAGE_GENERATION_CONCURRENCY_MAX=4
IMAGE_POSTPROCESS_CONCURRENCY_MAX=2
JOB_RUNNER_CONCURRENCY=2

# 应用端口固定为 1235
PORT=1235
# 默认仅本机访问；如需临时公网 IP 直连测试，改为 0.0.0.0
APP_BIND_ADDRESS=127.0.0.1
LOG_LEVEL=info
~~~

根据渠道类型调整示例：

| 目标 | TEXT_BASE_URL / IMAGE_BASE_URL | 图片参数 |
| --- | --- | --- |
| OpenAI 官方 | https://api.openai.com/v1 | 通常使用 size；返回格式按端点支持情况填写 |
| xAI/Grok 官方 | https://api.x.ai/v1 | 通常使用 aspect_ratio，Grok 图片 URL 必须立即转存 |
| Grok2API 或其他兼容网关 | 网关提供的 /v1 地址 | 以网关文档为准，常见为 aspect_ratio + b64_json |

文本和图片可以使用不同的 Provider。当前应用的环境变量自动导入只读取 TEXT_BASE_URL/TEXT_API_KEY/TEXT_MODEL 和 IMAGE_BASE_URL/IMAGE_API_KEY/IMAGE_MODEL；只填写 OPENAI_API_KEY 或 XAI_API_KEY 不会自动创建数据库渠道，建议使用上面的显式 TEXT_* / IMAGE_* 配置，或登录后在“渠道设置”中录入。

### 4.3 APP_SECRET 与渠道密钥

APP_SECRET 是渠道 API Key 的加密主密钥：

- 全新 PostgreSQL 数据库可以生成一个新的随机值，并在服务器上长期保存。
- 如果要迁移已有渠道数据，服务器必须使用加密这些数据时的同一个 APP_SECRET。
- 如果只迁移业务数据但无法安全迁移旧密钥，使用新密钥后在“渠道设置”中重新录入 API Key。
- Compose 已将 APP_SECRET 设为必填，缺失时会拒绝启动。
- APP_SECRET 变化不会改变用户密码哈希，但会使旧的渠道密文无法解密。

当前项目启动时会在数据库为空时自动导入 TEXT_* / IMAGE_* 渠道；渠道表一旦已有记录，后续修改 .env 不会覆盖数据库中的渠道配置，需要在设置页修改或新增渠道。

### 4.4 支付宝地址配置

支付宝配置中有三类完全不同的地址。以你部署的域名 `https://img.aisenno.com` 为例：

| 配置位置 | 应填写的值 | 作用 |
| --- | --- | --- |
| 管理后台 → 支付渠道 → 支付宝 → **支付宝 API 网关地址** | 正式环境：`https://openapi.alipay.com/gateway.do` | 服务端调用 `alipay.trade.precreate` 下单接口；这里不是你的业务域名 |
| 服务器 `.env` 的 `PAY_NOTIFY_BASE_URL` | `https://img.aisenno.com` | 应用生成支付宝异步通知地址的基地址，不要填写完整的 `/api/pay/notify/alipay` |
| 支付宝实际异步通知地址 | `https://img.aisenno.com/api/pay/notify/alipay` | 支付宝支付状态变化后以 POST 方式通知应用；当前代码会从上面的基地址自动拼接 |
| 支付宝开放平台 → **授权回调地址** | 当前项目暂不填写 | 这是用户授权/OAuth 回调，不是当面付异步通知；当前项目没有实现支付宝 OAuth 回调路由 |

因此，当前只使用“支付宝（当面付·订单码）”收款时，建议这样配置：

~~~dotenv
PAY_NOTIFY_BASE_URL=https://img.aisenno.com
ALIPAY_GATEWAY=https://openapi.alipay.com/gateway.do
~~~

支付宝开放平台的“授权回调地址”如果页面允许为空，就保持为空；不要填 `https://img.aisenno.com/api/pay/notify/alipay`，因为该地址只接受支付宝支付异步通知的 POST 请求，不是 OAuth 授权回调。只有后续实现支付宝登录/用户授权功能时，才需要新增专用的 GET 回调路由，并把该路由的完整 HTTPS 地址原样登记到支付宝平台。

如果使用沙箱，管理后台的网关改为支付宝当前沙箱环境提供的网关地址；业务域名和通知地址仍然按实际可公网访问的 HTTPS 域名配置。支付宝官方的 [alipay.trade.precreate 接口文档](https://developer.alibaba.com/docs/api.htm?apiId=862&docType=4)中，正式网关为 `https://openapi.alipay.com/gateway.do`，`notify_url` 是支付宝服务器通知商户服务器的 HTTP/HTTPS 地址；[用户信息授权文档](https://developer.alibaba.com/docs/doc.htm?articleId=105656&docType=1&treeId=346)中的授权回调则用于接收授权结果，需与授权请求中的 `redirect_uri` 匹配。

当前项目调用订单码支付时会固定传入支付宝要求的 `product_code=QR_CODE_OFFLINE`，并按支付宝 OpenAPI 规范让 `sign_type=RSA2` 参与请求签名，不需要在管理页额外填写。请求传输也按支付宝官方 Node SDK 的方式处理：公共参数放在网关 URL，`biz_content` 放在 POST body。订单标题会在服务端统一清理首尾空白，并拒绝 `/`、`=`、`&`、控制字符和超过 256 字节的内容。

若服务器仍运行旧镜像，可能会看到 `40002 Invalid Arguments` 或 `isv.invalid-signature`；更新代码并重新构建后再测试。新的错误信息会保留支付宝返回的 `sub_code` 和 `sub_msg`，并在容器日志中记录订单类型、金额、标题长度、网关主机等脱敏诊断字段，不会记录任何密钥或签名原文。管理页保存支付宝参数时还会在服务端自检应用私钥与支付宝公钥是否成对，但这只能验证本地两段密钥；支付宝平台中登记的应用公钥仍需与应用私钥对应。

### 4.5 不把服务器密钥带进镜像

Compose 使用根目录 .env 作为容器运行时环境文件；同时 .dockerignore 已排除 .env，避免密钥进入 Docker 构建上下文。请确认：

~~~bash
cd /opt/1panel/apps/ai-auto-image
test -s .env
stat -c '%a %n' .env 2>/dev/null || stat -f '%Lp %N' .env
~~~

不要执行不加 --quiet 的 docker compose config 后把完整输出发到公开位置，因为完整配置可能包含密钥。

## 5. 首次构建、启动和迁移

当前 Docker Compose 会：

- 把根目录 .env 传入容器，保证模型、支付和 Provider 配置生效。
- 应用监听容器内 1235；宿主机绑定地址由 `APP_BIND_ADDRESS` 控制，默认是 127.0.0.1。
- 启动时执行 PostgreSQL 迁移。
- 把 /data 挂载到名为 aai-data 的持久卷。
- 将容器内存限制为 4G。
- 强制生产镜像关闭模拟支付。
- 不安装 Chromium、Playwright 或浏览器运行时。
- 构建阶段自动执行 `scripts/fetch-fonts.sh`，将 Noto Sans/Serif SC 放入镜像；全新 `git clone` 不需要手工创建字体目录。
- 将 `apps/web/public` 复制到最终镜像，包含创作页的内容类型和 Brand Kit 预览图；这些静态资源已纳入 Git，不应加入忽略规则。

在服务器执行：

~~~bash
cd /opt/1panel/apps/ai-auto-image

# 只验证 Compose 插值和文件，不输出完整敏感配置
docker compose --env-file /opt/1panel/apps/ai-auto-image/.env -f /opt/1panel/apps/ai-auto-image/infra/docker-compose.yml config --quiet

# 首次构建并后台启动
docker compose --env-file /opt/1panel/apps/ai-auto-image/.env -f /opt/1panel/apps/ai-auto-image/infra/docker-compose.yml up -d --build

# 查看状态和健康状态
docker compose --env-file /opt/1panel/apps/ai-auto-image/.env -f /opt/1panel/apps/ai-auto-image/infra/docker-compose.yml ps
docker inspect aai-app --format '{{.State.Status}} / health={{if .State.Health}}{{.State.Health.Status}}{{else}}n/a{{end}}'

# 查看迁移、启动和错误日志
docker compose --env-file /opt/1panel/apps/ai-auto-image/.env -f /opt/1panel/apps/ai-auto-image/infra/docker-compose.yml logs --tail=200 app

# 本机健康检查
curl -fsS http://127.0.0.1:1235/api/health
~~~

健康接口应返回 ok: true 和 database: "ok"。如果 provider 显示 Mock，通常表示数据库中还没有启用渠道，或 TEXT_* / IMAGE_* 环境变量没有被正确导入；这不等于真实模型链路已经验证。

首次启动不需要手工执行 pnpm db:migrate，应用会自动执行随镜像复制的迁移。全新 PostgreSQL 不要执行 pnpm pg:import -- --truncate；该命令是旧 SQLite 数据迁移工具，不是数据库初始化命令。

如果修改了 .env，仅执行 docker compose restart 不一定会重新创建容器并应用新的环境变量。使用：

~~~bash
docker compose --env-file /opt/1panel/apps/ai-auto-image/.env -f /opt/1panel/apps/ai-auto-image/infra/docker-compose.yml up -d --force-recreate
~~~

不要使用 docker compose down -v 作为普通重启或更新命令，它会删除应用持久卷。

## 6. 在 1Panel 配置域名和 HTTPS

### 6.1 DNS

将业务域名的 A/AAAA 记录指向 Oracle 服务器的公网 IP，并等待 DNS 生效。若使用 IPv6，确认 VCN、实例和 1Panel 防火墙都已正确放行 443。

### 6.2 反向代理

在 1Panel 中创建网站/反向代理（不同版本菜单名称可能略有不同）：

1. 绑定你的域名。
2. 代理目标填写 http://127.0.0.1:1235。
3. 打开 WebSocket 支持（如果界面提供该选项）。
4. 将代理读取超时设置为至少 300 秒，避免长任务状态或流式响应被过早断开。
5. 配置证书并开启 HTTPS/强制 HTTPS。

反代至少应传递以下请求头；1Panel 通常可以通过图形化选项自动配置：

~~~nginx
proxy_http_version 1.1;
proxy_set_header Host $host;
proxy_set_header X-Real-IP $remote_addr;
proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
proxy_set_header X-Forwarded-Proto $scheme;
proxy_read_timeout 300s;
~~~

验证：

~~~bash
curl -fsS https://<你的域名>/api/health
~~~

公网只访问域名的 443，不要把 http://服务器IP:1235 当成正式入口。

## 7. 首个管理员和渠道验收

### 7.1 注册策略

当前策略是：

- 数据库中没有用户时，首次注册可以成为管理员，即使 REGISTER_ENABLED=0。
- 首个管理员创建后，REGISTER_ENABLED=0 会关闭后续公开注册。
- 如需增加普通用户，临时设置 REGISTER_ENABLED=1，建议同时设置 REGISTER_INVITE_CODE，完成后重新创建容器并立即改回 0。

首次访问 https://<你的域名>/login 或注册页面，创建管理员后立即验证登录、退出和重新登录。不要长期开放无邀请码的公网注册。

### 7.2 低风险真实链路

在“渠道设置”中分别确认文本和图片渠道：

- 端点 URL 以 /v1 和实际网关要求为准。
- 模型名与 Provider 实际支持的模型一致。
- 图片返回 url 时，服务必须能够立即下载并保存到自己的 /data。
- 图片返回 b64_json 时，服务直接解码并保存。
- 先以请求并发 1 生成一套最小内容，确认成功后再测试并发 2。
- 默认先使用 native 原生中文图片模式；需要像素级准确标题、价格、规格或 CTA 时，再在本次 Run 开启 deterministic 文字确定性渲染。
- 真实模型生成会产生费用，先用低额度测试账号和短主题。

### 7.3 部署验证脚本

~~~bash
cd /opt/1panel/apps/ai-auto-image
bash infra/verify-deployment.sh
~~~

脚本默认执行构建/启动、健康检查、无浏览器残留断言、/data 持久卷重启检查和内存基线采样；默认跳过真实生成，避免因为自动导入真实渠道而意外消费额度。

如果要执行已授权的真实生成烟测，需要手工登录后获取自己的 aai_session Cookie，并明确接受一次模型调用和点数消耗：

~~~bash
read -rs VERIFY_COOKIE
export VERIFY_COOKIE
export RUN_GENERATION_SMOKE=1
bash infra/verify-deployment.sh
unset VERIFY_COOKIE RUN_GENERATION_SMOKE
~~~

输入的 Cookie 应是完整的 aai_session=<value>，不要写入脚本、Git 或报告。脚本报告默认写入 infra/deployment-report.md；验证完成后检查报告是否包含敏感信息再保存。

## 8. 备份、恢复和磁盘管理

### 8.1 PostgreSQL 备份

优先使用 1Panel 的 PostgreSQL 备份功能，并定期将备份复制到服务器之外。命令行备份示例：

~~~bash
mkdir -p /opt/backups/ai-auto-image

docker exec <postgres-container> pg_dump \
  --no-owner --no-privileges -Fc \
  -U <db-user> -d <db-name> \
  > /opt/backups/ai-auto-image/pg_$(date +%F_%H%M%S).dump
~~~

备份完成后确认文件大小、权限和可读性；不要只备份应用的 /data，因为用户、Run、计费、订单和渠道配置都在 PostgreSQL。

### 8.2 /data 资产备份

应用的图片资产和导出包在 Docker 持久卷中。备份期间可短暂停止应用，减少文件正在写入的概率：

~~~bash
cd /opt/1panel/apps/ai-auto-image
mkdir -p /opt/backups/ai-auto-image

docker compose --env-file /opt/1panel/apps/ai-auto-image/.env -f /opt/1panel/apps/ai-auto-image/infra/docker-compose.yml stop app

docker run --rm --volumes-from aai-app \
  -v /opt/backups/ai-auto-image:/backup \
  alpine:3.20 \
  sh -c 'tar czf /backup/aai-data_$(date +%F_%H%M%S).tar.gz -C /data .'

docker compose --env-file /opt/1panel/apps/ai-auto-image/.env -f /opt/1panel/apps/ai-auto-image/infra/docker-compose.yml start app
~~~

同时备份服务器上的 .env（使用受控权限和安全存储，不要提交 Git），因为没有 APP_SECRET 就无法解密渠道密钥。备份 PostgreSQL、/data 和 .env 才能构成可恢复组合。

### 8.3 恢复原则

恢复是有破坏性的操作，必须先停止应用、确认备份文件和目标数据库，再执行：

1. 停止 aai-app。
2. 按 PostgreSQL 官方/1Panel 流程恢复数据库备份。
3. 将 /data 资产包恢复到应用持久卷。
4. 恢复与渠道密文匹配的 APP_SECRET。
5. 启动应用并检查迁移、健康接口、登录、历史 Run 和资产 URL。
6. 先在测试域名验证，再切换正式域名。

至少每月做一次恢复演练；“备份文件存在”不等于“备份可恢复”。

## 9. 更新、回滚和常见故障

### 9.1 正常更新

~~~bash
cd /opt/1panel/apps/ai-auto-image
git fetch origin
git pull --ff-only origin main
docker compose --env-file /opt/1panel/apps/ai-auto-image/.env -f /opt/1panel/apps/ai-auto-image/infra/docker-compose.yml up -d --build
docker compose --env-file /opt/1panel/apps/ai-auto-image/.env -f /opt/1panel/apps/ai-auto-image/infra/docker-compose.yml ps
docker compose --env-file /opt/1panel/apps/ai-auto-image/.env -f /opt/1panel/apps/ai-auto-image/infra/docker-compose.yml logs --since=5m app
curl -fsS http://127.0.0.1:1235/api/health
~~~

更新前后记录：

~~~bash
git rev-parse --short HEAD
docker images --no-trunc --format '{{.Repository}}:{{.Tag}} {{.ID}}'
~~~

### 9.2 回滚

回滚前先备份 PostgreSQL 和 /data，记录当前提交。然后切换到已经验证过的提交或标签，重新构建：

~~~bash
cd /opt/1panel/apps/ai-auto-image
git fetch origin
git log --oneline -5
# 选择已验证的提交/标签后再执行切换
git switch --detach <known-good-commit>
docker compose --env-file /opt/1panel/apps/ai-auto-image/.env -f /opt/1panel/apps/ai-auto-image/infra/docker-compose.yml up -d --build
docker compose --env-file /opt/1panel/apps/ai-auto-image/.env -f /opt/1panel/apps/ai-auto-image/infra/docker-compose.yml logs --since=5m app
curl -fsS http://127.0.0.1:1235/api/health
~~~

如果新版本已经执行了不可逆 Schema 变更，代码回滚不一定足够，必须按备份恢复数据库。不要在没有备份的情况下使用 --truncate 导入或删除生产卷。

### 9.3 故障表

| 现象 | 先查什么 | 常见原因 |
| --- | --- | --- |
| Compose 配置校验失败 | docker compose ... config --quiet | .env 缺失、APP_SECRET/数据库未配置、外部网络名错误 |
| 容器反复重启 | docker compose ... logs --tail=200 app | PostgreSQL 不可达、迁移失败、密钥缺失、内存不足 |
| /api/health 返回 500 | 容器日志 + PostgreSQL 网络 | 数据库 URL、容器网络、账号权限或迁移问题 |
| 页面打不开 | 绑定地址、1Panel 反代、证书、Oracle 入站规则 | `APP_BIND_ADDRESS` 仍为回环、代理目标写错、1235/443 未按访问方式放行 |
| Docker 构建提示字体目录不存在 | 构建日志和 `scripts/fetch-fonts.sh` | 旧版本未在构建阶段下载字体；更新到包含自动下载的版本后重新构建 |
| 健康正常但显示 Mock | 设置页渠道列表 | TEXT_*/IMAGE_* 未自动导入，或渠道被禁用 |
| 渠道密钥解密失败 | APP_SECRET 是否与录入时一致 | 更换了主密钥或迁移时未带旧密钥 |
| 任务一直排队 | Run/Job 状态、Provider 限流、docker stats | 外部接口慢、并发上限过低或 Provider 限流 |
| 大图生成后 OOM | docker stats、容器退出码、图片分辨率 | 后处理并发过高；先把默认并发降到 1 |
| 支付状态异常 | 订单、回调验签、点数流水 | 域名回调错误；生产不会启用 mock 支付 |
| 重启后图片丢失 | docker inspect aai-app 的 Mounts | 误用了临时容器或执行了 down -v |

## 10. 上线前检查清单

- [ ] 服务器架构、Docker、Compose、磁盘和内存已记录。
- [ ] 生产反代模式下 Oracle VCN 和 1Panel 只开放必要端口；1235/5432/6379 未暴露公网。
- [ ] PostgreSQL 数据库已创建，应用与数据库共享正确 Docker 网络。
- [ ] DATABASE_URL 未使用容器内的 localhost。
- [ ] APP_SECRET 已设置并安全备份；迁移旧渠道时密钥一致。
- [ ] 根目录 .env 权限受限，未进入 Git 或 Docker 镜像。
- [ ] PAYMENT_MOCK_ENABLED=0，公网注册已关闭或有邀请码。
- [ ] /data 持久卷和 PostgreSQL 均有备份。
- [ ] 1Panel 反向代理指向 http://127.0.0.1:1235，HTTPS 已生效。
- [ ] /api/health 返回 ok: true、database: "ok"。
- [ ] 已完成一次登录、渠道连通性和低额度真实生成测试。
- [ ] native 原生中文模式和 deterministic 确定性文字兜底各抽样验证。
- [ ] 已记录应用版本、并发配置、Provider 响应时间、CPU、内存、磁盘和错误日志。
- [ ] 已知 infra/verify-deployment.sh 默认不调用真实模型，真实烟测必须显式授权。

## 11. 端口、目录和安全命令速查

| 项目 | 当前值 |
| --- | --- |
| 应用宿主机端口 | `${APP_BIND_ADDRESS:-127.0.0.1}:1235` |
| 容器监听端口 | 1235 |
| 应用容器 | aai-app |
| 应用持久目录 | /data |
| Compose 文件 | infra/docker-compose.yml |
| 部署路径示例 | /opt/1panel/apps/ai-auto-image |
| 健康接口 | http://127.0.0.1:1235/api/health |
| 正式入口 | https://<你的域名>/ |

日常只使用以下命令查看和更新，不要把删除卷当作重启手段：

~~~bash
docker compose --env-file /opt/1panel/apps/ai-auto-image/.env -f /opt/1panel/apps/ai-auto-image/infra/docker-compose.yml ps
docker compose --env-file /opt/1panel/apps/ai-auto-image/.env -f /opt/1panel/apps/ai-auto-image/infra/docker-compose.yml logs --tail=200 app
docker stats aai-app --no-stream
docker compose --env-file /opt/1panel/apps/ai-auto-image/.env -f /opt/1panel/apps/ai-auto-image/infra/docker-compose.yml up -d --build
~~~
