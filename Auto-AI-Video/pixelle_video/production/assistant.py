"""Restricted AI producer that drafts auditable plans but never writes directly."""

from __future__ import annotations

import json
from typing import Any, Awaitable, Callable, Literal

from pydantic import BaseModel, ConfigDict, Field

from pixelle_video.rendering.subtitle_effects import SUBTITLE_EFFECTS
from pixelle_video.services.template_packs import TemplatePackRegistry
from pixelle_video.utils.scene_direction import IMAGE_MOTIONS, SCENE_TRANSITIONS
from pixelle_video.whiteboard.templates import WhiteboardTemplateRegistry

from .models import ChannelConfig
from .store import ProductionStore


class ProducerAction(BaseModel):
    model_config = ConfigDict(extra="forbid")

    action: Literal[
        "create_channel",
        "update_channel",
        "pause_channel",
        "resume_channel",
        "pin_topic",
        "approve_topic",
        "defer_topic",
        "discard_topic",
        "retry_job",
        "approve_storyboard",
        "regenerate_scene",
        "auto_repair_revision",
        "activate_revision",
        "set_channel_template",
        "set_channel_whiteboard",
        "set_channel_subtitle_effect",
        "update_scene_subtitle",
        "update_scene_direction",
    ]
    target_id: str = Field(default="", max_length=200)
    params: dict[str, Any] = Field(default_factory=dict)
    preconditions: dict[str, Any] = Field(default_factory=dict)
    rationale: str = Field(min_length=1, max_length=1000)
    impact: str = Field(min_length=1, max_length=1000)
    reversible: bool = True


class ProducerDraft(BaseModel):
    model_config = ConfigDict(extra="forbid")

    reply: str = Field(min_length=1, max_length=6000)
    observations: list[str] = Field(default_factory=list, max_length=12)
    actions: list[ProducerAction] = Field(default_factory=list, max_length=12)


async def draft_producer_response(
    message: str,
    store: ProductionStore,
    channels: list[ChannelConfig],
    timezone: str,
    llm: Callable[..., Awaitable[Any]],
    conversation: list[dict[str, Any]] | None = None,
) -> ProducerDraft:
    """Give Grok a bounded production snapshot and request a typed response."""
    snapshot = build_producer_snapshot(store, channels, timezone)
    history = (
        "\n".join(
            f"{item.get('role', 'user')}: {item.get('content', '')}"
            for item in (conversation or [])[-12:]
        )
        or "（新任务）"
    )
    prompt = f"""你是 Pixelle 短视频生产台的 AI 制片助手。你只处理生产运营，不闲聊，不虚构数据库 ID。

本任务近期对话：
{history}

用户请求：
{message.strip()}

当前生产快照：
{snapshot}

你可以观察全部快照，但写操作只能从以下白名单选择：
- create_channel：target_id 填新频道 ID；一次性提交完整频道配置，params 可包含 name、enabled、daily_target、ready_target、max_in_flight、topic_prompt、seeds、content_policy、production_mode、template_id、template_version、template_variables、whiteboard、subtitle_effect、prompt_prefix、voice_id、n_scenes、limit_scenes、watermark、visual_memory、voice_preset、image_generation_concurrency。production_mode 只能是 hyperframes、whiteboard_animation、direct_video；创建图片型频道默认使用 HyperFrames；文字/图片/视频模型路由继承设置页，不能在 create_channel 直接指定。seeds 应给出至少 3 个与频道主题直接相关的后备选题；prompt_prefix 是独立创意选择，不受频道题材语义限制；
- update_channel：target_id 必须是现有频道 ID；params 只放 enabled、inventory、topic、planning、quality、visual_memory、video 中确实要改变的字段；声音预设放入 video.voice_preset；
- pause_channel / resume_channel：target_id 必须是现有频道 ID；
- pin_topic / approve_topic / defer_topic / discard_topic：target_id 必须是快照中的候选 ID；defer_topic 可在 params.deferred_until 提供 ISO 时间；
- retry_job：target_id 必须是 status=failed 的任务 ID。
- approve_storyboard：target_id 必须是 status=awaiting_storyboard 的任务 ID；仅在用户明确要求越过失败的内容门禁时才能设 params.override_content_gate=true；
- regenerate_scene：target_id 必须是未锁定的草稿版本镜头 ID；params.scope 仅能是 full、visual、voice、composition，params.preserve_style 默认 true；
- auto_repair_revision：target_id 必须是 quality_status=fail 的当前激活版本 ID；
- activate_revision：target_id 必须是候选版本 ID，params.project_id 必须是它所属的项目 ID。
- set_channel_template：target_id 必须是现有频道 ID；params 只放 template_id、template_version、variables。模板与变量必须来自快照 legal_templates；只修改 variables 时可省略模板 ID 和版本。direct_video 频道不能设置画面模板。
- set_channel_whiteboard：target_id 必须是现有频道 ID；params 必须包含 legal_whiteboard_templates 中的 template_id 和 template_version，可选 hand_enabled、fallback_policy、render_profile。此动作会把频道切换到独立白板动画制作方式，不得同时设置 HTML 或 HyperFrames 模板。
- set_channel_subtitle_effect：target_id 必须是现有频道 ID；params.subtitle_effect 必须来自快照 legal_subtitle_effects，作为频道默认字幕效果。
- update_scene_subtitle：target_id 必须是未锁定的草稿版本镜头 ID；params 可放 subtitle_effect（合法值或 null 表示跟随当前版本默认）、subtitle_keywords（最多 12 个）、subtitle_start_offset、subtitle_end_offset。offset 单位为秒，二者之和必须小于镜头时长。
- update_scene_direction：target_id 必须是未锁定的草稿版本镜头 ID；params 可放 image_motion、transition、transition_duration，取值必须来自快照 legal_image_motions / legal_scene_transitions。首镜必须保持 transition=none。

规则：
1. 读取、解释、归纳不需要 action；直接在 reply 和 observations 回答。
2. 所有写操作只生成 actions，不得声称已经执行；reply 必须明确“等待批准”。
3. 找不到精确目标 ID 时提出澄清，不要猜测 action。
4. 不生成发布、删除、批量重做或平台操作；这些能力当前未开放。单镜重生成和质量修复会调用模型，impact 必须明确说明。
5. 创建新频道时，模板、白板、字幕、声音、种子池和画面风格全部放入同一个 create_channel，不要再对尚未创建的频道追加 set_channel_*；修改现有频道时才使用对应专用 action，不要用 update_channel 绕过字段约束。逐镜字幕和运镜操作只作用于 draft 且 unlocked 的镜头；active/archived revision 或 locked scene 必须先说明门禁，不生成 action。
6. action.rationale 解释为什么做，impact 说明会改变什么，reversible 只表示是否能人工恢复；系统不会自动回滚已执行操作。preconditions 由服务器填写，你必须保持为空对象。
7. 使用纯文本，不输出 Markdown 标题、表格或代码块。
8. 创建或检查频道时必须核对频道名称、topic.prompt、topic.seeds 和内容策略的一致性；画面风格是独立创意配置，不得仅因风格题材不同而阻断或擅自改写。
"""
    return await llm(
        prompt=prompt,
        temperature=0.2,
        max_tokens=5000,
        response_type=ProducerDraft,
    )


def build_producer_snapshot(
    store: ProductionStore,
    channels: list[ChannelConfig],
    timezone: str,
) -> str:
    templates = [
        {
            "template_id": pack.template_id,
            "version": pack.version,
            "display_name": pack.display_name,
            "native_template": pack.native_template,
            "variables": {
                name: {
                    "type": definition.type,
                    "default": definition.default,
                    **(
                        {"choices": list(definition.choices)}
                        if definition.choices
                        else {}
                    ),
                    **({"min": definition.minimum} if definition.minimum is not None else {}),
                    **({"max": definition.maximum} if definition.maximum is not None else {}),
                }
                for name, definition in pack.variables.items()
            },
        }
        for pack in TemplatePackRegistry().list()
    ]
    whiteboard_templates = [
        {
            "template_id": template.template_id,
            "version": template.version,
            "display_name": template.name,
            "description": template.description,
            "recommended_for": list(template.recommended_for),
            "render_profile": template.render_profile,
        }
        for template in WhiteboardTemplateRegistry().list()
    ]
    channel_rows = []
    for channel in channels:
        jobs = store.list_jobs(channel_id=channel.id, limit=500)
        statuses: dict[str, int] = {}
        for job in jobs:
            statuses[job["status"]] = statuses.get(job["status"], 0) + 1
        channel_rows.append(
            {
                "id": channel.id,
                "name": channel.name,
                "enabled": channel.enabled,
                "paused": store.is_channel_paused(channel.id),
                "topic": channel.topic.model_dump(),
                "inventory": channel.inventory.model_dump(),
                "planning": channel.planning.model_dump(),
                "video": {
                    "production_mode": channel.video.get("production_mode"),
                    "media_workflow": channel.video.get("media_workflow"),
                    "frame_template": channel.video.get("frame_template"),
                    "prompt_prefix": channel.video.get("prompt_prefix", ""),
                    "voice_id": channel.video.get("voice_id"),
                    "voice_preset": channel.video.get("voice_preset") or {},
                    "image_generation_concurrency": channel.video.get(
                        "image_generation_concurrency", 4
                    ),
                    "subtitle_effect": channel.video.get("subtitle_effect", "static"),
                    "limit_scenes": channel.video.get("limit_scenes", True),
                    "n_scenes": channel.video.get("n_scenes", 6),
                    "watermark": channel.video.get("watermark") or {},
                    "template_id": (channel.video.get("hyperframes") or {}).get(
                        "template_id"
                    ),
                    "template_version": (channel.video.get("hyperframes") or {}).get(
                        "template_version"
                    ),
                    "template_variables": (channel.video.get("hyperframes") or {}).get(
                        "variables", {}
                    ),
                    "whiteboard": channel.video.get("whiteboard") or {},
                },
                "visual_memory": channel.visual_memory.model_dump(),
                "job_status_counts": statuses,
            }
        )
    failures = [
        {
            "id": job["id"],
            "channel_id": job["channel_id"],
            "title": job.get("title") or job["topic"],
            "error": job.get("error"),
            "retries": job["retries"],
        }
        for job in store.list_jobs(statuses=("failed",), limit=20)
    ]
    topics = [
        {
            "id": item["id"],
            "channel_id": item["channel_id"],
            "title": item["title"],
            "status": item["status"],
            "score": item["scores"].get("overall"),
            "duplicate_of": item.get("duplicate_of"),
        }
        for item in store.list_topic_candidates(limit=40)
    ]
    sources = [
        {
            "id": item["id"],
            "channel_id": item["channel_id"],
            "name": item["name"],
            "enabled": item["enabled"],
            "state": item["state"],
            "last_error": item.get("last_error"),
        }
        for item in store.list_content_sources(limit=30)
    ]
    projects = []
    for summary in store.list_projects(limit=12):
        project = store.get_project(summary["id"])
        projects.append(
            {
                "id": project["id"],
                "job_id": project["job_id"],
                "channel_id": project["channel_id"],
                "title": project["title"],
                "current_revision_id": project["current_revision_id"],
                "revisions": [
                    {
                        "id": revision["id"],
                        "number": revision["number"],
                        "status": revision["status"],
                        "quality_status": revision["quality_status"],
                        "subtitle_effect_default": revision.get("config", {}).get(
                            "subtitle_effect", "static"
                        ),
                        "repair_status": revision.get("repair_status"),
                        "failed_checks": [
                            check["check_name"]
                            for check in revision["quality_checks"]
                            if check["status"] == "fail"
                        ],
                        "scenes": [
                            {
                                "id": scene["id"],
                                "position": scene["position"] + 1,
                                "locked": scene["locked"],
                                "regeneration_status": scene.get("regeneration_status"),
                                "duration": scene.get("duration"),
                                "image_motion": scene.get("image_motion"),
                                "transition": scene.get("transition"),
                                "transition_duration": scene.get("transition_duration"),
                                "subtitle_effect": scene.get("subtitle_effect"),
                                "subtitle_keywords": scene.get("subtitle_keywords", []),
                                "subtitle_start_offset": scene.get(
                                    "subtitle_start_offset", 0
                                ),
                                "subtitle_end_offset": scene.get("subtitle_end_offset", 0),
                            }
                            for scene in revision["scenes"]
                        ],
                    }
                    for revision in project["revisions"][:6]
                ],
            }
        )
    awaiting_storyboards = [
        {
            "id": job["id"],
            "channel_id": job["channel_id"],
            "title": job.get("title") or job["topic"],
            "storyboard_status": job.get("storyboard_status"),
            "content_gate_status": job.get("content_gate_status"),
        }
        for job in store.list_jobs(statuses=("awaiting_storyboard",), limit=20)
    ]
    return json.dumps(
        {
            "timezone": timezone,
            "legal_templates": templates,
            "legal_whiteboard_templates": whiteboard_templates,
            "legal_subtitle_effects": list(SUBTITLE_EFFECTS),
            "legal_image_motions": list(IMAGE_MOTIONS),
            "legal_scene_transitions": list(SCENE_TRANSITIONS),
            "channels": channel_rows,
            "recent_failures": failures,
            "topic_candidates": topics,
            "content_sources": sources,
            "awaiting_storyboards": awaiting_storyboards,
            "projects": projects,
        },
        ensure_ascii=False,
        sort_keys=True,
    )
