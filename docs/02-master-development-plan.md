# 总体开发规划方案

## 1. 产品愿景

建设一个面向内容创作者、运营团队和商家的 AI 图文生产平台。用户提供主题、文案、文章、URL、商品资料或图书信息后，系统能够生成一套风格统一、文字准确、可编辑、可追溯并适配多个自媒体平台的图文内容。

产品不是单次生图工具，而是由内容策划、视觉生产、质量审查、版本管理和发布交付组成的工作流系统。

## 2. 产品目标

### 2.1 支持的输入

- 主题或一句话需求。
- 已有文章或 Markdown。
- 网页 URL。
- 商品卖点、参数、价格和图片。
- 图书信息、摘录和推荐理由。
- 科普知识、论文或资料。
- 角色图、品牌素材和参考风格图。

### 2.2 支持的内容 Recipe

- 知识卡片。
- 文章拆解。
- 图书推荐。
- 产品宣传。
- 图文带货。
- 科普漫画。
- 品牌故事和案例拆解。
- 后续扩展短视频分镜和动态轮播。

### 2.3 支持的平台

- 小红书。
- 抖音图文。
- 微信公众号文章和图片消息。
- 后续扩展 TikTok、Instagram、微博、B站动态等。

## 3. 产品原则

1. **结构化先行**：所有内容先形成 Brief 和 Storyboard，再生成图片。
2. **双文字渲染模式**：默认由 `grok-imagine-image-2.0` 或 `gpt-image-2` 在图片中直接生成中文；确定性文字渲染作为可控兜底，默认关闭。
3. **模型可替换**：工作流不能依赖特定模型的请求或返回结构。
4. **局部可返修**：任何页面、素材、文案或布局都可以单独修改和重新生成。
5. **全过程可追溯**：保存输入、Prompt 版本、模型、费用、资产血缘和审核结果。
6. **人工确认发布**：生成完成不等于授权发布。
7. **商业合规**：保留事实来源、广告披露、版权和 AI 生成标记字段。

## 4. 系统总体架构

```text
Web / REST API / MCP / Webhook
              │
              ▼
       Application Service
              │
      ┌───────┴────────┐
      ▼                ▼
Workflow Engine     Project/Asset Service
      │                │
      ▼                ▼
Recipe & Skill      SQLite + Mounted Storage
Registry                │
      │                  │
      ├──────────┬───────┤
      ▼          ▼       ▼
AI Provider   Render   Platform Adapter
OpenAI/xAI    Engine   XHS/WeChat/Export
      │          │       │
      └──────────┴───────┘
                 │
                 ▼
        Quality & Audit Service
```

## 5. 技术架构

### 5.1 Monorepo

```text
apps/
  web/                    Web 产品与管理后台
  worker/                 阶段 3 启用的独立 Worker；初期任务在 app 进程内执行
  mcp/                    MCP Server

packages/
  ai-core/                统一模型协议、能力和错误
  provider-openai/        OpenAI 适配器
  provider-xai/           xAI/Grok 适配器
  provider-compatible/    自定义 OpenAI-compatible 适配器
  workflow-engine/        DAG、状态、重试、审批和取消
  recipe-registry/        内容 Recipe 与 Skill 注册
  render-engine/          React/SVG/Satori/Sharp
  quality-engine/         文案、事实、布局和视觉检查
  platform-adapters/      导出和发布适配器
  shared-schemas/         Zod Schema 与公共类型
  config/                 ESLint、TypeScript、测试配置
```

### 5.2 推荐技术

- 包管理与构建：pnpm + Turborepo。
- Web：Next.js、React、TypeScript、Tailwind CSS、shadcn/ui。
- 工作流画布：React Flow，在阶段 3 引入。
- 初期数据库：SQLite（WAL 模式）+ Drizzle ORM，数据库文件挂载到 Docker 持久卷。
- 初期任务调度：SQLite `jobs` 表 + 进程内 Job Runner，不依赖 Redis。
- 初期资产存储：服务器 Docker 持久卷中的本地文件目录，不部署 MinIO。
- 中期升级：核心生成、编辑和漫画功能稳定后迁移到 PostgreSQL，并引入 Redis + BullMQ 分离 Worker。
- 后期对象存储：需要横向扩容或 CDN 时再迁移到 S3/R2 等兼容存储。
- 模型 SDK：Vercel AI SDK作为底层，自建领域接口。
- Schema：Zod + JSON Schema。
- 图片：Sharp、Satori、SVG。
- 确定性文字渲染：需要兜底时使用 Satori/SVG + Sharp；首版生产环境不使用 Playwright。
- 测试：Vitest、API/渲染集成测试和基于图片差异的视觉快照；Playwright 仅可选用于 CI 中的 Web 端到端测试，不进入生产镜像。
- 初期监控：结构化 JSON 日志、健康检查和模型成本账本；OpenTelemetry 延后到平台化阶段。

### 5.3 部署与资源策略

初期部署目标是单台 Linux 服务器上的 Docker，而不是依赖开发者本地环境：

```text
Docker Host
  └─ app container
       ├─ Web/API
       ├─ bounded Job Runner（默认并发 1）
       ├─ SQLite /data/app.db
       └─ Assets /data/assets
```

- 使用 Next.js standalone 或等价的精简生产构建。
- 生产镜像使用多阶段构建，不包含源码缓存、测试工具、Chromium 和开发依赖。
- SQLite、资产、导出文件全部挂载到 `/data` 持久卷，并配置服务器定时备份。
- SQLite 开启 WAL、`busy_timeout` 和外键；写任务保持短事务。
- 图片生成并发允许用户按项目或本次 Run 自定义；实际并发取用户值、服务器上限和 Provider 限流上限中的最小值。
- 图片 API 调用并发和 Sharp 本地后处理并发分别控制，避免多个大图同时解码造成内存峰值。
- 不常驻运行浏览器、MinIO、Redis、PostgreSQL 等额外服务。
- 健康检查、日志轮转、磁盘空间阈值和优雅停机属于首期部署必备能力。
- 中期迁移后再拆分 `web`、`worker`、`postgres` 和 `redis` 容器。

初期资源目标以 1 vCPU、1 GB RAM 的普通服务器为基准：

- 空闲状态应用内存目标不高于 250 MB。
- 单个高清页面合成期间容器峰值内存目标不高于 700 MB。
- 默认只允许一个图片合成任务并行执行。
- 设置 Sharp/libvips 缓存和并发上限，任务完成后及时释放大 Buffer。
- 不在服务器本地运行大模型，文本和图片生成均通过远程 API。

### 5.4 数据库与队列升级时点

阶段 0–2 使用 SQLite。进入阶段 3 时统一迁移 PostgreSQL 和 Redis/BullMQ，避免在核心产品形态尚未稳定前承担额外运维成本。

以下任一情况提前出现时，可以提前启动迁移评估：

- 需要运行多个应用副本或多台服务器。
- SQLite 写锁等待影响正常使用。
- 同时运行的生成任务长期超过 2 个。
- 需要多个独立 Worker、任务优先级或分布式限流。
- 多租户、团队协作或平台发布任务进入生产使用。

迁移前通过 Repository 层、标准 SQL 和数据库无关的领域模型控制迁移成本，不在业务逻辑中依赖 SQLite 专属行为。

## 6. 核心领域模型

### 6.1 项目与品牌

- `Workspace`：租户或个人工作区。
- `Project`：一次内容创作项目。
- `BrandKit`：Logo、字体、色板、语气、水印、禁用词。
- `SourceMaterial`：输入文本、URL、商品资料、上传文件和参考图。

### 6.2 内容规划

- `ContentBrief`：目标受众、目标、核心判断、证据、CTA 和禁区。
- `RecipeDefinition`：内容类型、输入输出 Schema 和节点定义。
- `Storyboard`：整套图文结构。
- `SlidePlan`：单页目的、文案、视觉、布局和引用素材。
- `CharacterBible`、`SceneBible`：漫画人物和场景锚点。

### 6.3 生成与资产

- `WorkflowRun`：一次工作流执行。
- `NodeRun`：单个节点执行状态和输入输出。
- `PromptVersion`：Prompt 模板版本。
- `Asset`：原始、生成、合成和导出文件。
- `AssetRelation`：参考、派生、替代和版本关系。
- `RenderVersion`：页面可重复渲染版本。

### 6.4 审核与交付

- `QualityReport`：事实、文案、布局、视觉、合规检查。
- `Approval`：方向、标题、终稿和发布授权。
- `PlatformVariant`：某平台的标题、正文、标签、尺寸和图片。
- `PublishJob`：草稿或发布任务及幂等状态。

## 7. 标准生成工作流

1. 解析输入并识别内容 Recipe。
2. 生成或补全 Content Brief。
3. 提取事实、卖点、引用和风险项。
4. 生成平台文案候选和 Storyboard。
5. 确定 Brand Kit、视觉风格和页面模板。
6. 按用户并发设置生成带原生中文的最终图片，或在确定性模式下生成无文字视觉素材。
7. 原生模式直接保存模型图片；确定性模式使用 Render Engine 合成文字与素材。
8. 原生模式检查文字准确性，确定性模式检查文字溢出和布局；两种模式都执行事实、对比度和视觉一致性检查。
9. 自动修复可确定问题，标记需要人工处理的问题。
10. 生成不同平台变体。
11. 人工确认后导出 ZIP、写入草稿或发布。

## 8. AI Provider 设计

业务层统一接口：

```ts
interface TextModel {
  generateText(request: TextRequest): Promise<TextResult>;
  generateObject<T>(request: ObjectRequest<T>): Promise<T>;
  streamText(request: TextRequest): AsyncIterable<TextDelta>;
}

interface ImageModel {
  generate(request: ImageGenerateRequest): Promise<ImageAsset[]>;
  edit(request: ImageEditRequest): Promise<ImageAsset[]>;
  capabilities(): ImageCapabilities;
}
```

统一能力表至少包括：

- 文本输入、图片输入和结构化输出。
- 文生图、单图编辑和多图编辑。
- 支持的比例、尺寸、分辨率和质量。
- 单次最大图片数量。
- 是否返回 URL、Base64 或文件 ID。
- 是否支持 Seed、Mask、透明背景和持久文件。

所有 Provider 错误归一化为：认证、限流、内容安全、超时、能力不支持、输入错误、上游异常和未知错误。

## 9. Render Engine 设计

### 9.1 文字模式

```ts
type TextRenderingMode = "native" | "deterministic" | "auto_fallback";
```

- `native`：默认模式。把已确认文案写入图片 Prompt，由主力图片模型直接生成包含中文的最终图片。
- `deterministic`：显式开启后，图片模型生成无文字视觉层，Satori/SVG + Sharp 合成标题、正文、价格和 CTA。
- `auto_fallback`：可选模式。先尝试原生文字；质量检查失败后询问用户或按策略转入确定性渲染。此模式默认不开启，避免无意增加调用和本地处理。

开关层级包括系统默认、Recipe、项目、Run 和单页。更具体的设置覆盖上层设置，但系统管理员可以限制允许的模式。

原生模式流程更短、服务器 CPU/内存占用更低、文字和画面融合度更高；缺点是修改文字通常需要重新调用图片模型。确定性模式中文字可编辑，价格和参数绝对可控，但会增加一次本地排版与合成。

### 9.2 确定性渲染能力

确定性模式下，Render Engine 必须能够在不重新调用 AI 的情况下修改：

- 标题、正文、价格、标签和页码。
- 字体、字号、颜色、间距和圆角。
- Logo、水印和 CTA。
- 图片位置、裁剪和滤镜。
- 漫画气泡、旁白和拟声词。

输出流程：

```text
SlidePlan + Theme + Assets
          │
          ▼
    React/SVG Template
          │
          ▼
        Satori
          │
          ▼
         Sharp
          ▼
 PNG/JPEG/WebP/PDF/ZIP
```

原生模式不执行上述文字合成，只做流式下载、必要的尺寸/格式校验、元数据登记和可选轻量压缩。

### 9.3 图片并发

```ts
type GenerationConcurrency = {
  requested: number;
  serverMax: number;
  providerMax?: number;
  effective: number;
  postprocessMax: number;
};
```

- 用户可以在设置页和生成前配置图片并发。
- 默认值为 1，初期服务器上限建议为 4，可通过环境变量调整。
- 有效并发为 `min(requested, serverMax, providerMax)`。
- Provider 返回 429 时降低并发并指数退避，不把失败请求无限重排。
- 图片响应采用流式写盘，避免并发任务把完整大图同时保存在内存中。
- 本地后处理默认并发 1，即使图片 API 并发更高也分批进入 Sharp。

建议环境变量：

```text
IMAGE_GENERATION_CONCURRENCY_DEFAULT=1
IMAGE_GENERATION_CONCURRENCY_MAX=4
IMAGE_POSTPROCESS_CONCURRENCY_MAX=1
```

## 10. 工作流状态

```text
DRAFT
  → PLANNING
  → AWAITING_DIRECTION_APPROVAL
  → GENERATING
  → REVIEWING
  → AWAITING_FINAL_APPROVAL
  → READY_TO_EXPORT
  → DRAFT_CREATED / PUBLISHED
  → COMPLETED
```

异常状态：

- `PAUSED`：用户主动暂停。
- `CANCELLED`：用户取消。
- `FAILED_RETRYABLE`：可以重试。
- `FAILED_FINAL`：需要修改输入、配置或人工处理。

## 11. 阶段划分

| 阶段 | 目标 | 主要产物 |
|---|---|---|
| 阶段 0 | 工程基础与模型验证 | Monorepo、Schema、Provider Spike、渲染 Spike |
| 阶段 1 | 图文生成 MVP | 四种 Recipe、页面编辑、ZIP 导出、OpenAI/Grok |
| 阶段 2 | 漫画与高级视觉 | 角色/场景 Bible、分镜、参考图、局部返修 |
| 阶段 3 | 基础设施升级、工作流与发布 | SQLite→PostgreSQL、Redis/BullMQ、DAG 画布、审批、平台草稿适配 |
| 阶段 4 | 运营闭环与平台化 | 多账号、模板市场、数据复盘、API/MCP、成本治理 |

详细方案见 [阶段文档目录](./README.md)。

## 12. 非功能性要求

### 12.1 可靠性

- 每个节点可独立重试，不重复执行已成功节点。
- 外部写入必须使用幂等键。
- 图片临时 URL 必须立即转存。
- 应用重启后可以从 SQLite 作业记录恢复未完成任务；迁移后由独立 Worker 和队列接管。

### 12.2 性能

- 互不依赖的页面和素材并行生成。
- 预览图与高清导出分级处理。
- 参考图在上传前压缩并限制数量。
- 相同输入和 Prompt 版本允许缓存。
- 图片生成并发默认 1，允许用户自定义；服务器配置保留不可突破的安全上限。
- 本地图片后处理并发独立控制，默认 1。
- 生产镜像不包含 Chromium，避免浏览器常驻和大体积依赖。

### 12.3 安全

- API Key 加密存储，不写日志。
- 平台 Cookie 与模型上下文隔离。
- 发布连接器运行在独立权限边界。
- 上传文件检查类型、大小和恶意内容。

### 12.4 可观测性

- 记录节点耗时、Token、图片数、实际费用、重试和失败原因。
- 记录 Prompt、模型和代码版本。
- 能按项目、用户、Provider 和 Recipe 查询成本。

## 13. 质量指标

- 结构化输出解析成功率不低于 99%。
- 原生图片保存和确定性渲染任务成功率均不低于 99.5%。
- 原生文字模式保存预期文案和文字审查结果，允许用户一键切换为确定性模式返修。
- 页面文字溢出自动检出率达到 100%。
- 单页重试不触发整套内容重新生成。
- 同一 Brand Kit 的字体、主色和 Logo 使用一致率达到 100%。
- 所有发布动作均具有可审计的用户授权记录。

## 14. 主要风险与对策

| 风险 | 对策 |
|---|---|
| 原生图片中的中文错字 | 文字准确性审查、单页重试，并允许切换到确定性文字渲染兜底 |
| 人物和商品漂移 | Character/Scene Bible、参考图、连续性检查 |
| Provider 参数差异 | 统一能力表和 Provider-specific options |
| 成本失控 | 预算、并发限制、预览模式、模型降级和成本账本 |
| 平台风控 | 首版导出/草稿优先，发布插件隔离，人工确认 |
| 页面结构变化 | Adapter 版本化、健康检查和快速停用开关 |
| 开源许可证冲突 | 建立第三方代码登记和许可证审查 |
| Prompt 更新导致回归 | 固定评测集、版本化和回归测试 |

## 15. 总体验收条件

最终产品应能够完成以下端到端场景：

1. 输入主题或文章。
2. 选择 Recipe、平台和 Brand Kit。
3. 自动生成结构化文案与 6–10 页 Storyboard。
4. 使用 OpenAI 或 Grok 生成视觉素材。
5. 程序合成准确的中文文字和图片。
6. 用户只修改其中一页并重新导出。
7. 通过质量审查后生成小红书、抖音和公众号发布包。
8. 用户明确授权后写入平台草稿。
9. 全过程可以查询成本、模型、Prompt 和资产来源。
