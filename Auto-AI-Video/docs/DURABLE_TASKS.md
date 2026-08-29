# 持久化异步任务

FastAPI 的 `POST /api/video/generate/async` 不再只把任务放在进程内存中。每次状态变化都会原子写入：

```text
data/api_tasks.json
```

默认最多同时执行 5 条顶层视频任务。其余任务保持 `pending`，不会无限制抢占本机渲染和上游连接。

## 重启恢复过程

1. API 收到请求后先创建 UUID `task_id` 并持久化完整生成参数。
2. Pipeline 使用同一个 `task_id` 创建 `output/<task_id>`，所以路径可重建。
3. 每次进度、开始、完成、失败和取消都会更新任务文件。
4. 正常关闭或进程中断时，磁盘上保留 `pending`/`running` 状态。
5. API 下次启动时加载任务文件，把未完成任务以同一 `task_id` 重新排队。
6. Grok 场景按输出路径寻找已经提交的 `request_id`，继续轮询，不重复创建视频任务。

任务对象新增两个计数：

- `attempts`：顶层 Pipeline 实际启动次数；
- `recoveries`：从 `running` 状态恢复的次数。

这些字段可通过 `GET /api/tasks/{task_id}` 查看。

## 配置

任务文件默认位置可以用环境变量覆盖：

```bash
export PIXELLE_TASK_STORE_PATH=/persistent/path/api_tasks.json
```

代码级默认配置位于 `api/config.py`：

```python
max_concurrent_tasks = 5
task_cleanup_interval = 3600
task_retention_time = 86400
resume_interrupted_tasks = True
```

完成、失败或取消的任务默认保留 24 小时，然后由清理循环从任务索引移除；生成的素材和视频文件不会因此删除。

## Docker

仓库的 `docker-compose.yml` 已将 `./data` 和 `./output` 挂载到持久目录，因此默认配置无需再增加 volume。部署时必须同时保留：

```text
data/api_tasks.json
data/grok_jobs/
output/<task_id>/
```

三者分别保存顶层任务、grok2api 上游任务和实际素材。缺少其中任意一个都会降低恢复完整性。

## 状态语义

| 状态 | 重启行为 |
|---|---|
| `pending` | 自动重新排队 |
| `running` | 恢复计数加一，然后自动重新排队 |
| `completed` | 保留结果，不重复运行 |
| `failed` | 保留错误，默认不自动重试 |
| `cancelled` | 保持取消，不自动恢复 |

## 当前限制

- 使用原子 JSON 文件，适合单个 API 进程和本地/Docker MVP。
- 不要用多个 Uvicorn Worker 共享同一任务文件。
- 顶层恢复会从同一输出目录读取逐镜 storyboard 检查点；已完成的配音、图片、视频片段、Grok `request_id` 与通过项目指纹校验的 HyperFrames 检查报告不会重复生成或提交。旧任务缺少 storyboard 时，HyperFrames 可从任务内 manifest 恢复图片和配音。
- 多主机、任务优先级、延迟队列、定时栏目、租约和死信队列将在 Redis/PostgreSQL Durable Runner 阶段实现。
