# GitHub 项目与 Skills 调研报告

> 文档定位：GitHub/Skills 调研与技术选型基线。项目当前实现和待办以 [当前状态](./current-status.md) 与 [当前路线图](./current-roadmap.md) 为准；本文件中的候选项目不代表已经集成。

> 调研日期：2026-08-28  
> 目标：寻找可作为产品参考、架构参考或局部代码基础的开源项目，并确定 OpenAI、Grok 兼容调用方案。

## 1. 调研结论

不建议直接选择某个开源项目整仓二开。现有项目通常只覆盖以下能力中的一部分：

- 文案或 URL 到轮播图。
- 模板化文字卡片。
- AI 漫画和角色连续性。
- 社交媒体发布与排期。
- 多模型兼容调用。

推荐采用全新的 TypeScript Monorepo，以明确的数据协议连接各模块，同时组合借鉴：

- `clawvisual` 的流水线、返修和质量检查设计。
- `RedInk` 的文本/图片 Provider 配置方式。
- `md2card`、`XHS-TextCard` 的自动分页与确定性图卡渲染。
- `comic-alpha`、`AIComicBuilder` 的角色、场景、分镜和连续性管理。
- `xiaohongshu-mcp`、`Postiz` 的发布适配器设计。
- Vercel AI SDK 或自建 Provider 层的 OpenAI、xAI 和 OpenAI-compatible 兼容能力。

## 2. 候选 GitHub 项目

### 2.1 主题或文案到成套图文

#### [HisMax/RedInk](https://github.com/HisMax/RedInk)

最接近本项目目标的现有产品之一，支持一句话生成小红书文案和成套图片。

可借鉴：

- 文案大纲、正文、图片提示词分阶段生成。
- 文本 Provider 与图片 Provider 分离配置。
- OpenAI-compatible 文本和图片接口。
- 历史生成记录与单图重试。
- 前后端分离的产品形态。

限制：

- 许可证为 CC BY-NC-SA，不能直接作为商业产品代码底座。
- 图片 Provider 兼容主要基于端点推断，需要更严格的能力声明和错误归一化。

结论：只参考架构和交互，不复制其非商业代码。

#### [clawvisual/clawvisual](https://github.com/clawvisual/clawvisual)

把文章或 URL 转换为社交媒体轮播图，并提供 MCP、OpenAPI、质量审查和返修能力。

可借鉴：

- `input processor → content planner → visual prompt planner → asset generator → optimizer` 的流水线。
- 快速模式与完整模式两种执行计划。
- 封面、文案、图片的质量循环。
- 作业状态、审计、局部返修和会话分享。
- MCP Skill 与 Web 产品共用业务服务。

限制：

- 项目较新，社区和生产验证时间有限。
- 当前模型、图像与业务模块仍存在实现耦合。

结论：最适合做阶段 1 的代码结构参考，但最终项目应保留自己的领域模型和 Provider 接口。

#### [r04943083/content-pilot](https://github.com/r04943083/content-pilot)

覆盖小红书、抖音、B站和微博的内容生成、卡片、排期和发布。

可借鉴：

- 平台提示词和平台连接器注册机制。
- 内容看板、日历和任务状态。
- AI 生成图片与 HTML/CSS 卡片渲染并存。
- 发布前验证、限流和人工审核。

限制：

- 社区规模较小。
- 浏览器自动化发布依赖页面结构，维护成本和账号风险较高。

结论：参考平台 Adapter 和安全控制，不直接采用其浏览器发布实现作为首版核心。

### 2.2 图卡排版与图片导出

#### [aipickgold/md2card](https://github.com/aipickgold/md2card)

Markdown 转小红书 3:4 图卡，支持自动分页、主题和 ZIP 导出。

重点参考：

- 内容密度驱动的自动分页。
- 主题与内容分离。
- 中文字体处理。
- Skill-first 的调用体验。

#### [geekfoxcharlie/XHS-TextCard](https://github.com/geekfoxcharlie/XHS-TextCard)

纯前端 Canvas 图卡工具，支持模板注册、参数调整和高清导出。

重点参考：

- 模板配置和模板渲染逻辑分离。
- 封面、正文、水印和签名能力。
- 本地预览与导出。

#### [joeseesun/qiaomu-info-card-designer](https://github.com/joeseesun/qiaomu-info-card-designer)

将文本或 URL 转换为杂志风格 HTML 信息卡并使用 Playwright 截图。

重点参考：

- 内容密度到布局策略的映射。
- 信息图是否有必要的判断标准。
- HTML/CSS、SVG、Mermaid 与截图组合。
- 对比度、字体和手机可读性质量门槛。

### 2.3 漫画、角色与连续性

#### [hetaoBackend/comic-alpha](https://github.com/hetaoBackend/comic-alpha)

支持故事到多页漫画、小红书发布文案、参考角色图和上一页连续性。

重点参考：

- JSON 分镜和页面草图先行。
- 角色参考图、页面草图、上一页分别承担身份、布局和连续性约束。
- 参考图数量预算和压缩。
- 画布方向、尺寸和亮度检查。
- 单页重绘和整套批量生成。

#### [LingyiChen-AI/AIComicBuilder](https://github.com/LingyiChen-AI/AIComicBuilder)

完整的 AI 漫剧制作系统，包含剧本、角色、场景、镜头和生成资产。

重点参考：

- 项目、分集、角色、服装、场景和镜头的数据模型。
- 角色四视图和参考图历史。
- 连续性检查、Prompt A/B 测试和素材血缘。
- Dify、Coze 和百炼工作流模板。
- 长内容导入、自动拆集与镜头拆分。

#### [Nutlope/make-comics](https://github.com/Nutlope/make-comics)

产品化程度较高的 AI 漫画应用，包含登录、数据库、对象存储、限流和 PDF。

限制：仓库没有明确开源许可证，不直接复用代码。

### 2.4 发布与排期

#### [xpzouying/xiaohongshu-mcp](https://github.com/xpzouying/xiaohongshu-mcp)

支持小红书扫码登录、图文发布、标签、可见性和定时发布。

适用方式：作为独立可选 Adapter 或 MCP 集成，不把登录 Cookie 和平台实现写入核心服务。

#### [gitroomhq/postiz-app](https://github.com/gitroomhq/postiz-app)

成熟的国际社交媒体排期和发布产品，支持 TikTok、Instagram、YouTube 等平台。

适用方式：通过 API、CLI 或独立服务集成。其 AGPL 许可证不适合直接嵌入闭源核心代码。

#### 微信公众号项目

- [zero-times/wechat-official-studio-mcp](https://github.com/zero-times/wechat-official-studio-mcp)：本地登录态、草稿创建和安全确认流程参考。
- [HsiangNianian/wechat-publisher-mcp](https://github.com/HsiangNianian/wechat-publisher-mcp)：固定出口、幂等草稿和双重确认参考。
- [qiangmzsx/wechat-mcp](https://github.com/qiangmzsx/wechat-mcp)：公众号文章和小绿书图片草稿参考。

公众号首版应只创建草稿，不自动正式发布。

### 2.5 多模型统一调用

#### [vercel/ai](https://github.com/vercel/ai)

提供 OpenAI、xAI、OpenAI-compatible 等 Provider，并统一文本生成、结构化输出、工具调用和图片生成接口。

适用方式：作为 TypeScript 模型层的底层 SDK，但业务层继续定义自己的模型接口，避免 SDK 类型扩散到领域代码。

#### [BerriAI/litellm](https://github.com/BerriAI/litellm)

提供 OpenAI 格式的多模型网关、成本、限流、负载均衡和日志。

适用方式：当项目进入团队、多租户或大量 Provider 阶段再引入；MVP 不需要部署独立 LiteLLM 网关。

## 3. Agent Skills 调研

### [langchain-ai/deepagents：social-media](https://skills.sh/langchain-ai/deepagents/social-media)

适合借鉴：

- 先研究、后写作。
- 文案和配图同时作为完成条件。
- 平台限制、Hook、CTA 和标签质量检查。

### [kostja94/marketing-skills：visual-content](https://skills.sh/kostja94/marketing-skills/visual-content)

适合借鉴品牌视觉、营销素材、转化目标和视觉 Brief 的组织方式。

### [eachlabs/skills：comic-panel-generation](https://skills.sh/eachlabs/skills/comic-panel-generation)

适合借鉴漫画格式、画面比例、角色连续性和 Prompt 字段。实际运行绑定 EachLabs 服务，不作为核心依赖。

### [yanhua1010/self-media-content-workflow](https://github.com/yanhua1010/self-media-content-workflow)

最适合作为中文自媒体总控 Skill 参考，包含：

- 内容 Brief、研究、平台改写、视觉、交付和复盘。
- 标题确认、终稿确认和发布授权等人工节点。
- 平台原生表达和质量门槛。
- 内容任务卡和内容注册表。

### [nicepkg/ai-workflow](https://github.com/nicepkg/ai-workflow)

适合参考内容研究、Brief、内容复用和工作流模块化，不直接使用其较泛化的 Prompt 作为生产模板。

## 4. OpenAI 与 Grok 调用结论

xAI 图片生成接口为 `/v1/images/generations`，图片编辑接口为 `/v1/images/edits`。xAI 官方示例支持使用 OpenAI SDK，并将 `base_url` 设置为 `https://api.x.ai/v1`。

参考：

- [xAI Images REST API](https://docs.x.ai/developers/rest-api-reference/inference/images)
- [xAI Image Generation Tool](https://docs.x.ai/developers/tools/image-generation)
- [xAI Imagine Overview](https://docs.x.ai/developers/model-capabilities/imagine)
- [Vercel AI Provider Architecture](https://github.com/vercel/ai/blob/main/content/docs/02-foundations/02-providers-and-models.mdx)

需要注意：

- OpenAI-compatible 不代表所有图片参数和返回值完全相同。
- 图片可能以 URL、Base64、文件 ID 或 Responses 输出项返回。
- xAI 默认图片 URL 可能是临时地址，必须立即转存自己的对象存储。
- `size`、`aspect_ratio`、`quality`、`resolution` 和多参考图能力需要由 Provider 能力表控制。
- Responses API 和 Images API 应视为两条不同调用通道。

## 5. 许可证与复用原则

| 类型 | 使用策略 |
|---|---|
| MIT / Apache-2.0 | 可以在保留许可证和版权声明的前提下复用或修改 |
| AGPL-3.0 | 优先通过独立服务/API 集成，避免与闭源核心形成许可证冲突 |
| CC BY-NC-SA | 商业产品只参考产品和架构思想，不复制代码和素材 |
| 无许可证 | 默认不复制、不修改、不分发代码，只学习公开设计思想 |

任何代码复用必须登记：来源仓库、文件、许可证、修改内容和保留声明。

## 6. 最终技术选择

1. 新建 TypeScript Monorepo，不整体 fork 某个项目。
2. 核心工作流采用结构化数据，默认让主力图片模型直接生成完整中文图片。
3. 确定性文字渲染保留为可控兜底，默认关闭；当中文、价格、参数或对白检查失败时可按页开启。
4. OpenAI、xAI 和 OpenAI-compatible 通过统一 Provider 接口接入。
5. 自动发布作为独立插件，并始终保留人工确认节点。
6. Dify、n8n 和 MCP 作为外围入口，不作为核心素材制作引擎。
