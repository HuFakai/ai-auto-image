# 开发进度文档

> 更新时间：2026-08-30
> 对照基准：[总体开发规划](./02-master-development-plan.md) · [阶段文档 00–04](./README.md) · [迭代路线图](./03-implementation-review-and-roadmap.md)

## 一、总览

产品「AI 图文工坊」：输入主题/长文/URL，自动生成可直接发布到小红书/抖音/公众号的成套中文图文。
当前处于**阶段 3（迭代 4）进行中**，核心创作闭环（知识卡片 + 科普漫画）已全部真实跑通。

| 阶段 | 内容 | 完成度 | 出口剩余 |
|---|---|---|---|
| 阶段 0 | 工程基础与技术验证 | ~95% | Linux 服务器 Docker 实测（脚本就绪） |
| 阶段 1 | 图文生成 MVP | ~85% | 20 套作品人工评审 |
| 阶段 2 | 漫画与高级视觉 | ~80% | Scene Bible 完整版、多模态一致性检查（待视觉渠道） |
| 阶段 3 | 基建与发布 | ~40% | PG 侧导入演练、Redis Worker、画布、MCP、鉴权 |
| 阶段 4 | 平台化 | 未启动 | 按需启动 |

## 二、已完成功能

### 1. 工程与基础设施
- TypeScript Monorepo（pnpm + Turborepo）：`apps/web` + 9 个 packages，TypeScript strict
- SQLite 存储：Drizzle ORM，15 张表（三次迁移入库），WAL/外键/busy_timeout，Repository 层隔离
- 进程内 Job Runner：租约/心跳续租（Runner 职责化）/看门狗回收/幂等键复用/重启恢复/单页局部重试
- 真实调用验证：deepseek 文本 + grok/gpt-image-2 图片，双渠道多轮回合零错字
- 资产管理：`.part` 原子写 + 魔数校验 + 流式下载 + SHA-256 血缘

### 2. 模型渠道（设置页可视化管理）
- 多渠道管理：文本/图片分离，支持添加多个、启停、↑↓优先级排序、连通测试（GET /models）
- 密钥 AES-256-GCM 加密落库（APP_SECRET 派生），界面只显示末四位
- 保存即时热生效；`.env` 渠道首启自动导入，环境变量降级为可选回退
- 能力声明：图生图开关（imageEditSupport）→ 能力表 → 能力路由
- 已适配网关差异：WAF UA 拦截、aspect_ratio/size 参数风格、b64_json/url、
  multipart 编辑上传、推理模型输出预算、流式 chat（根治网关 ~2min 断连）

### 3. 创作管线
- **知识卡片**：Brief → Storyboard → 逐页生成 → 导出；长文密度拆页（6–10 页，实测 415 字拆 8 页）
- **科普漫画**：角色锚点 → 定妆图（文生图）→ 分镜（一致性检查）→ 逐页图生图（定妆图参考，角色跨页一致）→ 气泡合成；实测 5–6 页
- **双文字渲染**：native 原生中文（默认，模型直接出图）/ deterministic 确定性排版（Satori+Sharp，六套内置主题+Logo，字节级可复现，溢出自动检出）
- **双并发控制**：图片 API 并发与 Sharp 后处理并发分开；有效并发 = min(请求, 服务器, Provider)
- 审批门：requireApproval → awaiting_approval 挂起 → 评审通过放行/驳回终止；导出门禁

### 4. 编辑与交付
- 单页返修（Revision 版本链）：改文案重出图（native）/ 零费用重排（deterministic），旧版本保留
- 局部重绘框架：repaint API（归一化区域 + Mask 构建 + 图生图 + 整页降级）
- ZIP 导出：按序图片 + LLM 发布文案（失败降级模板）+ manifest + 发布清单
- 评审：通过/驳回/复位 + 列表筛选
- URL 抓取（实验能力，SSRF 防护）+ 图片上传（三重检查）+ LLM 平台文案生成

### 5. Web Studio（纸感印刷设计）
- 工作台：作品集卡片网格（封面+状态章+评审筛选）+ 底部悬浮创作条（主输入+可展开参数区）
- 运行详情：逐页相纸画廊（显影动画/返修面板/模型标注）、生成信息版权页
  （内容类型/文字模式/Brand Kit/渠道模型/每页实际模型/并发/定妆图/模板/用量费用）
- 设置页：渠道管理 + Brand Kit 管理（主题色卡预览）
- 结构化 JSON 日志（密钥脱敏）+ /api/health

### 6. 工程质量
- 71 项自动化测试全绿（单元 + 集成：全流程/单页重试/重启恢复/取消/审批门/ZIP 顺序/SSRF/文本提取/确定性渲染）
- `pnpm eval` 评测：6 用例双模式，解析/渲染成功率指标（阈值 99%/99.5%）
- 真实验证脚本：`pnpm verify:live|openai|xai`（报告入 fixtures/reports）
- 全仓 lint/typecheck/test/build 全绿；多阶段 Dockerfile + compose（待服务器实测）
- ADR×5（模型层/SQLite 作业/双模式渲染/持久卷/PG 迁移策略）

## 三、剩余功能

### 阶段 0/1 出口
- [ ] Linux 服务器 Docker 实测（`bash infra/verify-deployment.sh`，脚本已就绪）
- [ ] 1C1G 内存基准报告（空闲 ≤250MB / 单页峰值 ≤700MB）
- [ ] 20 套不同主题作品人工评审（批量生成脚本待补）

### 阶段 2 补全
- [ ] Scene Bible 完整版、参考图管理细节（预算/压缩/授权字段）
- [ ] 多模态一致性检查（需视觉模型渠道，接口已预留）
- [ ] 局部重绘框选 UI（API 已就绪）；原生 Mask 待网关支持

### 阶段 3（迭代 4 剩余，当前进行中）
- [ ] Redis/BullMQ 独立 Worker 拆分（`apps/worker`，需 Redis 环境）
- [ ] React Flow 可编辑工作流画布
- [ ] MCP Server（七工具：create/generate/status/revise/export/validate-draft/create-draft）
- [ ] 开放 API Key 鉴权中间件 + Scope + 限流
- [ ] PG 侧导入与双读演练（导出工具已就绪：`pnpm pg:export`）

### 阶段 4（迭代 5，按需启动）
- [ ] 登录会话 + RBAC（**公网部署前必须**，当前仅限内网）
- [ ] 数据回流（CSV 导入 + 表现数据）、复盘与 A/B 实验
- [ ] 模板/Recipe 市场、计费基础

## 四、接下来的规划

| 批次 | 内容 | 说明 |
|---|---|---|
| 迭代 4·第二批 | MCP Server + 开放 API 鉴权限流 | 可本机验证，与 Claude 等客户端打通生成全流程 |
| 迭代 4·第三批 | React Flow 工作流画布 | 替换简化只读链路图为可编辑画布 |
| 迭代 4·第四批 | Redis/BullMQ Worker + PG 导入演练 | 需 Redis/PG 环境（服务器或本机 Docker） |
| 迭代 4·收尾 | 批量生成脚本 + 20 套评审 → 阶段 1 正式出口；服务器 Docker 实测 → 阶段 0 正式出口 | 两个阶段的验收收尾 |
| 迭代 5 | 阶段 4 平台化 | 公网部署则 RBAC 提前 |

## 五、已知限制与风险

1. **单用户假设**：无登录/RBAC，仅限内网/VPN 部署；公网暴露前必须实现认证。
2. **渠道依赖**：漫画角色一致性依赖支持图生图的渠道（gpt-image-2 已启用）；grok 渠道仅文生图。
3. **多模态审查缺失**：原生文字准确性检查需视觉模型渠道（TEXT_VISION=1），当前渠道不支持，已降级为规则检查+人工核对。
4. **PG/Redis 侧未演练**：迁移工具与手册已交付，端到端演练需具备环境后执行。
5. **历史数据**：早期运行的部分展示字段（如页级模型）为旧格式，新生成的运行数据完整。
