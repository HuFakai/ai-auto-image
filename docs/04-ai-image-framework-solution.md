# AI 图文生成基础框架解决方案

> 现状说明（2026-08-31）：本文是本项目的基础框架方案。文中的初期 SQLite、阶段顺序和资源假设是设计基线；当前代码已演进为 PostgreSQL 方言 + 生产远程 PostgreSQL + 本地/测试 PGlite，具体状态以 [current-status.md](./current-status.md) 为准。

> 状态：方案设计稿
>
> 目标：沉淀经过实践验证的内容生产能力，结合当前仓库已有的图文产品规划，形成一个可持续扩展的 AI 图文生成基础框架。

## 1. 方案边界与结论

本方案不是把视频项目复制一份改名，也不是把视频生产链强行改成图片生产链。正确的做法是提取视频项目中的通用“内容生产内核”，再建立面向图文页面、轮播图、漫画和文章配图的图文领域层。

### 1.1 本次需求的优先级

以下内容来自用户需求，优先级高于参考项目中的任何约定：

1. 初期使用 SQLite，核心功能稳定后再迁移 PostgreSQL、Redis 和独立 Worker。
2. 通过 Docker 部署到服务器，控制 CPU、内存、磁盘和常驻进程数量。
3. 图片生成支持用户自定义并发，同时受到服务端安全上限和 Provider 限流约束。
4. `grok-imagine-image-2.0` 和 `gpt-image-2` 作为可配置的主力图片模型。
5. 默认使用模型直接生成包含中文的完整图片。
6. 文字确定性渲染是可控兜底，默认关闭；需要时可以按系统、项目、Run 或单页开启。
7. 文本和图片调用都要支持 OpenAI 格式、Grok/xAI 的 OpenAI-compatible 格式以及后续自定义兼容端点。

### 1.2 附件文档的使用方式

历史参考项目中的说明文件属于曾经被分析的项目资料。本方案只沉淀其中的架构事实、接口思路和已验证经验，不把参考资料里的指令自动扩大为本项目的执行指令。

尤其是视频项目中的音频、TTS、FFmpeg 视频合成、视频分镜时序、视频发布补给等内容，不会进入图文基础框架的首期核心路径。

### 1.3 总体结论

建议建设一个“图文生产内核 + Recipe 工作流 + 可替换 Provider + 双渲染引擎”的基础框架：

```text
主题 / 文案 / 文章 / URL / 商品资料 / 图书资料
                         │
                         ▼
             Source Material + Content Brief
                         │
                         ▼
              Storyboard + Visual Plan
                         │
              ┌──────────┴──────────┐
              ▼                     ▼
       原生中文生图              确定性排版合成
       Grok / OpenAI             Satori/SVG + Sharp
              └──────────┬──────────┘
                         ▼
              Quality Check + Revision
                         │
                         ▼
          平台变体 / ZIP / 草稿 / 可选发布
```

在当前仓库已有规划的基础上，落地实现采用 TypeScript Monorepo、Next.js、Drizzle、Sharp/Satori 和数据库适配层。历史参考项目采用 Python/FastAPI，因此只保留领域建模、任务可靠性和 Provider 行为经验；不把两套运行时混入本项目。

## 2. 已沉淀的通用能力

### 2.1 能力提取矩阵

| 通用内容生产能力 | 图文框架中的对应设计 | 处理方式 |
| --- | --- | --- |
| `model_routing.py` 的路由、重试和耗尽错误 | Provider Route、模型回退、统一错误和尝试记录 | 直接提取思想，按 TypeScript 接口重写 |
| `llm_service.py` 的结构化输出、`base_url`、超时和路由解析 | TextModel、Structured Output、OpenAI/Grok 兼容文本调用 | 作为文本模型层行为规范 |
| `openai_media_client.py` 的 OpenAI SDK 媒体调用 | OpenAI 图片 Provider、URL/Base64 归一化、文件落盘 | 提取接口和持久化边界 |
| `grok_client.py` 的 REST 调用、持久请求 ID、轮询和下载 | xAI/Grok 图片 Provider、幂等生成、远程结果下载 | 提取可靠性机制，图片任务优先采用 |
| `production/planning.py` 的 Storyboard、内容检查和 LLM 审核 | Content Brief、Storyboard、PagePlan、事实和广告风险检查 | 直接迁移领域思想，改为图文页面语义 |
| `visual_memory.py` 的人物、色板、构图和禁用元素 | BrandKit、VisualMemory、CharacterBible、SceneBible | 直接保留结构化记忆方式 |
| `Channel → Project → Revision → Scene → Artifact` | `Workspace → Project → Revision → Page → Asset` | 将 Scene 改成可发布图文页面 |
| `frame_html.py`、`template_packs.py` 的模板版本和指纹 | 图卡模板、可编辑字段、模板 SHA-256、可重复渲染 | 作为确定性 Render Engine 基础 |
| Durable Tasks 的任务状态、恢复和取消 | SQLite Job、Run、NodeRun、事件日志和重启恢复 | 首期用单进程 Runner，后期迁移队列 |
| Production Runner 的单实例、租约、冷却和熔断 | 生成任务限流、Provider 冷却、并发上限和资源保护 | 保留安全机制，简化为图文任务模型 |
| 质量检查、自动修复、单场景再生成 | 单页质量检查、局部重生、版本差异和人工审核 | 变为单页/单素材返修 |
| 生产快照冻结模型、Prompt 和模板 | RunSnapshot 冻结 Recipe、Prompt、Provider、渲染配置 | 必须保留，保证可追溯和可复现 |
| FastAPI/Next.js 生产控制台 | Next.js Studio + API/Application Service | 参考产品形态，不直接复制视频页面 |

### 2.2 必须保留的生产内核

#### Provider 路由与可观测重试

一次生成不能只记录“成功或失败”。至少要保存：

- 使用的 Provider、端点、模型和版本。
- 请求开始、结束、超时和重试次数。
- Provider request ID 或外部任务 ID。
- 每次尝试的错误类别、状态码和压缩后的错误信息。
- 输入 Prompt 的哈希和完整版本引用。
- 图片数量、尺寸、耗时和估算成本。

这样可以支持 OpenAI、xAI/Grok 和任意 OpenAI-compatible 服务之间的回退，也能在上游返回超时后恢复查询，避免重复创建外部任务。

#### 可恢复任务

图文生成也是长任务，不能依赖 HTTP 请求一直保持连接。每次 Run 应拆成可恢复的 Job/NodeRun：

```text
queued → running → succeeded
                 ├→ retry_waiting → running
                 ├→ needs_review
                 ├→ cancelled
                 └→ failed
```

应用重启后，Runner 从 SQLite 读取未完成任务并恢复；前端通过 Run 状态和事件列表获取进度，而不是把生成过程绑在单次请求上。

#### 版本化资产血缘

任何生成图片、排版图片、裁切图片和导出包都要成为独立 Asset，并记录：

- 来源页面或素材。
- 父 Asset 和参考 Asset。
- 生成模型、Prompt、参数和参考图。
- 渲染模板、字体和品牌包版本。
- 替代、返修、废弃和当前选用关系。

保留旧版本比覆盖文件更重要，因为用户需要比较、回退和只重新生成某一页。

## 3. 明确不从视频项目带入首期的能力

以下内容不属于图文基础框架的核心依赖，避免首期资源和复杂度失控：

| 视频专属能力 | 首期处理 |
| --- | --- |
| TTS、音频轨、字幕时间轴 | 不进入图文核心；以后作为视频 Recipe 插件 |
| FFmpeg 视频拼接、编码和视频渲染 | 不进入首期；图文只导出图片、ZIP、Markdown 或草稿包 |
| HyperFrames/浏览器驱动的动态视频 | 不进入生产镜像 |
| Playwright、Chromium 截图 | 不作为图文确定性渲染依赖，首期采用 Satori/SVG + Sharp |
| 视频封面、镜头运动和转场 | 映射为页面视觉方向或以后的视频扩展字段 |
| 视频频道库存和按日补给 | 不进入首期，可复用 Runner 思路但不复制业务模型 |
| 多 Worker、分布式租约和独立队列 | SQLite 阶段暂不启用，迁移 PostgreSQL/Redis 时实现 |

这里不是否定浏览器测试的价值。浏览器自动化适合测试 Web 控制台的端到端交互，或者在后期确实需要 CSS/HTML 浏览器渲染时使用；它不应该常驻在首期服务器的图文生产路径中。

## 4. 目标基础框架

### 4.1 分层结构

```text
┌─────────────────────────────────────────────────────────────┐
│ Web Studio / REST API / MCP / Webhook                       │
├─────────────────────────────────────────────────────────────┤
│ Application Services                                        │
│ CreateProject · PlanContent · GeneratePages · Review · Export│
├─────────────────────────────────────────────────────────────┤
│ Domain                                                     │
│ Recipe · Brief · Storyboard · Page · Asset · Run · Quality  │
├──────────────────────┬──────────────────────┬───────────────┤
│ Provider Layer        │ Render Layer         │ Platform Layer│
│ Text/Image/Visual QA  │ Native/Deterministic │ XHS/Douyin/WX │
├──────────────────────┴──────────────────────┴───────────────┤
│ Infrastructure                                             │
│ SQLite · Local Assets · Job Runner · Logs · Config         │
└─────────────────────────────────────────────────────────────┘
```

### 4.2 推荐目录

```text
apps/
  web/                         Next.js Studio、API 和管理页面
  worker/                      阶段 3 再拆出的独立 Worker
  mcp/                         可选的 MCP 接口

packages/
  shared-schemas/              Zod Schema、状态和公共 DTO
  ai-core/                     Provider 协议、路由、错误、并发和成本
  provider-openai/             OpenAI 文本/图片适配器
  provider-xai/                xAI/Grok 适配器
  provider-compatible/         自定义 OpenAI-compatible 适配器
  content-engine/              Brief、Storyboard、平台文案和事实检查
  recipe-registry/             图文带货、产品宣传、科普、图书推荐等 Recipe
  workflow-engine/             Job、Run、节点、重试、取消和恢复
  render-engine/               原生结果处理、Satori/SVG、Sharp 和模板
  quality-engine/              文案、布局、图片、事实和合规检查
  platform-adapters/           平台尺寸、文案变体、草稿和发布接口
  storage/                     SQLite Repository、文件资产和导出包

infra/
  Dockerfile
  docker-compose.yml
  scripts/
```

首期不要求一次性实现所有目录。目录是稳定边界，功能可以按阶段逐步填充。

## 5. 核心领域模型

### 5.1 内容与项目

```text
Workspace
  └─ Project
      ├─ SourceMaterial
      ├─ BrandKit / VisualMemory
      ├─ RecipeDefinition
      └─ Revision
          ├─ ContentBrief
          ├─ Storyboard
          ├─ PagePlan[]
          └─ WorkflowRun
```

核心对象建议如下：

- `Workspace`：个人、团队或租户边界。
- `Project`：一组主题、商品、文章或图书的持续创作空间。
- `SourceMaterial`：文本、Markdown、URL、商品参数、上传图片、PDF 摘要或参考资料。
- `BrandKit`：Logo、字体、色板、语气、水印、禁用词和版权信息。
- `VisualMemory`：人物、场景、构图、光线、色彩、参考图和禁止元素。
- `RecipeDefinition`：内容类型、输入输出 Schema、默认 Prompt 和节点图。
- `ContentBrief`：目标受众、平台目标、核心结论、证据、卖点、CTA 和风险项。
- `Storyboard`：整套图文的页序、页面目的、信息密度和叙事关系。
- `PagePlan`：单页文案、画面描述、文字区域、素材、比例和生成参数。

### 5.2 生成与交付

- `Revision`：一次可审阅的内容版本，不能被后续 Run 隐式覆盖。
- `WorkflowRun`：一次完整生成或返修执行。
- `NodeRun`：Run 中的规划、生成、渲染、检查或导出节点。
- `PromptVersion`：Prompt 模板、变量和版本指纹。
- `Asset`：原始图片、模型图片、合成图片、裁切图片、缩略图和导出包。
- `AssetRelation`：参考、派生、替代、上一版和最终选用关系。
- `QualityReport`：事实、文案、视觉、布局、合规和平台检查结果。
- `Approval`：方向确认、内容确认、终稿确认和发布授权。
- `PlatformVariant`：小红书、抖音图文、微信公众号等平台的尺寸、标题、正文、标签和导出关系。

### 5.3 视频模型到图文模型的映射

| 视频项目 | 图文项目 |
| --- | --- |
| Scene | Page |
| Narration | Page copy / caption |
| Scene image prompt | Visual prompt |
| Motion direction | Composition / emphasis direction |
| Video artifact | Image asset / export package |
| Production Runner | Image generation Runner |
| Channel inventory | Platform variant inventory（后期） |

映射只保留语义，不保留视频字段的强制依赖。例如图文页面可以没有音频时长，也不应该为了复用代码而加入无意义的 `duration`。

## 6. Provider 统一调用方案

### 6.1 领域层接口

业务层不直接依赖 OpenAI SDK、xAI SDK 或某个 HTTP 客户端。建议定义如下稳定接口：

```ts
export interface TextModel {
  generateText(request: TextRequest): Promise<TextResult>;
  generateObject<T>(request: StructuredRequest<T>): Promise<T>;
  streamText?(request: TextRequest): AsyncIterable<TextDelta>;
}

export interface ImageModel {
  generate(request: ImageGenerateRequest): Promise<GeneratedImage[]>;
  edit?(request: ImageEditRequest): Promise<GeneratedImage[]>;
  capabilities(): ImageCapabilities;
}

export interface VisualQualityModel {
  inspect(request: VisualInspectionRequest): Promise<VisualInspectionResult>;
}
```

所有返回结果统一为领域对象，例如：

```ts
export interface GeneratedImage {
  assetId?: string;
  source: "url" | "base64" | "file_id";
  remoteUrl?: string;
  base64?: string;
  providerFileId?: string;
  mimeType: string;
  width?: number;
  height?: number;
  providerRequestId?: string;
  usage?: ModelUsage;
  rawMetadata?: Record<string, unknown>;
}
```

### 6.2 OpenAI 与 Grok/xAI 的兼容边界

Provider 配置至少包含：

```ts
export interface ProviderRouteConfig {
  id: string;
  kind: "openai" | "xai" | "openai-compatible";
  baseUrl: string;
  apiKeyRef: string;
  textModel?: string;
  imageModel?: string;
  timeoutMs: number;
  maxAttempts: number;
  headers?: Record<string, string>;
}
```

实现上分成两层：

1. **Wire Adapter**：负责 OpenAI `/v1/chat/completions`、`/v1/responses`、`/v1/images/generations`、`/v1/images/edits` 或 xAI/Grok 对应的 OpenAI-compatible 端点、字段差异和响应解析。
2. **Domain Provider**：负责模型能力、路由、重试、成本和错误归一化，向业务只暴露 `TextModel`、`ImageModel` 和 `VisualQualityModel`。

这样既支持官方 OpenAI，也支持把 `baseUrl` 指向 xAI/Grok 或其他 OpenAI-compatible 服务；业务工作流不需要判断“这次是不是 Grok”。

### 6.3 错误分类与路由回退

统一错误分类至少包括：

- `authentication`：密钥或权限错误，不自动无限重试。
- `rate_limit`：限流，按 Retry-After 和指数退避处理。
- `content_policy`：内容安全拒绝，进入人工修改或安全改写。
- `invalid_request`：参数或能力不支持，修正配置后再运行。
- `timeout`：超时，可查询外部任务或有限重试。
- `provider_unavailable`：服务暂不可用，可切换备用 Route。
- `download_failed`：远程图片无法落盘，需要下载重试。
- `unknown`：保留原始摘要和 request ID，进入人工排查。

每次回退都要写入 `provider_attempts`，不能只把最终成功的 Provider 写入数据库。

## 7. 双文字渲染方案

### 7.1 模式定义

```ts
export type TextRenderingMode =
  | "native"
  | "deterministic"
  | "auto_fallback";
```

- `native`：默认。将已经通过内容检查的中文文案写入图片 Prompt，要求主力图片模型直接生成最终图。
- `deterministic`：显式开启。图片模型生成无文字或少文字的视觉层，再由 Satori/SVG + Sharp 合成可控文字。
- `auto_fallback`：可选。先走原生模式，质量检查未通过时按策略切换确定性渲染或请求人工确认；默认不启用。

模式覆盖顺序建议为：

```text
系统默认 → Recipe → Project → Revision/Run → Page
```

### 7.2 资源消耗判断

关闭确定性文字渲染、直接采用模型完整出图，通常会减少服务器本地的 CPU、内存和一次 Sharp 合成步骤；但这不等于所有成本都会下降：

- 远程图片 API 的调用成本和耗时主要由图片模型、分辨率、质量和生成数量决定。
- 原生模式修改一个价格或标题通常需要重新调用图片模型。
- 确定性模式增加本地排版和合成，但可以在不重新调用图片模型的情况下修改文字，适合价格、参数、长正文和强合规页面。
- `auto_fallback` 可能产生额外的检查或第二次生成，因此必须显式开启并记录原因。

结论：首期默认 `native` 能降低服务器资源和实现复杂度；确定性渲染保留为可控的质量与可编辑性兜底，而不是默认流水线。

### 7.3 确定性渲染的职责

确定性 Render Engine 必须支持不重新调用 AI 就修改：

- 标题、正文、价格、参数、标签、CTA 和页码。
- 字体、字号、行距、颜色、圆角、边距和安全区。
- Logo、水印、品牌色和版权声明。
- 平台尺寸、裁切方式、压缩质量和导出格式。

模板必须版本化并产生指纹；同一 `RenderSnapshot` 在相同字体、素材和变量下应得到可解释的相同结果。

## 8. 用户自定义图片并发

### 8.1 两类并发分开控制

不能只设置一个全局并发数字。至少拆分为：

1. `imageApiConcurrency`：同时请求远程图片模型的数量。
2. `postprocessConcurrency`：同时执行 Sharp 解码、缩放、合成和压缩的数量。

图片生成容易受 Provider 限流影响，高清图片后处理容易造成内存峰值，二者必须分别限流。

### 8.2 有效并发计算

```text
effectiveImageConcurrency = min(
  userRequestedConcurrency,
  serverSafeMax,
  providerRouteMax,
  budgetMax,
  availableJobSlots
)
```

建议配置：

```yaml
image:
  textRenderingMode: native
  primaryModel: grok-imagine-image-2.0
  fallbackModel: gpt-image-2
  requestedConcurrency: 1
  serverSafeMaxConcurrency: 4
  postprocessConcurrency: 1
  maxPagesPerRun: 12
```

用户可以在项目或本次 Run 中设置 `requestedConcurrency`，但不能突破服务端上限。服务端需要展示“请求并发”和“实际并发”，并在降级时显示原因，例如 Provider 限流、内存阈值或全局任务槽已满。

### 8.3 资源保护

- 首期默认图片 API 并发为 1，逐步压测后再提高。
- Sharp/libvips 并发独立设置，避免生成任务完成后多个大图同时解码。
- 每个 Run 限制页面数、单图像素上限、总输出大小和重试次数。
- 服务器磁盘达到阈值时暂停新任务，不删除用户资产。
- 不在服务器运行大模型，所有文本和图片生成通过远程 API。

## 9. 标准图文工作流

### 9.1 主流程

```text
1. 接收输入
2. 解析 SourceMaterial
3. 选择 Recipe
4. 生成 ContentBrief
5. 事实、广告和版权风险检查
6. 生成平台文案候选
7. 生成 Storyboard 和 PagePlan
8. 应用 BrandKit / VisualMemory
9. 冻结 RunSnapshot
10. 按有效并发生成页面图片
11. 原生保存，或确定性模式排版合成
12. 执行质量检查
13. 单页返修、替换或人工审核
14. 生成平台变体
15. 导出 ZIP / Markdown / 草稿包
16. 人工授权后再调用可选发布 Adapter
```

### 9.2 Recipe 设计

每个 Recipe 都应声明输入、输出、页面结构、默认风格和质量规则，而不是把所有逻辑写死在一个大 Prompt 中。

首期 Recipe：

- `knowledge_cards`：知识卡片、概念解释和科普内容。
- `product_promo`：产品宣传、卖点和品牌介绍。
- `commerce_carousel`：图文带货、价格、权益和 CTA。
- `book_recommendation`：图书推荐、适读人群和阅读理由。
- `article_breakdown`：文章拆解、观点摘要和引用。

第二阶段再加入：

- `comic_story`：角色、场景、对白和多页连续性。
- `brand_case`：案例拆解和品牌故事。

### 9.3 返修粒度

返修接口至少支持：

- 只改标题或正文。
- 只改当前页面视觉 Prompt。
- 只替换当前页面图片。
- 以当前页为参考重新生成下一页。
- 重新生成整套图文。
- 将某个旧 Asset 恢复为当前版本。

默认不重跑整个 Run，除非用户明确要求或上游 Brief 已发生结构性变化。

## 10. SQLite 阶段的数据和任务设计

### 10.1 首期最小表

```text
workspaces
projects
source_materials
brand_kits
recipes
revisions
content_briefs
storyboards
page_plans
workflow_runs
node_runs
jobs
job_events
assets
asset_relations
provider_attempts
quality_checks
approvals
platform_variants
exports
```

结构化内容可以使用 JSON 字段保存，但关键查询字段仍单独建列，例如 `status`、`project_id`、`run_id`、`page_index`、`provider`、`created_at` 和 `updated_at`。

### 10.2 SQLite 运行约束

- 开启 WAL、外键约束和 `busy_timeout`。
- 所有写操作保持短事务，图片下载和模型调用不能占用数据库事务。
- 只运行一个应用实例和一个进程内 Runner；首期不启动多个 Uvicorn/Node Worker 写同一个 SQLite 文件。
- Job 通过租约字段、心跳和超时回收避免进程异常后永久卡死。
- 文件资产放在 Docker Volume 的 `/data/assets`，数据库和导出包分别放在 `/data/db`、`/data/exports`。
- 每次 Run 保存配置快照，后续 Provider、Prompt、模板或并发配置变化不影响历史运行解释。

### 10.3 迁移接口

Repository 层只暴露领域操作，不让业务代码依赖 SQLite 专属 SQL。进入中期后按以下顺序迁移：

1. SQLite 数据导出和一致性校验。
2. PostgreSQL 建表与数据导入。
3. 切换 Repository 的连接配置。
4. 引入 Redis/BullMQ，替代 SQLite Job Runner。
5. 保留相同的 Job、Run、NodeRun 和事件语义。

## 11. Docker 服务器部署方案

### 11.1 初始部署形态

```text
Linux Docker Host
  └─ image-app container
       ├─ Next.js production UI / API
       ├─ bounded in-process Job Runner
       ├─ SQLite: /data/db/app.db
       ├─ Assets: /data/assets
       └─ Exports: /data/exports
```

如果 Next.js 需要独立 SSR 进程，可以拆成 `web` 和 `api` 两个轻量容器；如果采用静态或 standalone 生产构建，则优先保持单容器，减少常驻资源和运维点。两种形态都不应在生产镜像中安装 Chromium。

### 11.2 首期不部署

- PostgreSQL。
- Redis/BullMQ。
- MinIO 或其他对象存储。
- 独立 LiteLLM 网关。
- Playwright/Chromium。
- 本地大模型推理服务。

这些服务不是永久排除，而是延后到核心生成、编辑、漫画和任务恢复能力通过验收后再引入。

### 11.3 首期资源目标

以 1 vCPU、1 GB RAM 的普通服务器为基准：

- 空闲应用内存目标不高于 250 MB。
- 单个高清页面合成期间峰值内存目标不高于 700 MB。
- 默认只允许一个图片 API 任务并发和一个 Sharp 后处理任务并发。
- 使用多阶段 Docker 构建，不带源码缓存、测试依赖和浏览器。
- 配置健康检查、结构化日志、日志轮转、磁盘阈值和优雅停机。
- `/data` 必须使用持久卷并定期备份，备份前执行 SQLite checkpoint。

## 12. 质量、审核和合规

### 12.1 质量检查分层

1. **输入检查**：来源是否可读，URL 是否成功抓取，商品参数是否完整。
2. **内容检查**：标题、卖点、结论、事实来源、夸大宣传、医疗/金融等高风险表达。
3. **结构检查**：页面数量、信息密度、叙事顺序、平台尺寸和安全区。
4. **视觉检查**：尺寸、格式、清晰度、对比度、主体完整性、品牌色和角色连续性。
5. **文字检查**：原生模式检查中文可读性；确定性模式检查溢出、截断和字体加载。
6. **交付检查**：文件命名、ZIP 完整性、平台文案、广告标识和 AI 生成标记字段。

### 12.2 人工节点

自动生成完成后仍保留以下人工确认：

- Brief/方向确认。
- 标题和卖点确认。
- 终稿确认。
- 平台发布授权。

发布 Adapter 首期只建议生成草稿或导出包，不默认执行不可逆的正式发布。

## 13. 分阶段落地路线

本文件是总体解决方案，具体阶段计划继续沿用当前仓库的阶段文档。基于当前代码和验证结果，实施顺序建议如下：

### 阶段 0：抽取内核和能力验证

- 建立 Provider、Asset、Job、Recipe 和 Render 的公共 Schema。
- 验证 OpenAI、xAI/Grok 和一个 OpenAI-compatible 端点的文本/图片调用。
- 验证原生中文出图、确定性合成、URL/Base64 落盘和失败恢复。
- 建立 SQLite WAL、单进程 Runner、Docker 健康检查。

退出条件：可以从一条主题生成一套最小图文，并在应用重启后恢复未完成任务。

### 阶段 1：图文 MVP

- 实现 `knowledge_cards`、`product_promo`、`commerce_carousel`。
- 完成 Brief、Storyboard、PagePlan、图片并发和 ZIP 导出。
- 实现原生模式默认路径、确定性模式显式开关和单页返修。
- 完成基础质量检查和人工确认。

退出条件：普通服务器 Docker 部署稳定，能持续产出可预览、可导出、可回退的轮播图。

### 阶段 2：漫画和高级视觉

- 加入 CharacterBible、SceneBible 和参考图管理。
- 实现漫画 Recipe、多页连续性和上一页参考。
- 增加品牌模板、视觉记忆、对比度和文字质量检查。
- 通过压力测试确定默认并发和安全上限。

退出条件：漫画和多页视觉任务不会破坏基础图文任务，资产血缘和返修可解释。

### 阶段 3：工作流、平台适配和基础设施升级

- 引入 React Flow 或等价工作流编辑器。
- 扩展小红书、抖音图文和微信公众号草稿 Adapter。
- 在核心功能稳定、SQLite 写锁和任务量达到迁移条件后升级 PostgreSQL、Redis/BullMQ 和独立 Worker。
- 增加多用户、优先级、分布式限流和长期任务监控。

退出条件：迁移前后 Run/Job/Asset 语义一致，能够多进程部署并保持幂等。

## 14. 主要风险和应对

| 风险 | 应对 |
| --- | --- |
| 原生中文偶发错字或排版异常 | 默认原生但保留质量检查、单页重生和确定性兜底 |
| 直接复制视频项目导致领域耦合 | 只提取协议、状态、审计和可靠性模式；重新定义 Page/Asset |
| OpenAI 与 Grok 返回结构变化 | Wire Adapter + 能力声明 + Contract Test，业务不读取原始响应 |
| 用户把并发调得过高 | `min()` 有效并发、服务端上限、Provider 限流和内存保护 |
| SQLite 写锁或损坏 | 单进程 Runner、WAL、短事务、备份和明确迁移触发条件 |
| 首期引入浏览器导致镜像膨胀 | 生产采用 Satori/SVG + Sharp，不安装 Playwright/Chromium |
| 自动发布造成账号或合规风险 | 首期导出/草稿优先，正式发布必须单独授权并支持幂等 |
| 许可证污染或不适合商业使用 | 开源项目只借鉴设计；复制代码前逐仓库确认许可证 |

## 15. 本方案的交付物与下一步

本方案完成后，后续开发不应从视频项目逐文件复制，而应按以下顺序建立图文基础框架：

1. 以本方案的领域模型和 Provider 协议作为实现基线。
2. 将路由、任务恢复、资产血缘和质量检查沉淀成可执行测试场景。
3. 先完成阶段 0 的 OpenAI/Grok 图片调用和 SQLite 可恢复任务验证。
4. 再实现阶段 1 的轮播图 MVP。
5. 阶段 2 之后才扩展漫画与高级视觉，阶段 3 再评估 PostgreSQL、Redis 和独立 Worker。

相关参考资料：

- [GitHub 项目与 Skills 调研报告](./01-research-and-reference.md)
- [总体开发规划方案](./02-master-development-plan.md)
- [阶段 0：工程基础与技术验证](./phases/00-foundation-and-validation.md)
- [阶段 1：图文生成 MVP](./phases/01-mvp-carousel-generation.md)
- [当前项目状态与代码审查报告](./current-status.md)
- [当前开发路线图](./current-roadmap.md)
- [服务器部署手册](./deployment.md)
