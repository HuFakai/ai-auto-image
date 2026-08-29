# 图片 + HTML / HyperFrames 双引擎视频开发方案

## 1. 目标与结论

目标是在不依赖视频生成模型的情况下，用“脚本 → 配音 → 图片 → HTML → 视频”持续生产竖屏短视频，覆盖火柴人心理学、每日早安、知识卡片、古诗词、轻科普和数据解说等栏目。

系统不把两种实现强行合并成一个复杂渲染器，而是提供两个可按频道选择的渲染引擎：

- **原生图片 + HTML 引擎**：沿用 Pixelle 已有的 Playwright 单帧合成和 FFmpeg 编码能力，强调吞吐量、低资源占用和故障面小。
- **HyperFrames 引擎**：采用 [heygen-com/hyperframes](https://github.com/heygen-com/hyperframes) 的确定性 HTML 时间轴、浏览器逐帧捕获和 FFmpeg 编码能力，强调动态排版、字幕、图表、动画和可视化预览。

推荐默认使用原生引擎。只有栏目需要动态文字、复杂转场、数据图表、音频响应或丰富动效时才选择 HyperFrames。两条路径共用选题、分镜、TTS、图片、Revision、质量检查和生产队列，不复制上游业务流程。

### 2026-08-19 首轮开发状态

| 阶段 | 当前状态 | 已落地 | 下一门槛 |
|---|---|---|---|
| N0 | 完成 | 频道/API/Storyboard/Revision 冻结渲染参数与模板 SHA-256；HTML 被复制到任务目录成为不可变 Artifact，源模板修改后仍可恢复；默认图片模型建单时解析为具体渠道 | 已进入稳定维护 |
| N1 | V3 完成 | 八种图片运动、十一种场景切换及确定性分镜自动导演已接入；原生 FFmpeg 与 HyperFrames 共用逐镜决策；全画布模板将背景与透明 HTML 文字层分开编码；三镜最终时长误差不超过 100ms | 主体焦点与安全裁剪已完成 |
| F0 | 双平台门槛通过 | HyperFrames/Producer 已由 `0.8.3` 升级并固定到 `0.8.4`；中文 9:16 模板通过完整检查；macOS 与 Ubuntu/headless-shell 均完成 20/20 连续草稿渲染且无浏览器残留 | 后续升级继续执行同一门禁 |
| F1 | 完成并开放 | Node Renderer Service、Python Adapter、任务级 ProjectBuilder、严格检查、生产调度、取消传播、Artifact 登记、API/Studio 三模式选择和服务按需自动拉起已完成 | 已完成单频道 20 条真实端到端灰度 |
| F2 | 完成 | 火柴人心理学、每日早安、知识卡片三套 V1 模板包；原生/HyperFrames 共用变量；版本与指纹任务冻结；Studio 选择器；无模型草稿命令 | 已进入稳定维护 |
| F3 | 完成 | Studio 时间轴预览、关键帧编辑、检查报告、同素材双引擎 Revision 对比及素材指纹校验 | 已进入稳定维护 |
| F4 | 完成 | 渲染默认不限并发、可选显式上限；跨任务素材缓存、运行指标、断点灰度与失败重试已落地，并通过 Ubuntu 24.04 部署一致性门禁 | 按长期指标持续观察 |

HyperFrames 已完成 F1 生产开放，并定位为复杂动效的高级可选引擎。频道可以在原生视频、原生图片 + HTML、HyperFrames 三种方式间切换；后端会验证所选模型能力，避免图片模型误入视频链路或反向错配。持续生产默认开启 HyperFrames → 原生图片 + HTML 的同素材故障回退，防止外部检查器或本地浏览器故障阻断整条生产线。

macOS 连续基准使用系统 Chrome 的截图捕获路径：20/20 成功，全部为 1080×1920、30fps、H.264、8.000 秒；平均渲染 13.421 秒，P95 13.971 秒，进程树最高约 1,799.2 MB，测试前后浏览器进程均为 0。该结果达到本机 F0 稳定性门槛，但不能代替部署机 `chrome-headless-shell` 的最终吞吐量基准。

2026-08-20 的 GitHub Actions Ubuntu 24.04 最终门禁已通过：HyperFrames `0.8.4` 使用管理的 `chrome-headless-shell 152.0.7977.42` 连续渲染 20/20 成功；所有输出均为 H.264、1080×1920、30fps、8.000 秒且非空。平均渲染 17.984 秒，P95 18.198 秒，进程树峰值 1,516.6 MB，测试前后浏览器 worker 均为 0。Actions 运行与 7 天产物见 [run 32362924170](https://github.com/HuFakai/Pixelle-Video/actions/runs/32362924170)。

## 2. 已有基础与 HyperFrames 调研结论

Pixelle 当前已经具备原生方案的基础能力：`HTMLFrameGenerator` 可用 Playwright 将图片、标题、旁白和品牌参数渲染为单帧，`FrameProcessor` 可按 TTS 时长把合成帧转换成视频片段，`VideoService` 可拼接片段、旁白和 BGM。

截至 2026-08-19 调研的 HyperFrames `main`：

- 项目采用 Apache-2.0 许可证；CLI 与 `@hyperframes/producer` 当前固定版本为 `0.8.4`。
- 运行环境要求 Node.js 22+、Chrome/Chromium 和 FFmpeg。
- HTML 是视频源文件，通过 `data-start`、`data-duration`、`data-track-index` 和 `data-composition-id` 描述时间轴与轨道。
- 支持 GSAP、CSS、Lottie、Three.js、Anime.js、WAAPI 等可定位到任意时间点的动画。
- `hyperframes check/lint/inspect/preview/render` 覆盖校验、布局检查、预览与渲染。
- `@hyperframes/producer` 可嵌入 Node 服务，支持进度、取消、MP4/WebM/MOV/PNG 序列以及分块渲染；比 Python 为每个任务启动一次 CLI 更适合作为长期运行的生产适配层。
- 本地 CLI、Producer、HyperFrames Cloud、AWS Lambda 和 Google Cloud Run 是不同运行方式。本项目第一阶段只采用本地 Producer，避免提前引入云端依赖。

HyperFrames 仍处于快速迭代期。生产环境必须固定精确版本和锁文件，升级前跑视觉回归与性能基准，不能直接跟随 `latest`。

## 3. 产品配置与选择方式

频道设置页新增“视频渲染引擎”：

```yaml
video:
  render_engine: native_image_html # native_image_html | hyperframes
  media_workflow: api/default/image
  frame_template: 1080x1920/image_default.html
  video_fps: 30

  native:
    image_motion: ken_burns
    transition: crossfade
    transition_duration: 0.35

  hyperframes:
    template_id: stickman-psychology
    template_version: 1
    quality: standard
    strictness: strict
```

Studio 根据引擎切换配置表单，但始终保留图片模型、TTS、BGM、分辨率和质量检查等共用设置。任务创建时冻结引擎、模板版本、渲染参数和依赖版本，重试不得悄悄切换引擎。

### 选择矩阵

| 维度 | 原生图片 + HTML | HyperFrames |
|---|---|---|
| 最适合 | 早安电台、语录、火柴人、轻科普 | 动态科普、数据图表、品牌短片、动态字幕 |
| 画面能力 | 静态版式 + Ken Burns + 基础转场 | 多轨时间轴、动态文字、图表、复杂转场、透明叠层 |
| 单镜成本 | 低 | 中到高，需逐帧浏览器渲染 |
| 吞吐量 | 高 | 需按机器实测；默认不限并发，也可显式设置上限 |
| 模板门槛 | HTML/CSS | HTML/CSS + 确定性动画与时间轴规则 |
| 故障面 | Playwright 单帧、FFmpeg | Node、Chrome、FFmpeg、组合编译和逐帧捕获 |
| 预览和检查 | 需自行建设 | 已有 preview、lint、inspect、check |
| 推荐默认值 | 是 | 否，按栏目启用 |

自动推荐仅作为提示，不替用户切换：纯图片/卡片栏目推荐原生；包含动态图表、逐字字幕、三层以上动画或复杂场景转场时推荐 HyperFrames。

## 4. 统一目标架构

```text
选题/文稿
  → Storyboard（旁白、图片提示词、版式和动画意图）
  → TTS（获得每镜真实时长）
  → 图片频道（每镜图片，可缓存/复用）
  → RenderDispatcher
      ├─ NativeImageHtmlRenderer
      │    → HTML 单帧/透明叠层 → MotionComposer → FFmpeg
      └─ HyperFramesRenderer
           → ProjectBuilder → Producer Service → MP4
  → 统一质量检查 → 项目 Revision → 成片库
```

核心边界：

- `RenderDispatcher` 只根据任务冻结配置选择引擎，不包含具体渲染逻辑。
- 图片生成和 TTS 保持现有可恢复任务语义，两种引擎复用同一份素材。
- 两个渲染器输出统一的 `RenderResult`：文件路径、时长、尺寸、帧率、编码信息、渲染日志和 Artifact 清单。
- 每个中间产物登记到 `production_artifacts`，支持单镜重做、整片重渲染和版本回退。
- 最终默认输出 H.264、`yuv420p`、固定分辨率和帧率；透明叠层是内部 Artifact，不作为默认交付格式。
- HyperFrames 失败时默认启用同素材原生回退，并在任务结果记录实际引擎与失败原因；需要严格锁定 HyperFrames 输出的测试频道可以关闭回退。

## 5. 原生图片 + HTML 引擎

### 模板契约

模板使用统一的 `window.PIXELLE_SCENE` 数据，业务代码不依赖模板内部 DOM：

```json
{
  "title": "为什么越拖延越焦虑",
  "narration": "拖延常常不是懒惰……",
  "image_url": "file:///.../scene-01.png",
  "scene_index": 1,
  "scene_count": 6,
  "duration": 7.4,
  "brand": {
    "primary_color": "#D7FF3F",
    "logo_url": ""
  },
  "params": {}
}
```

模板声明画布、安全区、图片裁剪、参数默认值、透明叠层能力和版本号。第一版只支持静态 HTML 合成帧，运动由 FFmpeg 的 `zoompan`、`crop`、`scale` 和 `xfade` 完成。

不再优先自研逐帧动态 HTML。若动态需求可由 HyperFrames 覆盖，则直接使用 HyperFrames；只有性能基准证明 HyperFrames 不适合而需求又确实存在时，才重新评估原生 `renderAt(timeMs)` 协议。

### 原生实施阶段

#### N0：正式化静态链路

- 增加 `render_engine=native_image_html` 配置和校验。
- Runner 冻结图片模型、模板版本和渲染参数。
- 为每镜保存原图、HTML 合成帧、音频和视频片段四类 Artifact。
- 增加模板、字体、图片比例、文字溢出和安全区检查。

验收：6 镜栏目能完整生成、重启恢复、单镜重做并输出可播放成片。

#### N1：轻运动与转场

- 新增 `MotionComposer`，提供 `none`、`ken_burns`、`slow_pan` 和 `push_in`。
- 根据图片比例选择安全裁剪锚点，HTML 文字层不跟随背景缩放。
- 转场时长计入时间轴，最终时长以旁白总时长为准。

验收：镜头时长误差不超过 100ms，无黑帧、拉伸和字幕抖动。

原生 V2 对声明 `data-pixelle-media-layer="full-canvas"` 的模板输出完整合成帧与透明 HTML 文字层两个 Artifact：FFmpeg 只移动原始背景，再把透明层固定叠加。未声明该契约的旧模板继续采用整帧运动，避免错误地把卡片内图片扩展为全屏。原生 V1 仍保留用于恢复历史任务，不会被升级为 V2 行为。

## 6. HyperFrames 引擎

### 集成形态

不把 HyperFrames 源码复制进 Pixelle，也不让 Python Runner 为每个任务执行 `npx`。在仓库增加独立 Node 渲染服务 `services/hyperframes-renderer`：

```text
Python API / Runner
  → HyperFramesRendererAdapter（HTTP）
  → 内部 Node Render Service
      → ProjectBuilder
      → hyperframes check / inspect 等价校验
      → @hyperframes/producer
      → Chrome 逐帧捕获 + FFmpeg
  → 输出 MP4、进度、日志和质量元数据
```

渲染服务只监听内网或本机地址，API Key 仍由 Pixelle 管理。服务接口最少包括：

- `POST /renders`：提交冻结后的项目清单，返回 `render_id`。
- `GET /renders/{id}`：返回阶段、进度、日志摘要和产物。
- `POST /renders/{id}/cancel`：触发 Producer 的 `AbortSignal`。
- `GET /ready`：检查 Node、Chrome、FFmpeg、字体、版本和临时目录。

任务目录由 Pixelle 生成，包含 `index.html`、`compositions/`、本地图片、音频、字体、`DESIGN.md` 和 `manifest.json`。每个任务使用独立目录与浏览器上下文，渲染完成后按保留策略清理。

### HyperFrames 模板契约

- 根元素必须有 `data-composition-id`、画布尺寸和确定性时长。
- 场景、媒体和字幕使用 `data-start`、`data-duration`、`data-track-index`。
- 动画必须可 seek；禁止 `Math.random()`、`Date.now()`、无限循环和依赖真实播放时钟。
- 视觉身份必须来自版本化 `DESIGN.md`，颜色、字体和运动规范随模板冻结。
- 多场景必须定义转场；文本布局必须通过检查，不能依赖人工观看才能发现溢出。
- 所有生产媒体下载到任务目录并写入内容哈希，HTML 运行时禁止访问外部网络。

### HyperFrames 实施阶段

#### F0：技术验证

- 固定 HyperFrames `0.8.4`，建立独立锁文件和最小 Docker/本地运行环境。
- 用同一份 6 镜心理学素材分别生成原生版和 HyperFrames 版。
- 测量实时倍率、峰值内存、Chrome 进程数、失败恢复和最终文件指标。
- 验证简体中文字体、9:16 安全区、长字幕、音画同步和 macOS/Linux 一致性。

通过门槛：连续渲染 20 条无资源泄漏；输出时长误差不超过 100ms；服务重启后任务状态可恢复或可安全重试。

#### F1：Renderer Service 与生产队列接入

- 实现 Node Render Service 和 Python `HyperFramesRendererAdapter`。
- 将提交、轮询、取消、超时、重试和 Artifact 登记接入现有生产任务状态机。
- 结构化映射 Producer 进度和错误阶段，保留最后检查报告和关键帧。
- readiness、备份和通知增加 HyperFrames 服务维度。

截至 2026-08-20，F1 已完成并开放：ProjectBuilder 会将每个分镜的本地图片、旁白、可选 BGM 与固定 GSAP runtime 复制到任务目录并记录 SHA-256，生成无外部网络依赖的确定性时间轴；Renderer Service 在 Producer 前强制运行结构化 `check`，Pipeline 会映射检查/捕获/编码进度、传播取消并登记 `hyperframes_project`、`check_report` 与最终成片。Studio 已开放三种制作方式，首次 HyperFrames 任务会自动拉起本地服务，实测 readiness 的 Node、FFmpeg、浏览器、runtime 和 Producer 全部通过。

验收：Studio 中选择 HyperFrames 后可排队、取消、重试、删除和查看成片，不需要另开终端手工执行命令。

#### F2：模板与变量系统

- 先提供火柴人心理学、每日早安、知识卡片三个模板。
- `ProjectBuilder` 将 Storyboard 转换为模板变量、轨道、图片、旁白、BGM 和字幕。
- 模板发布为不可变版本；频道绑定明确版本，版本升级走灰度。
- 加入低清草稿渲染，模板调试不调用模型。

截至 2026-08-20，F2 已完成。模板包位于 `templates/hyperframes/<template-id>/v<version>/`，每个不可变版本包含 `manifest.json`、`scene.css` 和 `DESIGN.md`，同时指向对应的原生 HTML。manifest 只开放声明过的颜色、文字与透明度变量；类型、范围和未知键在保存频道及构建任务时校验。ProjectBuilder 会把解析后的变量、模板版本、内容指纹、样式和设计规范冻结到任务目录，历史任务不读取升级后的源模板。

Studio 的频道编辑器可选择三套模板版本并编辑声明变量。模板选择会同步绑定原生 HTML 和 HyperFrames 模板，使后续同素材双引擎 Revision 使用一致的视觉身份。以下命令只生成本地占位图片与静音音频，可构建或渲染 6 秒草稿，不调用文本、图片、视频或 TTS 模型：

```bash
uv run python scripts/render_template_draft.py --template stickman-psychology --build-only
uv run python scripts/render_template_draft.py --template morning-radio --build-only
uv run python scripts/render_template_draft.py --template knowledge-card --fps 24
```

三套最终项目均通过 HyperFrames `0.8.4` 严格检查，lint、runtime、layout 和 contrast 为 0 finding；知识卡片真实草稿输出为 H.264、1080×1920、24fps、6.000 秒。原生三套模板也通过 Playwright 实际截图和 7.5%/80% 文字安全区检查。

#### F3：Studio 预览与质检

- 在 Pixelle Studio 内嵌受控预览，不直接暴露渲染服务文件系统。
- 展示场景时间轴、变量、模板版本、检查结果和 0%/50%/100% 关键帧。
- 保存 `check/lint/inspect` 的结构化报告，严格模式下阻断最终渲染。
- 支持“同素材切换引擎并复制为新 Revision”用于 A/B 对比。

截至 2026-08-20，F3 已完成。Studio 可按真实音频时长展示逐镜时间轴、拖动预览头、查看并编辑镜头运镜/转场关键参数，并展示 HyperFrames 的 lint、runtime、layout、motion 与 contrast 结构化检查结果。同一 Revision 可只重做合成，生成原生或 HyperFrames 对照版本；图片与音频 SHA-256 指纹不一致时会明确警告，避免把素材变化误判为引擎差异。

#### F4：批量优化

- 渲染默认不限并发；保留正整数显式上限作为部署时的可选保护开关。
- 按模板、素材内容哈希缓存已编译项目和静态资源。
- 先使用单机 Producer；只有单机队列成为瓶颈后再评估其分块渲染、Lambda 或 Cloud Run 适配器。
- 记录实时倍率、排队时长、每帧耗时、缓存命中率、失败阶段和进程内存。

截至 2026-08-20，本地 F4 已完成。API 任务管理器与 HyperFrames Renderer 在配置为 `0` 或留空时均不创建全局信号量，运行指标会返回 `concurrency_limit: null` 和 `unlimited_concurrency: true`；仍可通过正整数环境变量恢复显式上限。素材按内容哈希跨任务复用并提供命中率、条目数、占用空间与清理指标。火柴人心理学频道真实灰度 20/20 完成，5 个任务沿用原任务 ID 断点重试，共 11 次重试，0 次原生回退、0 次引擎不一致；120 个镜头均使用冻结的本地主体焦点。

## 7. 数据与接口改动

- `ChannelConfig.video` 增加 `render_engine` 和两个引擎各自的命名空间配置。
- Production Job 冻结 `render_engine`、`renderer_version`、`template_version_id` 和渲染参数快照。
- Storyboard Scene 增加通用 `visual_intent`，原生映射为运动预设，HyperFrames 映射为轨道和动画变量。
- Artifact 增加 `source_image`、`composed_frame`、`hyperframes_project`、`check_report`、`segment` 和 `final_video` 类型。
- 新增模板元数据、模板版本和渲染执行记录；模板文件保存在受控目录。
- 统一预览接口根据引擎分发，不使用生产 API Key，也不触发图片或文本模型。
- 质量报告统一记录文字溢出、缺失字体、帧尺寸、音画时长差、编码和关键帧；HyperFrames 额外附带检查报告。

## 8. 安全与长期运行约束

- HyperFrames 包固定精确版本并提交 lockfile；依赖升级不得自动执行。
- HTML、模板和媒体均视为不可信输入：限定任务根目录、拒绝路径穿越、禁用外部网络、限制文件体积和总时长。
- Render Service 使用非特权用户、独立临时目录、CPU/内存/超时限制，不对公网暴露 Producer 原始接口。
- 模板只允许审核后的本地脚本和依赖，不允许运行时 CDN，例如 GSAP 必须打包到本地。
- 删除任务时永久清理完整 output 任务目录、HyperFrames 项目和所有中间产物。
- 生产 readiness 必须同时检查 Python API、Runner、Node Renderer、Chrome、FFmpeg 和剩余磁盘。

## 9. 测试与上线策略

- 单元测试：配置路由、模板变量映射、时间轴、路径安全、错误分类和状态转换。
- 契约测试：同一 `RenderRequest` 对两个引擎都产生合法 `RenderResult`。
- 集成测试：固定图片和合成音频生成 3 镜视频，用 ffprobe 验证尺寸、时长、帧率和编码。
- 视觉回归：每个模板和引擎保存 0%、50%、100% 三张基准帧。
- 恢复测试：在素材准备、项目构建、浏览器捕获和 FFmpeg 编码阶段分别中断并重启。
- 性能基准：分别记录原生静态、原生轻运动和 HyperFrames 的实时倍率、内存和并发上限。
- 灰度上线：每日早安先启用原生 N0/N1；HyperFrames F0 通过后仅给一个心理学测试频道启用，连续产出 20 条后再开放其他频道。

## 10. 建议排期与执行顺序

1. N0：2–3 个开发日，形成原生稳定链路。
2. N1：2–3 个开发日，加入轻运动与转场。
3. F0：2 个开发日，完成 HyperFrames 基准与中文模板验证。
4. F1：3–5 个开发日，接入 Node Renderer Service 和生产队列。
5. F2：3–5 个开发日，交付三套模板及版本化变量系统。
6. F3：3–5 个开发日，完成 Studio 预览、检查报告和 Revision 对比。
7. F4：2–3 个开发日，结合真实批量数据调优；分布式渲染暂不排期。

N0–N1 与 F0–F4 已全部完成并通过本地、真实生产灰度和 Ubuntu 24.04 三层验收。后续常规功能迭代使用全量单元测试、Studio 构建、浏览器验收与必要的单次本地渲染；Ubuntu 24.04 连续渲染 20 次仅在 HyperFrames/浏览器运行时升级或明确要求时执行，不再作为日常代码验证步骤。
