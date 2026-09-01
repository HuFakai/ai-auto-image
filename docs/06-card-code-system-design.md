# 卡密系统总体设计方案

> 设计日期：2026-09-01  
> 当前阶段：已完成第一版全链路开发，待部署环境联调  
> 适用项目：AI Auto Image 现有 PostgreSQL、点数钱包、订单、订阅和管理后台体系

## 1. 建设目标

增加一套可运营、可审计、可供外部销售系统集成的卡密系统：

- 管理后台可以随时开启或关闭卡密功能；关闭后不影响已经到账的权益。
- 管理员可以创建批次、批量生成、一次性导出、停用卡密并查询兑换记录。
- 登录用户可以在充值中心兑换卡密，权益直接进入现有钱包或订阅体系。
- 外部销售系统可以通过受控 API 按需生成卡密，并用幂等键防止重复生成。
- 卡密兑换、钱包入账、订单和点数流水必须在同一事务内完成。
- 数据库不保存可直接兑换的明文卡密，泄露数据库不能直接导致卡密被盗用。

## 2. 范围与版本建议

### 2.1 第一版必须实现

- 单次兑换的点数卡。
- 卡密总开关、用户兑换开关、外部 API 开关。
- 后台批次生成、查询、筛选、停用和一次性 CSV 导出。
- 用户充值中心兑换入口。
- 外部 API Key、权限范围、限流和幂等生成。
- 卡密兑换订单、点数流水、管理员审计记录。

### 2.2 已实现与后续增强

- 会员卡：兑换后开通或顺延指定会员套餐（已实现）。
- 组合卡：一次兑换同时发放会员和额外点数（已实现）。
- 外部销售系统回调：卡密兑换成功后发送签名 Webhook，失败自动退避重试（已实现）。
- 经销商、渠道库存、销售价和渠道结算报表。

第一版不建议实现可重复兑换卡、共享优惠码或按次数使用的兑换码。这些能力的风控和业务语义与“一卡一密、一次兑换”不同，应独立设计。

## 3. 核心业务原则

1. **一卡一密、只成功一次**：同一卡密不能被两个用户重复兑换。
2. **权益快照**：生成时冻结点数、会员周期等权益，后续套餐改价不改变已生成卡密。
3. **原子入账**：卡密占用、钱包入账、订单、流水和订阅变更必须同事务提交。
4. **明文只出现一次**：创建成功响应或 CSV 中返回明文，数据库只保存摘要、前缀和末四位。
5. **停用不删除**：生成后的卡密和批次不物理删除，只能停用，保证审计链完整。
6. **关闭不作废**：关闭卡密系统只是暂停生成或兑换，已有卡密保持原状态。
7. **卡密收入不混入站内支付收入**：外部销售金额无法由本站确认，兑换订单金额记 0，后台收入统计排除卡密兑换订单。

## 4. 功能开关设计

新增数据库级系统设置，不使用 `.env` 作为日常运营开关：

| 设置项 | 默认值 | 作用 |
| --- | ---: | --- |
| `card_system_enabled` | `0` | 总开关；关闭时普通用户和外部 API 均不可使用 |
| `card_redeem_enabled` | `1` | 用户兑换子开关 |
| `card_api_enabled` | `0` | 外部生成 API 子开关 |

总开关优先级最高：

- 总开关关闭：充值中心隐藏兑换入口，兑换接口返回 `CARD_SYSTEM_DISABLED`，外部生成接口停止服务。
- 兑换开关关闭：后台仍可生成和管理，用户暂时不能兑换。
- API 开关关闭：后台人工生成不受影响，外部 API 返回 `CARD_API_DISABLED`。
- 管理员始终可以进入卡密管理页查看数据、停用卡密和修改开关。

设置保存在 `system_settings` 表；当前每次请求读取数据库，后台修改后立即生效，不需要 Redis。

## 5. 卡密格式与安全

### 5.1 推荐格式

```text
AAI-00000-00000-00000-00000-0000000
```

- `AAI`：产品标识。
- 主体使用 Crockford Base32，排除 `I/L/O/U` 等易混淆字符，当前格式为 `AAI-` 加 27 个字符（5-5-5-5-7 分组）。
- 随机部分至少 128 bit，不使用自增 ID、时间戳或批次号推导。
- 最后一组包含校验字符，用于在查询数据库前发现输错。
- 用户输入时忽略大小写、空格和连字符，统一归一化后校验。

### 5.2 存储方式

数据库仅保存：

- `code_hash`：`HMAC-SHA256(APP_SECRET 派生密钥, 归一化卡密)`，唯一索引。
- `code_prefix`：用于后台识别，例如 `AAI-7K9M`。
- `code_last4`：用于客服核对。
- 不保存完整明文卡密。

明文仅在生成成功响应中返回一次。管理员或外部系统如果遗失明文，应停用未兑换批次并重新生成，系统不提供“找回卡密”。

### 5.3 防攻击措施

- 当前实现按“用户 ID + IP”使用单进程固定窗口限流，每分钟最多 5 次；多实例部署前应把计数迁移到 Redis，并再增加小时级失败风控。
- 连续失败冻结、设备指纹和更细粒度的风控告警列为后续增强，不在当前第一版中假装已启用。
- 普通用户错误信息统一为“卡密无效或当前不可用”，避免枚举有效卡密。
- 管理后台可以看到准确原因：已兑换、已过期、已停用或批次停用。
- 日志只记录卡密 ID、前缀和末四位，严禁记录明文。

## 6. 数据模型

已落地迁移 `0010_card_code_system.sql`，包含以下表。

### 6.1 `system_settings`

| 字段 | 说明 |
| --- | --- |
| `key` | 主键，例如 `card_system_enabled` |
| `value_json` | JSON 值 |
| `updated_by` | 最后修改管理员 |
| `updated_at` | 北京时间展示，数据库保存 epoch 毫秒 |

### 6.2 `card_batches`

| 字段 | 说明 |
| --- | --- |
| `id` / `batch_no` | 内部 ID 和可展示批次号，均唯一 |
| `name` | 批次名称 |
| `benefit_type` | `credits`，预留 `subscription`、`combo` |
| `benefit_json` | 冻结权益快照，例如 `{ "credits": 100 }` |
| `quantity` | 本批次生成数量 |
| `status` | `active`、`disabled`、`completed` |
| `expires_at` | 统一过期时间，可为空表示长期有效 |
| `source` | `admin` 或 `api` |
| `external_batch_id` | 外部销售系统批次号，可空 |
| `sales_channel` | 渠道备注，例如淘宝、发卡平台、代理商 |
| `remark` | 管理备注 |
| `created_by` | 管理员或外部 API Key ID |
| `created_at` / `updated_at` | 时间戳 |

索引：`batch_no` 唯一、`source + external_batch_id` 按调用方维度唯一、`status + created_at` 普通索引。

### 6.3 `redemption_cards`

| 字段 | 说明 |
| --- | --- |
| `id` | 卡密 ID |
| `batch_id` | 所属批次 |
| `code_hash` | 卡密摘要，唯一 |
| `code_prefix` / `code_last4` | 后台脱敏展示 |
| `status` | `active`、`redeemed`、`disabled` |
| `expires_at` | 可覆盖批次过期时间 |
| `redeemed_by` / `redeemed_at` | 兑换用户与时间 |
| `redemption_order_id` | 对应兑换订单 |
| `metadata_json` | 外部商品、渠道等扩展字段 |
| `created_at` / `updated_at` | 时间戳 |

状态为 `active` 但已超过 `expires_at` 时按已过期处理，无需定时批量更新状态。

### 6.4 `card_redemptions`

保存每次兑换尝试的最终业务记录：

- `id`、`card_id`、`batch_id`、`user_id`、`order_id`。
- `status`：`succeeded` 或 `failed`。
- `failure_code`：仅管理端可见。
- `ip_hash`、`user_agent_hash`：用于风控，不保存完整 IP 和 UA。
- `created_at`。

成功记录对 `card_id` 建唯一索引。高频失败请求可只进入结构化安全日志，避免攻击者制造大量数据库记录；达到风控阈值或命中有效卡密的失败才落审计表。

### 6.5 `external_api_keys`

- `id`、`name`、`key_prefix`、`key_hash`。
- `scopes_json`：第一版至少支持 `cards:generate`、`cards:read`、`cards:disable`。
- `ip_allowlist_json`：可选。
- `rate_limit_per_minute`。
- `status`、`last_used_at`、`expires_at`、`created_by`、`created_at`。
- API Key 明文只在创建时显示一次，数据库只保存 SHA-256 摘要。

### 6.6 `api_idempotency_records`

- 唯一键：`api_key_id + idempotency_key`。
- 保存 `request_hash`、`resource_type`、`resource_id`。
- 为保证重复请求能返回完全相同的一批明文卡密，响应体使用 `APP_SECRET` 加密保存，默认保留 24 小时后清除。
- 相同幂等键但请求体不同，返回 `409 IDEMPOTENCY_CONFLICT`。

### 6.7 时间、限流和部署边界

- 数据库时间统一保存 Unix 毫秒；管理页面、充值中心和日志展示统一转换为北京时间（Asia/Shanghai）。外部 API 的 `expiresAt` 接受 ISO 时间或 Unix 毫秒，返回 Unix 毫秒。
- 当前应用是单容器部署，兑换和 API 限流使用进程内固定窗口；卡密兑换 Webhook 状态保存在 PostgreSQL，应用定时器每 30 秒领取待投递记录并退避重试。
- 多实例部署前，限流计数和 Webhook 领取必须迁移到 Redis/共享队列；不通过复制多个 Web 容器来“自然扩容”。

## 7. 与现有计费系统的衔接

卡密兑换不直接调用普通支付成功逻辑，而是新增专用事务服务 `CardRedemptionService`。

点数卡兑换成功时，在一个 PostgreSQL 事务中完成：

1. 条件更新卡密：仅 `active`、未过期、批次可用时改为 `redeemed`。
2. 确保用户钱包存在。
3. 钱包 `balance` 和 `total_granted` 增加卡密点数。
4. 创建 `orders` 记录：
   - `type = card_redeem`
   - `channel = card`
   - `status = redeemed`
   - `amount_cents = 0`
   - `credits = 实际发放点数`
   - `title = 卡密兑换 · 批次名称`
5. 创建 `credit_ledger`：
   - `reason = card_redeem`
   - `ref_type = order`
   - `ref_id = 兑换订单 ID`
   - `display_title = 卡密兑换 · 批次名称`
6. 写入 `card_redemptions` 成功记录并回填卡密订单 ID。

任意一步失败则全部回滚。并发兑换同一卡密时，只允许一个事务的条件更新成功，其余请求返回不可用，不会重复加点。

现有后台收入统计需要排除 `card_redeem`；用户订单和管理员订单页增加“卡密兑换”类型与订单号查询。点数明细直接显示卡密批次名称。

## 8. API 设计

### 8.1 用户兑换接口

```http
POST /api/cards/redeem
Cookie: aai_session=...
Content-Type: application/json

{
  "code": "AAI-7K9M-4XPF-D2QH-N8TW-6C"
}
```

成功响应：

```json
{
  "ok": true,
  "orderNo": "CRD20260901...",
  "benefit": { "type": "credits", "credits": 100 },
  "balance": 256,
  "batchNo": "CB20260901..."
}
```

### 8.2 状态接口

```http
GET /api/cards/status
```

只返回用户需要的开关，不暴露批次或 API 配置：

```json
{ "enabled": true }
```

### 8.3 管理后台接口

- `GET/PATCH /api/admin/cards/settings`：读取和修改开关。
- `GET/POST /api/admin/cards/batches`：分页查询和创建批次。
- `GET /api/admin/cards/batches/:id`：批次统计和脱敏卡密列表。
- `POST /api/admin/cards/batches/:id/disable`：停用整个批次未兑换卡密。
- `POST /api/admin/cards/:id/disable`：停用单张未兑换卡密。
- `GET/POST /api/admin/cards/api-keys`、`DELETE /api/admin/cards/api-keys/:id`：API Key 管理。
- `GET /api/admin/cards/summary`、`GET /api/admin/cards/webhooks`：运营统计和 Webhook 投递记录。

批次创建接口成功时返回一次性下载内容；刷新页面后不再提供明文。

### 8.4 外部销售系统 API

```http
POST /api/v1/cards/generate
Authorization: Bearer aai_live_xxxxxxxxx
Idempotency-Key: order-20260901-100086
Content-Type: application/json

{
  "externalBatchId": "seller-order-100086",
  "name": "淘宝 100 点充值卡",
  "quantity": 1,
  "benefit": { "type": "credits", "credits": 100 },
  "expiresAt": "2027-09-01T23:59:59+08:00",
  "salesChannel": "taobao",
  "metadata": { "sku": "AI100" }
}
```

成功响应：

```json
{
  "requestId": "req_...",
  "batchNo": "CB20260901...",
  "cards": [
    {
      "cardId": "card_...",
      "code": "AAI-7K9M-4XPF-D2QH-N8TW-6C",
      "status": "active",
      "expiresAt": 1810000000000
    }
  ]
}
```

补充接口：

- `GET /api/v1/card-batches/:externalBatchId`：查询批次统计，不返回卡密明文。
- `GET /api/v1/cards/:cardId`：查询单卡状态，只返回脱敏信息。
- `POST /api/v1/cards/:cardId/disable`：售后停用未兑换卡密。

第一版建议后台单批最多 1000 张，外部单请求最多 100 张；超大批次后续改为异步任务。成功响应包含 `requestId`（Unix 毫秒时间戳字段也按毫秒传输，页面展示统一使用北京时间），限流时返回 `429` 和 `Retry-After`。

## 9. 后台管理页面

在“运营控制台”新增“卡密”导航，页面分为四个区域。

### 9.1 运营开关

- 卡密系统总开关。
- 用户兑换开关。
- 外部 API 开关。
- 关闭前明确提示影响范围，不删除或作废已有卡密。

### 9.2 数据概览

- 累计生成、未兑换、已兑换、已停用、已过期。
- 今日兑换、本月兑换点数、兑换率。
- 按销售渠道和批次查看兑换情况。

### 9.3 批次管理

创建表单：批次名称、权益类型、点数、数量、过期时间、销售渠道、外部批次号和备注。

列表支持：批次号/名称/外部单号搜索，状态、渠道和日期筛选，分页，详情，停用未兑换卡密。

批次详情显示脱敏卡密、状态、兑换用户、兑换订单号和北京时间；不显示或恢复完整明文。

### 9.4 API 集成

- 创建、吊销和轮换 API Key。
- 配置权限范围、IP 白名单、每分钟限额和过期时间。
- 展示接口地址、请求示例、最近使用时间和错误统计。

## 10. 用户端交互

在充值中心增加“兑换卡密”区域：

- 只有总开关和兑换开关都开启时显示。
- 支持粘贴带空格或连字符的卡密。
- 点击兑换前展示即将兑换的提示，但不提供未兑换卡密的权益探测接口。
- 成功后刷新钱包、点数明细和我的订单。
- 重复提交同一卡密时不重复入账；如果是当前用户已经兑换，可返回原订单号和“已兑换”提示。

## 11. 状态机

```text
批次：active ──停用──> disabled
  └─全部卡密兑换/失效──> completed（可由查询时派生）

卡密：active ──兑换事务成功──> redeemed
  ├─管理员/外部系统停用──> disabled
  └─超过 expires_at──> expired（派生状态）
```

已兑换卡密不能停用或转移用户。退款、撤销或兑换后回收权益第一版不提供自动操作，应通过管理员调点并保留人工备注处理。

## 12. 错误码

| HTTP | 错误码 | 说明 |
| ---: | --- | --- |
| 400 | `INVALID_REQUEST` | 参数不合法 |
| 401 | `UNAUTHORIZED` | 未登录或 API Key 无效 |
| 403 | `CARD_SYSTEM_DISABLED` | 卡密总开关关闭 |
| 403 | `CARD_API_DISABLED` | 外部 API 关闭 |
| 403 | `INSUFFICIENT_SCOPE` | API Key 权限不足 |
| 409 | `CARD_UNAVAILABLE` | 卡密无效、已兑换、已过期或已停用；用户端统一返回 |
| 409 | `IDEMPOTENCY_CONFLICT` | 幂等键被不同请求体复用 |
| 429 | `RATE_LIMITED` | 触发兑换或接口限流 |

## 13. 分阶段开发计划

### 阶段 A：数据与安全基础（P0，已完成）

- 新增迁移、Schema、Repo、卡密生成/归一化/摘要工具。
- 新增数据库系统设置、卡密总开关和管理端权限保护。
- 实现兑换事务和并发唯一性。
- 调整订单、点数流水类型和收入统计口径。

验收：并发兑换同一卡密只成功一次；任何事务失败都不产生半笔钱包或流水记录。

### 阶段 B：后台与用户兑换（P0，已完成）

- 卡密后台导航、开关、概览、批次创建和详情。
- 一次性 CSV 导出、批次/单卡停用。
- 充值中心兑换入口、成功刷新钱包/订单/流水。

验收：管理员可以完成“生成—导出—用户兑换—后台追踪”的闭环。

### 阶段 C：外部销售 API（P1，已完成）

- API Key 管理、scope、IP 白名单和限流。
- 生成、查询、停用接口。
- 幂等记录和 24 小时加密响应重放。
- 请求 ID、结构化审计日志和接口文档。

验收：相同幂等键重复调用返回相同卡密；不同请求体复用幂等键返回 409；吊销 Key 立即失效。

### 阶段 D：扩展权益与运营（P2，已完成基础能力）

- 会员卡和组合卡。
- 兑换 Webhook、签名、重试和投递记录查看。
- 卡密汇总统计；渠道库存、兑换漏斗、异常频率告警和渠道结算报表列为下一期增强。

## 14. 测试与发布门禁

已覆盖/发布前需继续覆盖：

- 卡密随机性、格式归一化、校验位和摘要一致性。
- 总开关、兑换开关和 API 开关的所有组合。
- 同一卡密 10–50 个并发兑换只产生一笔订单、一笔流水和一次入账。
- 事务中任一步骤失败时完整回滚。
- 过期、停用、批次停用、已兑换和非法卡密。
- API Key scope、吊销、IP 白名单、限流和幂等冲突。
- 日志、接口和后台页面不泄露完整卡密或 API Key。
- 卡密兑换订单不计入支付宝/微信收入和支付成功率。

上线顺序：迁移数据库 → 保持总开关关闭部署代码 → 管理员创建小批测试卡 → 内部兑换对账 → 开启兑换 → 最后开启外部 API。

## 15. 推荐决策

1. 点数卡、会员卡和组合卡均按权益快照兑换。
2. 明文卡密只返回一次，不提供后台再次下载。
3. 外部 API 使用独立 API Key，不复用管理员 Cookie 或 `APP_SECRET`。
4. 外部生成必须提供 `Idempotency-Key`；生产环境不接受无幂等键请求。
5. 卡密兑换形成独立订单和点数流水，但不计入站内支付收入。
6. 继续使用现有 PostgreSQL 和单容器架构；卡密系统本身不需要 Redis，后续只有在多实例限流或 Webhook 队列出现需求时再引入。
