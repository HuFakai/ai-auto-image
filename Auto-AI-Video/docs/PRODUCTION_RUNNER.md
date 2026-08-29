# 持续视频生产 Runner

Production Runner 将 Pixelle-Video 的持久化异步任务组合成可以长期运行的生产队列。它不会无边界地填满磁盘，而是按每个频道的“每日目标 + 待发布库存水位”持续补产。

## 内置频道

频道配置位于 `production/channels/`：

| 频道 | 默认每日目标 | 待发布库存 | 最大并行 |
|---|---:|---:|---:|
| 火柴人心理学 | 3 | 4 | 2 |
| 一分钟科普 | 2 | 3 | 2 |
| 每日早安电台 | 1 | 2 | 1 |
| 中国古诗词 | 2 | 3 | 1 |
| 少儿寓言故事（默认停用） | 3 | 3 | 2 |

五个频道共享以下生产基础能力；频道可选择固定媒体工作流，也可跟随设置页默认图片或视频路由：

- 文案模型：`config.yaml` 中的 `grok-4.5`；
- 媒体工作流：图片栏目使用 `api/default/image`，生成式视频栏目使用 `api/default/video` 或固定模型；
- 竖屏 HTML 模板：图片与视频模板均由单帧合成层统一叠加标题、旁白和品牌参数；
- 本地 Edge TTS 中文声音；
- Grok 视频 request_id、Pixelle API task_id 和 Runner 生产记录三级持久化。

可在 Production Desk 中结构化调整产量、并发、分镜数量、声音、视觉风格或启停频道。配置会原子写入相应 YAML，Runner 每轮自动热加载，无需重启。

### HyperFrames 图片生产与原生回退

图片栏目默认由 HyperFrames 生成确定性时间轴；频道可配置轻运动和转场，并绑定版本化模板包：

```yaml
video:
  production_mode: hyperframes
  render_engine: hyperframes
  media_workflow: api/default/image
  frame_template: 1080x1920/f2_knowledge_card_v1.html
  video_fps: 30
  hyperframes:
    template_id: knowledge-card
    template_version: 1
    fallback_to_native: true
  native:
    scene_direction: auto   # auto 按分镜语义选择；fixed 使用下方固定值
    image_motion: ken_burns # 固定模式或自动模式后备值
    transition: crossfade
    transition_duration: 0.6
    motion_pool: [ken_burns, push_in, pull_out, pan_left, pan_right, pan_up]
    transition_pool: [crossfade, dissolve, slide_left, circle_open, zoom_in, blur]
```

自动导演会结合每镜旁白、视觉提示词和镜头位置，确定性地选择图片运镜与进入转场。当前运镜包括静态、Ken Burns、推进、拉远和四向平移；转场包括直切、交叉淡化、溶解、左右推屏、上下擦除、圆形揭示、快速穿越、黑场与焦点模糊。相同输入和候选池始终得到相同结果，不依赖随机数。

Runner 建单时会把设置页的默认图片模型解析成具体 `api/<channel>/<model>`，并把渲染器版本、候选池和逐镜导演决策写入任务快照，后续切换默认模型或修改配方不会改变旧任务。人工确认分镜时可逐镜覆盖参数，也可在修改文案后点击“重新智能导演”。频道编辑器可选择“原生视频生成”“HyperFrames”或“手绘白板动画”；系统会联动正确的媒体模型能力、模板与渲染器版本。HyperFrames 把导演决策映射为重叠轨道和 GSAP 时间轴，首次接到任务时会自动拉起仓库内的 Node Renderer，无需另开终端。

手绘白板动画是独立的 `whiteboard_animation / whiteboard_cv / whiteboard-cv-v1` 制作链，不读取 `frame_template`，也不进入原生 HTML 或 HyperFrames 模板。Studio 提供从 cs-board 保留并版本化的 12 套视觉预设；选中的提示词配方、描绘参数、手势开关、后备策略和 SHA-256 指纹会冻结到任务。图片模型生成无文字源画面后，本地 OpenCV 提取并排序笔迹路径，按“线稿揭示 → 颜色填充 → 成图停留”编码静音段，再以独立透明字幕层和旁白完成 FFmpeg 合成。第三方许可证与素材声明位于 `assets/whiteboard/`。

所有新成片在最终收尾阶段都会从首个有效本地画面生成任务专属 `cover.png`，以标题卡形式写入视频开头 1.2 秒。封面段使用静音音轨，后续旁白与分镜的相对时间保持不变；`cover.json` 与 MP4 内的任务指纹用于断点重试复用，标题或源素材变化时才重新生成。封面、清单与最终视频均位于同一任务目录，永久删除任务时会一并清理。

内部原生 V2 渲染器仍服务于原生视频字幕/品牌叠加、旧任务恢复和 HyperFrames 失败回退。它会冻结模板 SHA-256，并把当时的 HTML 复制到任务目录登记为 `template_snapshot` Artifact。任务恢复和单镜重做优先使用这份不可变副本，因此后来修改源模板不会改变旧任务。需要“背景运动、文字固定”的全画布模板应在媒体节点声明：

```html
<body data-pixelle-media-layer="full-canvas">
```

渲染器会输出完整合成帧和透明 `text_overlay`，只对原图执行运动后再叠加文字。未声明的旧卡片模板维持整帧运动；历史 `native-image-html-v1` 任务也保持旧行为，新任务使用 `native-image-html-v2`。

## 分镜与版本工作台

成片库中的“分镜”会把既有 `storyboard.json` 导入 SQLite 项目目录，并建立不可覆盖的版本历史：

```text
Project → Revision → Scene → Artifact
                   └→ QualityCheck
```

- 先创建可编辑 Revision，再修改旁白/视觉提示词、排序、拆分、合并或锁定镜头；
- 旧 Revision 及其素材 hash 保留，可随时查看或回退；
- 成片首次导入时执行 ffprobe、音量、黑帧和冻结画面检查；
- 修改后的版本标记为“待重检”，在重新渲染和质检前不能审核通过；
- “完整重做”重新生成配音与 Grok 画面；“只换画面”保留配音；“只换配音”保留 Grok 原始画面；
- 画面重做默认提取当前镜头首帧作为 Grok 参考图，可手动关闭；
- 单镜任务使用独立 task ID 和输出目录并支持 API 重启恢复，同一 Revision 同时只执行一个重做任务；
- 新镜头生成成功后才替换 Scene/Artifact，随后只重拼完整成片并自动重跑质量门禁；失败时旧镜头和旧成片保持不变。

操作方式：在成片库点击“分镜”，选择或创建草稿 Revision，点击镜头右侧的魔杖按钮，选择重做范围后提交。工作台会自动轮询 pending/running/completed/failed 状态。

## 生成前分镜与内容门禁

每个频道可配置：

```yaml
planning:
  enabled: true
  approval: auto       # auto 持续生产；manual 进入人工确认队列
  content_policy: science  # general / science / psychology
  llm_review: true
```

开启后，Runner 先提交持久化 `storyboard_planning` 任务，仅调用 LLM 生成标题、旁白和视觉提示词，不调用 TTS 或 Grok 视频模型。内容门禁通过后，`auto` 模式自动把已确认旁白/提示词冻结到视频任务；`manual` 模式在生产台显示“待确认分镜”，允许编辑后再生成。内容门禁失败时，即使频道为自动模式也会停在人工确认阶段。

科普策略检查事实与推测边界并执行 Grok 二次审校；心理学策略额外检查诊断化标签、恐吓式表达、过度承诺和是否给出低风险可执行建议。检查记录会随最终 Revision 一起进入质量报告。

## 字幕安全区与受影响步骤修复

频道可启用质检失败自动修复：

```yaml
quality:
  auto_repair: true
```

HTML 模板中使用 `data-pixelle-safe="subtitle"` 标记字幕元素。渲染器会记录真实文字边界，并在必要时自动缩小字号，使字幕保持在竖屏平台安全区内；布局结果写入每个合成帧对应的 `.layout.json`，最终 Revision 的 `subtitle_safe_area` 检查会引用这些记录。

自动修复不会直接覆盖当前版本，而是创建可回退的草稿 Revision：音轨或响度失败只重做配音，黑帧或冻结失败只重做画面，字幕越界只重新执行 HTML 合成与拼接；同时涉及音频和画面时才完整重做相关镜头。修复计划、任务 ID、状态和错误保存在 SQLite，API 重启后会沿用同一任务继续执行。锁定镜头和内容审校失败保留给人工处理。

## 库存状态

每条生产记录存储在 `data/production.db`：

```text
planned → submitting → pending → running → ready → published
                                      └──→ failed / cancelled
                                              review: pending → approved / rejected
```

- `ready`：视频已生成；审核状态单独记录为待审核、已通过或已驳回；
- 只有待审核和已通过成片计入可用库存，被驳回后 Runner 会自动补产替代视频；
- 只有 `approved` 成片可以标记为 `published`；
- `published`：已被发布流程消费；
- `ready_target`：Runner 始终尝试维持的待发布库存；
- `daily_target`：当天至少完成的数量；
- `max_in_flight`：该频道同时进行的任务数；
- `max_task_retries`：复用同一个 Pixelle `task_id` 重试，避免换输出目录后重复提交 Grok 作业；
- `circuit_breaker_failures`：连续失败达到阈值后暂停补产；
- `failure_cooldown_seconds`：熔断后的等待时间。

SQLite 使用 WAL 模式，并通过带过期时间的租约保证同一数据库只有一个活跃 Runner。误启动第二个进程时，第二个进程进入 standby，不会重复补产。

标准视频管线会在分镜初始化及每个镜头完成后原子写入 `storyboard.json`。失败重试沿用原任务进度和输出目录：已完成的配音、图片、原生视频片段不会重新生成；白板模式还会复用已完成的 `*_whiteboard.mp4` 与对应分析报告。旧版 HyperFrames 任务没有 storyboard 检查点时，会从任务目录内的 `hyperframes/manifest.json` 恢复本地素材。HyperFrames 项目检查通过后会按项目指纹缓存检查报告，若随后仅渲染失败，下一次重试可跳过重复检查；已经生成且可正常探测的 `final.mp4` 会直接复用。

HyperFrames 是所有新图片栏目的默认引擎；原生图片 + HTML 不再作为频道、自定义文案或 Studio 对照渲染的可选生产方式。频道的 `video.hyperframes.fallback_to_native` 默认开启：HyperFrames 检查、服务或渲染失败时，管线会保留失败原因，复用同一任务已经生成的图片和配音，自动完成原生 HTML 合成、运镜、转场和拼接，不重新请求媒体模型。频道编辑器可关闭该回退，用于必须严格要求 HyperFrames 输出的测试频道。

F2 模板包通过 `video.hyperframes.template_id` 与 `template_version` 显式绑定，当前发布 `stickman-psychology@1`、`morning-radio@1`、`knowledge-card@1`。`variables` 只接受 manifest 声明的字段；Runner 会把默认值补齐，并将解析结果、模板指纹、样式和 `DESIGN.md` 冻结到任务目录。开发模板时可运行 `uv run python scripts/render_template_draft.py --template knowledge-card --fps 24` 生成不调用模型的低质量草稿，或加 `--build-only` 只构建并检查项目。

每次向 Pixelle API 提交时还会发送由生产记录 ID 派生的 `Idempotency-Key`。即使 API 已收到请求但 Runner 在收到响应前退出，重启重提也会取回原 `task_id`，不会再创建一条顶层视频任务。

## 本地运行

先启动持久化 API：

```bash
uv run python api/app.py --host 127.0.0.1 --port 18123
```

另一个终端先查看配置和库存，再运行一次调度：

```bash
uv run python scripts/run_production.py status
uv run python scripts/run_production.py once
```

确认无误后持续运行：

```bash
uv run python scripts/run_production.py run  # 仅用于无网页控制台的手工/服务器运维
```

日常使用时不需要单独启动上述 `run` 进程。API 会托管 Runner，可在 Production Desk 顶部使用“持续生产”开关控制；开关偏好会持久化，API 重启后自动恢复。

进程会捕获单轮网络或服务错误，记录后在下一个轮询周期继续，不会因一次 API 故障永久退出。生产主机仍应使用 Docker、systemd、launchd 等进程管理器负责机器重启后的自动拉起。

## Docker 持续运行

仓库的 Compose 文件包含 `runner` 服务，并设置 `restart: unless-stopped`：

```bash
docker compose up -d api runner
docker compose logs -f runner
```

容器内 Runner 通过 `http://api:8000` 调用 API；`data/`、`output/` 和本地频道 YAML 都已挂载。重建容器不会丢失任务、Grok request_id 或生产账本。

## 发布后补货

当前阶段不直接登录短视频平台发布。先在 Production Desk 审核通过；视频被人工或其他发布器取走后，再把最早的已通过记录标记为已发布：

```bash
uv run python scripts/run_production.py publish --channel stickman_psychology --count 1
```

没有已通过成片时命令不会越过审核门禁。标记发布后，下一轮发现 `ready` 库存下降会自动补货。命令返回对应记录及 `result.video_url`，可供后续抖音、视频号、小红书或 YouTube 发布适配器使用。

## 选题策略

- `strategy: llm`：让 `grok-4.5` 根据栏目提示生成不重复的选题和标题；
- `history_window`：发送给 LLM 的近期选题数量；
- `fallback_to_seeds: true`：LLM 暂时不可用时使用种子选题；
- `strategy: seed`：完全不调用选题 LLM，按种子池循环生产。

种子选题保证上游临时故障时仍有明确的后备输入，但视频脚本、分镜提示词仍需要配置的 LLM 可用。

## URL / RSS 内容信号源

Production Desk 的“内容信号源”支持把一个公开网页、RSS 或 Atom 订阅绑定到指定频道，并设置采集周期、每轮素材上限和每条素材的候选数量。新来源启用后会立即到期，Runner 下一轮只向 API 提交 `source_ingestion` 持久任务，不等待抓取或 Grok 返回，因此不会拖慢视频补产。

采集任务会：

1. 仅访问公开 HTTP(S) 地址，拒绝凭据 URL、本机、内网、私有或非公开 IP；
2. 每次重定向重新校验地址，限制最多 5 次跳转、20 秒超时和 2 MB 响应；
3. 拒绝二进制响应，解析 RSS、Atom 或网页正文；
4. 用来源级内容指纹跳过已见素材；
5. 结合频道 Recipe、历史内容和来源正文让 Grok 生成候选；
6. 把候选放入选题收件箱，近似重复项默认丢弃，人工通过或钉住后才进入生产。

内容源状态、最近任务、下次采集、错误和本轮统计保存在同一 SQLite 账本。API 重启后任务管理器会恢复未完成采集；上游异常时记录错误并推迟到下一周期，也可以在创作台“立即采集”重试。

Grok 在生成候选时还会提取题材、对象、机制和结论概念词。评分器把概念词与正文特征投影为 384 维归一化向量，并同时计算向量余弦相似度和字面相似度；任一超过门槛都会关联原候选并阻止其自动进入生产。每个候选保留一个控制标题和多个不同假设的标题版本，创作台选中的版本会写入候选快照，Runner 消费时不会重新随机选择。

## AI 制片助手

Production Desk 顶部的“AI 制片”打开独立控制台。助手可以读取频道库存与状态、最近失败、选题候选、内容来源、待审分镜以及项目/版本/镜头质量状态，适合执行以下工作：

- 解释近期失败任务的共同原因；
- 对比各频道库存、在途任务和停启状态；
- 找出高分待审选题；
- 起草创建/调整/暂停/恢复频道、选题决策或失败任务重试计划。
- 起草分镜批准、单镜最小范围重生成、失败质检自动修复和版本切换计划。

助手不会直接修改生产账本。任何写操作先持久化为 `pending` 计划，界面展示目标、原因、影响和可回退性；只有点击“批准并执行”后才进入执行。服务器会再次校验真实 ID 和当前状态，并以 SQLite 条件更新保证同一计划只被一个审批请求执行。拒绝计划不会改变生产状态。

当前 AI 工具白名单不包含发布、删除、平台操作或批量重做。单镜重生成与质量修复会在审批卡上标识“会调用生成模型”。会话、计划、审批结果和执行错误都保存在 `production.db`，便于追溯。人工仍可在对应资源卡片上使用下述安全删除流程。

## 永久删除

生产台为成片/任务、待审选题、内容来源、频道、Brand Kit / Recipe、制片助手会话、非当前 Revision 和草稿镜头提供统一删除入口。点击删除后，服务端会先返回关联记录、媒体数量和阻塞原因；只有输入“删除”后才会执行。

删除一条已生成视频会级联清理对应生产任务、项目、全部 Revision、Scene、Artifact 和质检记录，并把该任务消费的选题恢复为 `approved`。运行中任务必须先取消；已消费选题必须先删除对应视频；当前 Revision、仍被频道绑定的预设、存在关联生产数据的频道以及正在执行的制片计划均禁止删除。

确认删除后会同时永久清除受管理的本地文件。对于生产队列和成片库中的整条视频，服务会定位并递归删除对应的 `output/<任务 ID>/`，其中未登记到 Artifact 表的布局文件、中间帧、音频、白板笔迹分析/静音段、HyperFrames 项目和其他旁路产物也会一并清除。该操作不可恢复；仍在运行的任务会被预检阻止，Revision/Scene 的共享素材仍会执行引用保护。

## 批量审核与队列操作

成片库支持按审核状态、频道和标题筛选，并可选择当前可审成片批量通过或驳回。每次批量写入会先执行影响预检：确认任务仍为 `ready`，通过时还会检查当前 Revision 的技术质量门禁。任何一条被阻止时整批不写入；全部合格后用单个 SQLite 事务一次提交。批量驳回必须填写统一修改意见。

生产队列支持多选、按当前筛选全选、批量重试和批量删除。批量重试只接受失败任务，并在执行前检查关联异步任务仍处于可重试状态。批量删除会逐条汇总项目、版本、镜头、素材和完整任务目录影响；任一任务仍在活动状态时整批阻止。通过预检后，账本记录在一个 SQLite 事务中删除，对应 output 任务目录永久清除。

## 运维命令

```bash
# 查看全部频道的 ready、published、failed、in_flight 等状态
uv run python scripts/run_production.py status

# 手动触发一轮补产，适合排错或 Cron
uv run python scripts/run_production.py once

# 恢复所有已经提交到 Grok、但本地轮询中断的视频请求
uv run python scripts/resume_grok_jobs.py
```

若凭据失效或上游持续失败，Runner 会先复用原 Pixelle task_id 重试，然后进入频道熔断。修复配置后可等待冷却结束，或停止 Runner、确认原因后再重新启动。
