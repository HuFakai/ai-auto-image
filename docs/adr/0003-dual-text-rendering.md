# ADR-0003：双文字渲染 — 原生模式默认，确定性渲染为可控兜底

状态：已接受（2026-08-29）

## 背景

早期方案要求「文字绝不交给图片模型」，以杜绝中文错字，代价是每次改字都要重新走
Satori 合成、且服务器承担 Sharp 合成开销。修订后的规划（docs/02 §9）确立双模式：
主力模型（`grok-imagine-image-2.0` / `gpt-image-2`）已能生成可读中文，完整出图的
融合度更高、服务器开销更低。

## 决策

1. `TextRenderingMode = native | deterministic | auto_fallback`，默认 `native`：
   - native：已确认文案逐字写入 Prompt（`buildSlidePrompt`），模型输出即最终图；
     服务器只做流式转存、魔数/尺寸校验、元数据登记，不做文字合成。
   - deterministic：显式开启；AI 出无文字视觉层，Satori/SVG + Sharp 合成标题、
     正文、页码；文字零成本可编辑。
   - auto_fallback：默认不开启（避免静默增加调用与费用）。
2. 开关层级：系统默认 → Recipe → 项目 → Run → 单页；`auto_fallback` 需显式开启。
3. 原生模式的质量闭环：预期文案（`expectedCopy`）随资产落库，视觉模型逐字审查；
   结果只记录不静默重试 —— 失败页提供「原生重试」与「切换确定性渲染」两种操作。
4. 确定性渲染必须可复现：布局树为纯函数（无随机/时间），中文字体（Noto Sans SC，
   OFL）随部署固定，模板带版本指纹（`darkroom-knowledge@1`）；文字溢出用估算宽度
   自动缩字号，缩到下限仍溢出则显式报错（溢出检出率 100% 的落点）。
5. 并发双轨：图片 API 并发（`IMAGE_GENERATION_CONCURRENCY_*`，默认 1 / 上限 4）与
   本地 Sharp 后处理并发（`IMAGE_POSTPROCESS_CONCURRENCY_MAX`，默认 1）分开限流；
   有效并发 = min(请求值, 服务器上限, Provider 上限)；429 时收紧信号量并指数退避；
   图片响应流式写盘（`.part` + 原子 rename），并发任务不在内存保存完整大图。

## 后果

- 修改文案在 native 模式下会重新调用图片模型 —— UI 必须提前提示费用（阶段 1 实现）。
- 价格、参数、书名等强合规字段在 native 模式依赖审查兜底，阶段 1 的商品 Recipe
  默认建议这些页面走 deterministic。
- Playwright/Chromium 不进入生产镜像；若未来出现 Satori 无法覆盖的排版需求，
  以独立按需渲染服务评估。
