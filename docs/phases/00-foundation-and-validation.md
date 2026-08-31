# 阶段 0：工程基础与技术验证

> 文档定位：原始阶段范围与验收基线。实现已发生演进，本文中的 SQLite 和阶段勾选不代表当前待办；当前执行以 [当前状态](../current-status.md) 和 [当前路线图](../current-roadmap.md) 为准。

## 1. 阶段目标

建立可持续开发的工程基础，并通过小型技术验证消除最关键的不确定性。本阶段不追求完整产品界面，重点证明以下链路可行：

1. 同一业务请求可以切换 OpenAI 与 Grok。
2. 结构化 Storyboard 可以稳定生成和校验。
3. 主力图片模型可以直接生成包含中文的完整图卡，并可切换到程序文字合成兜底。
4. 长任务可以入队、重试、取消和恢复。
5. 所有模型调用和资产都有可追溯记录。

## 2. 范围

### 包含

- 初始化 Git、pnpm、Turborepo 和基础工程。
- 建立 Web、进程内 Job Runner 和共享 Package。
- SQLite 持久化、服务器文件存储和单容器 Docker 部署环境。
- OpenAI、xAI、OpenAI-compatible Provider 原型。
- Storyboard Schema 和一个最小知识卡片 Schema。
- 原生文字图片链路，以及可选的 Satori/SVG + Sharp 确定性文字链路。
- 基于 SQLite `jobs` 表的作业生命周期。
- 基础日志、成本和错误归一化。
- 固定样例与初始评测集。

### 不包含

- 完整产品界面。
- 平台发布。
- 漫画角色连续性。
- 可视化工作流编辑器。
- 多租户计费。

## 3. 工程初始化

建议目录：

```text
apps/
  web/

packages/
  ai-core/
  provider-openai/
  provider-xai/
  provider-compatible/
  shared-schemas/
  workflow-engine/
  render-engine/
  config/

infra/
  docker-compose.yml

fixtures/
  inputs/
  expected/
```

初始化内容：

- TypeScript strict 模式。
- ESLint、Prettier 和统一 `tsconfig`。
- Vitest 单元测试。
- Sharp/pixelmatch 渲染视觉快照测试。
- 可选的 Playwright Web E2E 测试只在 CI 专用镜像中运行，不安装进生产镜像。
- `.env.example`，不提交真实 Key。
- Conventional Commits 或明确的提交规范。
- CI 执行 lint、typecheck、test 和 build。
- 生产镜像使用多阶段构建，只复制 standalone 运行文件和必要字体。
- 容器设置内存、CPU、日志和健康检查限制。

## 4. 统一 Schema

### 4.1 最小 Content Brief

```ts
type ContentBrief = {
  topic: string;
  audience: string;
  objective: "educate" | "promote" | "convert" | "recommend";
  coreMessage: string;
  evidence: Array<{
    claim: string;
    source?: string;
    confidence: "verified" | "provided" | "inferred";
  }>;
  tone: string[];
  callToAction?: string;
  prohibitedClaims: string[];
};
```

### 4.2 最小 Storyboard

```ts
type Storyboard = {
  title: string;
  platform: "xiaohongshu" | "douyin" | "wechat";
  aspectRatio: "3:4" | "9:16" | "1:1" | "16:9";
  slides: Array<{
    index: number;
    role: "cover" | "content" | "summary" | "cta";
    headline: string;
    body: string[];
    visualIntent: string;
    layoutHint: string;
  }>;
};
```

所有 LLM 结构化输出必须经过 Zod 校验。校验失败时允许一次“带错误信息的修复调用”，仍失败则终止节点并返回可诊断错误。

## 5. AI Provider Spike

### 5.1 统一调用接口

完成以下接口的最小实现：

- `generateText`
- `generateObject`
- `generateImage`
- `editImage`
- `getCapabilities`

### 5.2 OpenAI 验证项

- 文本生成和结构化 Storyboard。
- 图片生成，统一读取 URL 或 Base64。
- 图片编辑或参考图能力。
- 超时、限流和内容安全错误。

### 5.3 xAI/Grok 验证项

- 使用 xAI Provider 或 OpenAI SDK + xAI Base URL 生成文本。
- `/v1/images/generations` 图片生成。
- `/v1/images/edits` 参考图编辑。
- 临时图片 URL 下载并转存到 Docker 持久卷中的资产目录。
- 读取 xAI usage/cost 字段并转换为统一成本记录。

### 5.4 OpenAI-compatible 验证项

- 自定义 Base URL、Header 和模型名。
- 能力显式配置，不根据模型名猜测。
- 非标准返回值通过独立 Response Extractor 处理。

## 6. Render Engine Spike

制作三张固定知识卡片：封面、正文、总结。

验证两种文字模式：

### 原生文字模式（默认）

- 使用 `grok-imagine-image-2.0` 和 `gpt-image-2` 直接生成包含指定中文的完整图片。
- 保存 Prompt 中的预期文案，并记录生成图的文字审查结果。
- 图片以流方式写入 `/data/assets`，不把多个完整大图同时缓存在内存。
- 不执行 Satori 文字合成，只进行必要的格式、尺寸和安全校验。

### 确定性文字模式（默认关闭）

- 适合固定组件、高性能批量输出。
- 加载中文字体。
- 输出 1242×1656 或等比例预览图。
- 检测文字区域是否越界。
- 验证从原生模式切换后，可以按无文字视觉 Prompt 重新生成当前页面并叠加准确文字。

### Playwright 的边界

- 不作为初期生产渲染器，不进入生产 Docker 镜像。
- 如需验证 Web 创建向导、编辑器和导出流程，可在 CI 的独立测试环境中按需安装 Chromium 后运行。
- 如果后期确实出现 Satori 无法支持的复杂 HTML/CSS 模板，再以独立、按需启动的渲染服务评估引入。

首版仍保留统一 `Renderer` 接口，避免未来新增渲染器时修改业务层。

## 6.1 模型渠道并发 Spike

- 文本与图片渠道分别保存 `concurrencyMax`，默认 `0` 不限制。
- 正整数上限由同一渠道的所有用户和任务共享。
- 验证渠道上限 0、1、2、4 时的实际峰值调用数和排队行为。
- 验证整套生成、封面、返修和图生图不会绕过渠道并发门。
- 验证 429、超时、取消和指数退避。

## 7. 工作流 Spike

最小节点：

```text
parse-input
  → generate-brief
  → generate-storyboard
  → generate-images（按用户配置并行）
  → render-slides（仅确定性文字模式）
  → package-export
```

每个 Node Run 必须保存：

- 输入和输出引用。
- 状态和尝试次数。
- Provider、模型和 Prompt 版本。
- 开始、结束时间。
- Token、图片数量和费用。
- 错误类型和错误摘要。

## 8. 数据库最小表

- `projects`
- `workflow_runs`
- `node_runs`
- `prompt_versions`
- `assets`
- `asset_relations`
- `provider_usages`
- `jobs`

数据库采用 SQLite，开启 WAL、外键和 `busy_timeout`。迁移脚本必须进入版本控制，并提供测试种子数据。领域代码通过 Repository 接口访问数据库，避免把 SQLite 特有 SQL 扩散到业务层，为中期迁移 PostgreSQL 做准备。

## 9. 测试计划

### 单元测试

- Provider 请求转换。
- Provider 返回值归一化。
- Zod Schema 校验和修复逻辑。
- 作业状态转换。
- 成本计算。
- 文字尺寸和溢出检测。

### 集成测试

- 使用 Mock Provider 完成全流程。
- Docker 持久卷资产写入和下载。
- 应用中断后从 SQLite `jobs` 表恢复任务。
- 单个页面失败后仅重试该页面。

### 手工验证

- OpenAI 真实调用一次。
- Grok 真实调用一次。
- 两种 Provider 生成同一 Storyboard Schema。
- 图片临时 URL 被成功转存。

## 10. 交付物

- 可运行的 Monorepo。
- 面向 Linux 服务器的单服务 Docker Compose、持久卷和健康检查。
- Provider 接口和三个 Provider 原型。
- 三页知识卡片演示。
- 工作流和资产追踪演示。
- 初始数据库迁移。
- 初始评测样例和测试报告。
- Architecture Decision Records：模型层、SQLite 作业、渲染器、持久卷和中期迁移策略。

## 11. 验收标准

- 在 Linux 服务器上执行 `docker compose up -d` 可以启动生产构建，重启容器后数据和资产仍然存在。
- 以 1 vCPU、1 GB RAM 环境进行基准测试，空闲内存目标不高于 250 MB，单页面高清合成峰值目标不高于 700 MB。
- 生产镜像中不存在 Chromium 可执行文件和 Playwright 浏览器缓存。
- 模型渠道默认并发为 `0`（不限制）；设置正整数后峰值调用数不得突破该渠道上限。
- 连续生成时通过容器内存、页面数和图片尺寸约束验证不会触发 OOM。
- Mock Provider 流程在 CI 中稳定通过。
- OpenAI 和 Grok 均能生成通过相同 Schema 校验的 Storyboard。
- 两家 Provider 的图片均能转存到 `/data/assets`，并返回统一 `Asset`。
- 中文字体在目标尺寸下正确渲染。
- 原生文字模式和确定性文字模式都能完成同一套三页样例，且默认配置确认为原生模式。
- 人为制造一个页面失败时，其余页面不需要重新生成。
- 日志中不出现 API Key、Cookie 或完整敏感请求头。

## 12. 退出条件

只有当 Provider、渲染、SQLite 作业、持久卷和服务器 Docker 部署五条技术链路都通过真实验证，且关键架构决策已记录后，才能进入阶段 1。
