# 接下来的开发方案 v2（登录注册 → 内容类型 → 品牌手册 → 服务器部署）

> 更新时间：2026-08-30（v2，按最新需求重写，替代上一版）
> 依据：[开发进度文档](./progress.md) · [调研报告](./01-research-and-reference.md) · [路线图](./03-implementation-review-and-roadmap.md)
>
> **方向变更**：
> - ❌ 移除：React Flow 画布、MCP Server、开放 API Key 鉴权（原迭代 4 的 4.4/4.5/4.6，暂不做）
> - ✅ 新增优先：用户登录注册（公网部署前提）、内容类型扩展、Brand Kit/品牌手册增强
> - 🎯 部署目标：1Panel 服务器（已备 PostgreSQL 实例 + Redis 容器）

## 一、批次总览

| 批次 | 内容 | 依赖 | 预估 |
|---|---|---|---|
| 1 | PostgreSQL 切换（存储层双驱动 + Repository async 化 + 数据导入） | 本机可开发，最终连服务器 PG | 3–4 天 |
| 2 | 用户登录注册（会话 + 角色 + 资源隔离） | 批次 1（users 表直接建在 PG） | 2–3 天 |
| 3 | 服务器部署上线（1Panel + Docker + HTTPS） | 批次 1、2 | 1 天 |
| 4 | 内容类型扩展（金句卡/清单卡/对比卡/产品种草/图书推荐/长文拆解/四格漫画） | 上线前后皆可 | 每类 0.5–1.5 天 |
| 5 | Brand Kit / 品牌手册增强 | 批次 4 部分联动 | 2–3 天 |
| 6（可选） | BullMQ Worker 拆分 | Redis（服务器已备） | 2–3 天 |

上线关键路径 = 批次 1 → 2 → 3（约一周）；批次 4/5 是上线后的能力增强，可与使用并行推进；批次 6 单机自用场景收益有限，列为可选。

---

## 批次 1：PostgreSQL 切换 ✅（2026-08-30 完成）

> 实施记录（与原计划的差异）：最终未采用「SQLite/PG 双 schema + repo 类型退化」方案，而是**直接全量切换 PG 方言**——
> schema.ts 重写为 pgTable（15 表，含批次 2 预留的 users/sessions）；测试用进程内 PGlite（WASM PostgreSQL，drizzle 官方驱动，
> 零网络零 Docker）；生产/远程开发用 postgres.js（`DATABASE_URL`）。一套 schema 一套 SQL，类型全保留。
> 迁移已在甲骨文服务器 PG（134.185.113.0/ai_image，aarch64）建库，`pg:export → pg:import` 演练通过（3 渠道 + 6 Brand Kit 入库，校验和一致）；
> 本机 web 连远程 PG 启动，`/api/health` 与 `/api/runs` 验证通过。17 项 workflow-engine 测试在 PGlite 上全绿。

**为什么先做**：登录注册要建 `users`/`sessions` 表，先把数据库形态定型为 PG，避免 SQLite 建完再迁移一次；服务器 PG 已就绪；路线图阶段 3 本就规划 PG。

**现状约束**（决定工作量）：
- Repository 层是**同步 API**（better-sqlite3 特性，`repositories.ts` 中 0 个 async），PG 驱动是异步的，必须把 repo 方法全部 async 化，并适配 `workflow-engine` 管线与全部 route 调用点。
- drizzle 两个方言的查询语法高度一致（`repositories.ts` 中的 `sql` 模板均为列引用，无 SQLite 特有函数），机械改造为主。
- schema 需要两份：`schema.ts`（sqliteTable，保留给测试内存库）+ `schema.pg.ts`（pgTable），加一个一致性单测对齐表名/列名防漂移。

**任务**：
1. `packages/storage`：新增 `schema.pg.ts` 与 `openPostgresDatabase({ connectionString })`（drizzle pg + `postgres.js`）；时间戳列统一 timestamptz。
2. Repository 方法 async 化；SQLite 实现包装为 Promise（签名统一）；`workflow-engine` 管线、`apps/web` routes、scripts 的调用点补 `await`。
3. 迁移：drizzle-kit 生成 PG 迁移；`pnpm db:migrate -- --pg` 支持 PG 入库；测试默认仍跑 SQLite 内存（快），新增 PG 集成测试（连服务器 PG 或本机 Docker）。
4. 补 `scripts/pg-import.mts` + `pnpm pg:import`（`pg:export` 已就绪）：13 表 JSONL 导入服务器 PG，行数/校验和核对——用于把本地已有的渠道配置、Brand Kit、历史作品带上服务器（可选执行，服务器全新开始也可以）。
5. 配置：`.env` 增加 `DATABASE_URL=postgres://ai_image:<密码>@1Panel-postgresql-VkBl:5432/ai_image`（PG 容器已确认：`1Panel-postgresql-VkBl`，postgres:18.4-alpine，宿主已映射 5432；web 容器加入同一 Docker 网络后用容器名直连）。

**验收**：全仓测试绿 + PG 集成套通过；以 `DATABASE_URL` 指向服务器 PG 启动 web，创建 run → 生成 → 导出全流程正常。

---

## 批次 2：用户登录注册

**为什么**：部署到公网服务器后，创作入口（消耗付费模型额度）必须登录才能访问。原路线图 5.1 提前，角色按自用场景简化为 admin/user 两级（六角色 RBAC 不做）。

**登录形式（已定）**：本期只做**账号密码**最简形式；认证层按可插拔设计，为微信小程序扫码登录预留扩展位：
1. 表：`users(id, username, password_hash, role[admin|user], status, auth_provider[password|wechat_mp], provider_subject, created_at)`、`sessions(id, user_id, token_hash, auth_provider, expires_at, created_at)`（DB 会话，可随时吊销）。
2. 密码哈希：`node:crypto` 的 **scrypt**（零原生依赖，Docker 交叉编译无风险），格式 `scrypt$N$r$p$salt$hash`；`auth_provider != 'password'` 的用户 `password_hash` 为空、不可走密码登录。
3. 会话：httpOnly + Secure + SameSite=Lax cookie（随机 token，服务端存 SHA-256 摘要）；`/login`、`/register` 页面 + 登录/登出/注册 API；登录页预留「微信扫码」禁用入口。
4. **注册策略（防白嫖关键）**：首个注册用户自动成为 admin；`REGISTER_ENABLED`（默认关闭）+ `REGISTER_INVITE_CODE` 邀请码双开关——公网上不开放随意注册。
5. 保护实现（App Router 模式，不用 Edge middleware，避免其无法访问 DB）：
   - 页面：根布局/各页面 server component 读 cookie → `requireUser()` → 未登录 redirect `/login`；
   - API：`requireUser(request)` 包装，未登录 401；
   - `/login` `/register`、`/api/health`、`/api/auth/*` 为白名单。
6. 资源隔离：`projects`/`workflow_runs` 加 `user_id` 列，普通用户只见自己的作品；admin 可见全部。渠道管理、Brand Kit 写操作、设置页仅 admin。
7. 登录/登出事件写入结构化日志（含 IP），为审计打底。
8. 微信扩展位（本期只留数据结构与接口形状，不实现）：小程序端 `wx.login` code → 服务端 `code2Session` 换 openid → 按 `provider_subject` 建档/匹配 → 签发同一套 session cookie；后续把 `/api/auth/wechat` 路由挂进现有 `requireUser()` 体系即可，页面与权限层零改动。

**验收**：未登录访问任意页面/API 被拒；用户 A 查不到用户 B 的 run；关闭注册时 `/api/auth/register` 拒绝；admin 与 user 的设置页权限边界测试覆盖。

---

## 批次 3：服务器部署上线（1Panel）

**任务**：
1. `infra/docker-compose.yml` 改造：web 使用外部 PG/Redis（不再内嵌 SQLite 依赖清单），环境变量注入：
   - `DATABASE_URL=postgres://ai_image:<密码>@1Panel-postgresql-VkBl:5432/ai_image`（web 容器需加入 1Panel 的 Docker 网络或声明 external network；备选走宿主映射端口 + 宿主网关 IP）
   - `REDIS_URL=redis://:<密码>@1Panel-redis-d67m:6379`（批次 6 才真正用到，先配上）
2. **服务器为甲骨文 4 核 24G**（内存充裕，原 1C1G 内存基准任务取消；`IMAGE_GENERATION_CONCURRENCY_MAX` 可上调至 4–8，实际瓶颈在渠道 Provider 侧限速）。注意甲骨文免费/常规 4C24G 多为 **Ampere ARM（A1）**：部署前 `uname -m` 确认架构；若是 aarch64，Docker 镜像在服务器上直接 build（better-sqlite3/sharp 均有 arm64 预编译，无需交叉编译），或本机 buildx 指定 `linux/arm64`。
3. 数据卷：`DATA_DIR`（assets/exports）挂宿主目录持久化；PG 数据备份交给 1Panel 自带备份计划。
4. 1Panel「网站」反代（OpenResty）+ HTTPS 证书绑定域名；仅 443 对外，web 容器端口不直接暴露公网；**甲骨文双层防火墙都要放行 80/443**（云控制台安全列表 + 实例内 iptables，1Panel 通常已代管后者）。
5. 上线清单执行（`docs/deployment-checklist.md`）：`APP_SECRET` 生成新值、字体资产进镜像、`pnpm verify:live` 冒烟。

**安全提醒（重要）**：
- 你在对话中贴出了 PG/Redis 密码——这两个密码**只写进服务器上的 `.env`**（`.gitignore` 已忽略，不会进 git）；**建议上线前在 1Panel 轮换一次**。
- Redis 有密码且仅容器内网互通，不要在 1Panel 里给它开公网端口映射。

**验收**：公网 HTTPS 域名可访问，登录后完成 知识卡片/漫画 创作→评审→导出闭环；`docker compose restart` 后未完成任务恢复。

---

## 批次 4：内容类型扩展（参考调研报告 §2/§3 提炼）

现有 Recipe 仅两种：`knowledge_cards`（知识卡片）、`comic_story`（科普漫画）（`shared-schemas/src/comic.ts` 的 `RecipeSchema`）。参考调研文档中的 GitHub 项目（md2card、XHS-TextCard、乔木信息卡、content-pilot、AIComicBuilder 等）与 Agent Skills（social-media、visual-content、self-media-content-workflow），新增内容类型按「复用现有基建（渠道路由/JobRunner/审批门/返修/导出），每个 Recipe = 输入 Schema + Prompts + Pipeline 注册 + 渲染布局 + 评测用例」交付：

| 优先级 | 新 Recipe | 说明 | 主要复用 |
|---|---|---|---|
| P0 | `quote_cards` 金句/语录卡 | 主题→金句提炼→3–6 页大字排版，deterministic 直出，几乎零图片费用，最快见效 | 确定性渲染、拆页逻辑 |
| P0 | `checklist_cards` 清单/攻略卡 | 步骤/清单密度拆页（md2card 的密度分页思路），编号布局 | 确定性渲染 |
| P1 | `comparison_cards` 对比/测评卡 | 两对象对比表 + 结论页；render-engine 增加表格布局 | 确定性渲染 |
| P1 | `product_showcase` 产品种草/图文带货 | 商品资料（可上传实拍图）→ 卖点提炼 → 首图 + 3–5 卖点图；实拍图走图生图 | 图片上传、图生图（gpt-image-2 已启用） |
| P1 | `book_recommendations` 图书推荐卡 | 书名/作者/金句/推荐理由，书封可 AI 生成或占位 | 确定性渲染 |
| P2 | `article_digest` 长文拆解 | URL 抓取（已有实验能力）→ 结构化要点 → 3–8 图；与知识卡片的差异是忠实原文结构而非围绕主题创作 | URL 抓取 |
| P2 | `strip_comic` 四格/条漫 | comic_story 的画幅与页数变体（4 格、3:4），复用定妆图与一致性链 | 漫画管线 |

**节奏**：每批交付 2 个类型；每个类型包含 Schema 枚举扩展、pipeline、eval 评测用例、创作条 UI 选项、导出文案模板。

**验收**：每个新类型端到端产出 ≥3 套样例过人工评审，`pnpm eval` 指标达标。

---

## 批次 5：Brand Kit / 品牌手册增强

现状：`brand_kits` 仅 themeId + style/negative keywords + logoAssetId（设置页有色卡预览）。对标 visual-content skill 与 XHS-TextCard 的模板能力（封面/正文/水印/签名）增强：

1. **品牌信息**：品牌名称、slogan、页脚签名（如 `@账号名`）。
2. **水印**：文字水印（内容/位置/透明度）或 Logo 水印，导出图统一叠加。
3. **字体**：标题/正文内置中文字体选择（`fetch-fonts` 字体管线已有，扩充可选字体清单）。
4. **色板覆盖**：主色/辅色/强调色/背景色覆盖内置主题变量（deterministic 模式全量生效；native 模式注入风格描述）。
5. **封面模板**：标题区布局（大字居中/左对齐/上下分割）、封面徽标。
6. **实时预览**：设置页用确定性渲染直出预览样张（零模型费用），所见即所得。

**验收**：同一内容切换不同 Brand Kit 产出可辨识的差异化成图；水印/签名在导出 ZIP 中可见。

---

## 批次 6（可选）：BullMQ Worker 拆分

**是什么**：现状生成任务跑在 Next.js web 进程内（JobRunner）。BullMQ 是基于 Redis 的 Node 任务队列库——拆分后 web 只负责接收请求/入队/展示状态，独立 `apps/worker` 进程从 Redis 领任务、真正调模型生图。

**收益**：① 重启/升级 web 不中断进行中的生成；② 生成负载与网站进程内存隔离；③ 未来可多 worker 并行扩容。
**代价**：多维护一个进程；需要 Redis（你已有）。
**建议**：单机自用、并发 1–4 的场景，进程内方案完全够用，**先不拆**；等需要频繁热更新 web 或感觉生成卡顿影响页面时再做。实施方案沿用：装配下沉共享包 → `JobPort` 双实现（memory|bullmq，`JOB_DRIVER` 切换）→ compose 加 worker 服务。

---

## 不做清单（本轮明确移除）

| 原任务 | 处置 |
|---|---|
| React Flow 可编辑画布（4.4） | 移除；运行详情保留现有只读链路图 |
| MCP Server（4.5） | 移除；未来需要接入 Claude 等客户端时与 API 鉴权一起重启 |
| 开放 API Key 鉴权（4.6） | 移除；公网安全由批次 2 的登录会话覆盖 |
| 阶段 4 数据回流/市场/计费 | 维持按需启动 |

## 风险与对策

1. **Repository async 化波及面大**：批次 1 最重的一项，靠「签名统一后由 TypeScript 编译器暴露全部调用点」逐个补 await，71 项现有测试兜底。
2. **公网安全边界**：批次 2 上线前不暴露 3000 端口；注册默认关闭；`APP_SECRET`、PG/Redis 密码只存服务器 `.env`。
3. **PG 迁移数据取舍**：本地历史数据若无保留价值可直接空库上线，省去 `pg:import` 的核对工作（渠道和 Brand Kit 在设置页重建即可）。
4. **内容类型膨胀**：严格按 P0→P2 节奏，每个类型必须带 eval 用例，防止管线质量被稀释。
