# ADR-0001：模型层 — 自建领域接口 + OpenAI-compatible Wire 适配

状态：已接受（2026-08-29）

## 背景

业务需要 OpenAI、xAI/Grok 与任意 OpenAI-compatible 服务可互换（docs/02 §8），且不允许
SDK 类型扩散到领域代码。Auto-AI-Video 的 `model_routing.py` + `llm_service.py` 验证了
「多路由回退 + 尝试记录 + 空响应恢复」在生产中的有效性。

## 决策

1. 业务层只依赖 `@aai/ai-core` 的 `TextModel / ImageModel / VisualQualityModel` 接口与
   8 类归一化错误（`AiError`），永远不接触 SDK 响应。
2. Wire 层统一使用官方 `openai` SDK（`maxRetries: 0`，重试完全由路由层负责）：
   - `provider-openai`：通用 OpenAI-compatible 实现 + 官方路由预设；
   - `provider-xai`：`base_url=https://api.x.ai/v1` + xAI 能力表（临时 URL 必须立即转存）；
   - `provider-compatible`：自定义 baseUrl/headers，能力显式配置，不根据模型名猜测。
3. 回退循环 `withModelFallbacks`：preferred → fallback 逐路由、逐 attempt；
   不可重试错误（authentication / content_policy / invalid_request）直接切换路由；
   每次尝试（含成功）都写入 `provider_attempts`，不只记录最终成功者。
4. 结构化输出不依赖 Provider JSON mode：把 Zod→JSON Schema 注入 Prompt，
   三级解析容错（直接 JSON → 代码块 → 首尾大括号），校验失败允许一次带错误的修复调用。
5. 阶段 0 暂不引入 Vercel AI SDK：三家 Provider 均为 OpenAI-compatible，openai SDK 已覆盖；
   引入 AI SDK 的收益（Provider 生态、工具调用）延后到出现需求时评估。

## 后果

- 新增 Provider = 声明路由 + 能力表，不改业务代码。
- usage/cost 是新增能力（视频项目完全没有），由 `ModelUsage` 统一采集入账本。
- openai SDK 的类型在 Wire 层通过最小结构接口约束，SDK 升级只影响一个包。
