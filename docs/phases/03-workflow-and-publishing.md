# 阶段 3：工作流与平台发布

## 1. 阶段目标

把固定 Recipe 升级为可配置工作流，并通过受控的发布适配器将内容写入小红书或微信公众号草稿，同时保持审批、幂等、安全和审计边界。

## 2. 范围

### 包含

- 将 SQLite 数据迁移到 PostgreSQL，并提供校验与回滚方案。
- 引入 Redis + BullMQ，将进程内 Job Runner 拆分为独立 Worker。
- 将服务器持久卷资产接口保持不变；是否迁移 S3/R2 根据容量和扩容需求单独决策。
- 可视化工作流编辑器。
- 节点、条件、并行、人工审批和子工作流。
- Recipe 到 Workflow Definition 的转换。
- 工作流版本和发布。
- MCP、REST API 和 Webhook 触发。
- 小红书发布 Adapter。
- 微信公众号文章和图片草稿 Adapter。
- 抖音优先提供发布包，官方或受控连接器作为实验能力。
- 内容日历和排期。
- 幂等、防重复和外部状态核对。

### 不包含

- 无确认的全自动群发。
- 自动点赞、评论、关注和私信。
- 绕过验证码或平台风控。

## 3. Workflow Definition

开始本阶段前先完成基础设施升级：

1. 暂停外部写入并备份 SQLite 和资产目录。
2. 创建 PostgreSQL Schema 和索引。
3. 批量迁移数据并逐表校验行数、外键和校验和。
4. 双读验证通过后切换数据库连接。
5. 将 `jobs` 表中的未完成任务转换到 BullMQ，并保留历史 Node Run。
6. 部署独立 Worker 和 Redis，完成故障恢复演练。
7. 保留可回退的 SQLite 只读快照，直到稳定观察期结束。

```ts
type WorkflowDefinition = {
  id: string;
  version: number;
  inputSchema: JsonSchema;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  outputMapping: Record<string, string>;
  limits: {
    maxCost?: number;
    maxDurationMs?: number;
    maxParallelism?: number;
  };
};
```

节点类型：

- Input。
- LLM Text。
- LLM Object。
- Image Generate。
- Image Edit。
- Render。
- Quality Gate。
- Condition。
- Parallel Map。
- Human Approval。
- Transform。
- Storage。
- Export。
- Publish Draft。
- Webhook。
- Sub-workflow。

## 4. 可视化编辑器

采用 React Flow，提供：

- 左侧节点库。
- 中央画布。
- 右侧节点配置和输入输出映射。
- Schema 兼容检查。
- 运行前静态校验。
- 单节点测试。
- 调试运行和节点输出预览。
- Workflow 草稿、版本和发布。

编辑器只操作声明式定义，不能保存任意可执行 JavaScript。Transform 节点使用受限表达式或预置函数。

## 5. 工作流执行能力

- DAG 拓扑校验。
- 条件分支。
- Map 并行。
- 节点级重试和退避。
- 超时和取消传播。
- 人工审批暂停与恢复。
- 子工作流。
- 断点重跑。
- 输入输出快照。
- 成本和并发预算。

工作流定义版本一旦用于正式 Run 就不可变；修改后创建新版本。

## 6. 审批模型

标准审批点：

1. 创作方向确认。
2. 标题和 Storyboard 确认。
3. 最终作品确认。
4. 发布目标、时间和账号确认。

发布授权必须记录：

- 用户 ID。
- 目标平台和账号别名。
- 作品版本。
- 标题和图片数量摘要。
- 授权时间。
- 发布或草稿范围。

终稿确认不能自动推导为发布授权。

## 7. 平台 Adapter 接口

```ts
interface PlatformAdapter {
  checkAuth(account: PlatformAccount): Promise<AuthStatus>;
  validateDraft(input: PlatformDraftInput): Promise<ValidationReport>;
  createDraft(input: PlatformDraftInput, idempotencyKey: string): Promise<DraftResult>;
  getDraftStatus(externalId: string): Promise<DraftStatus>;
  publish?(input: PublishInput, idempotencyKey: string): Promise<PublishResult>;
  capabilities(): PlatformCapabilities;
}
```

所有平台 Adapter 作为独立 Package 或独立服务运行。

## 8. 小红书 Adapter

优先集成成熟的独立 MCP/服务，不在核心服务中保存或解析平台 Cookie。

功能范围：

- 登录状态检查。
- 图文草稿或发布前校验。
- 标题、正文、标签和图片上传。
- 可选定时发布。
- 发布结果和失败原因。

安全要求：

- 用户明确选择账号。
- 最终预览后再次确认。
- 验证码、限流或页面变化时立即停止。
- 不自动重试结果不确定的写操作，先查询外部状态。

## 9. 微信公众号 Adapter

首选官方 API 创建草稿；账号条件不满足时使用独立本地 MCP 作为可选方案。

功能范围：

- 图片上传到微信 CDN。
- 封面素材上传。
- Markdown/HTML 转微信兼容内联样式。
- 创建文章草稿。
- 创建图片消息草稿。
- 查询草稿状态。

默认不执行正式发布或群发。

HTML 处理必须：

- 内联样式。
- 移除脚本和不支持标签。
- 替换正文图片 URL。
- 检查标题、摘要、作者和封面。
- 提供最终微信预览。

## 10. 抖音策略

阶段 3 默认交付：

- 9:16 图片包。
- 标题、正文和标签。
- 图片顺序和封面建议。
- 人工发布清单。

只有在官方能力、账号资质和稳定性验证通过后，才启用自动写入。任何浏览器自动化都必须作为实验 Adapter，可独立关闭。

## 11. 内容日历

- 月、周和列表视图。
- 草稿、待审、待发布、已发布和失败状态。
- 拖动调整排期。
- 平台和账号筛选。
- 发布时间冲突提示。
- 发布前提醒和过期授权处理。

## 12. MCP 与 API

MCP 工具建议：

- `create_content_project`
- `generate_content_package`
- `get_generation_status`
- `revise_slide`
- `export_content_package`
- `validate_platform_draft`
- `create_platform_draft`

外部调用默认只能生成和导出；发布相关工具必须要求独立授权参数和服务端权限。

## 13. 幂等与失败恢复

每次平台写操作生成幂等键：

```text
workspace + platform + account + projectVersion + operation
```

处理规则：

- 请求超时但结果未知：先查询平台状态。
- 已存在相同草稿：返回已有结果。
- 图片部分上传成功：记录外部素材 ID，恢复时复用。
- 正式发布失败：不自动回退到其他账号或平台。

## 14. 测试计划

### 工作流测试

- DAG 环检测。
- Schema 输入输出连接检查。
- 条件和并行节点。
- 审批暂停和恢复。
- PostgreSQL/Redis/Worker 重启和任务恢复。
- SQLite 到 PostgreSQL 的迁移完整性与回滚演练。
- 成本与时长预算。

### Adapter 合同测试

- 认证过期。
- 图片上传失败。
- 平台参数验证。
- 超时后的状态核对。
- 幂等重复调用。
- 上游字段变化。

### 发布演练

- 测试账号创建小红书私密内容或草稿。
- 测试公众号草稿箱。
- 禁用正式发布能力后确认无法绕过。

## 15. 交付物

- 可视化工作流编辑器。
- Workflow Definition 版本管理。
- Human Approval 节点。
- 小红书 Adapter。
- 微信公众号草稿 Adapter。
- 抖音发布包。
- 内容日历。
- MCP 和 REST API。
- 发布审计和幂等机制。

## 16. 验收标准

- 用户可以用画布组合并运行一个图文工作流。
- 工作流在审批节点可靠暂停和恢复。
- 小红书和公众号写操作均要求明确授权。
- 重复提交相同幂等键不会创建重复草稿。
- 写操作超时后系统先查询状态，不盲目重试。
- 平台凭证不进入模型上下文和普通日志。
- Adapter 可被独立禁用而不影响内容生成和导出。

## 17. 退出条件

工作流编辑器、审批、至少两个平台草稿 Adapter 和内容日历经过真实账号验证，并完成安全审查与失败演练后，进入阶段 4。
