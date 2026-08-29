"""Read and operate the durable continuous-production ledger."""

import asyncio
import hashlib
import json
import re
import shutil
import threading
import time
import uuid
from contextlib import contextmanager
from pathlib import Path
from typing import Annotated, Any, Callable, Iterator, Literal

import yaml
from fastapi import APIRouter, Body, Header, HTTPException, Query, Request, status
from fastapi.responses import StreamingResponse
from loguru import logger
from pydantic import ValidationError

from api.config import api_config
from api.dependencies import get_pixelle_video
from api.routers.video import path_to_url_from_base
from api.schemas.production import (
    BatchJobDeleteRequest,
    BatchJobRequest,
    BatchParameterRequest,
    BatchReviewRequest,
    ChannelTestRequest,
    ContentSourceCreateRequest,
    ContentSourceUpdateRequest,
    CopyChannelRequest,
    CustomScriptJobRequest,
    CustomScriptRecommendation,
    CustomScriptRecommendationRequest,
    DeleteResourceRequest,
    ProducerMessageRequest,
    ProducerPlanDecisionRequest,
    PublishRequest,
    RestoreRehearsalRequest,
    ReviewRequest,
    ReviewStoryboardDirection,
    StoryboardApprovalRequest,
    StoryboardPlanningRequest,
    StoryboardUpdateRequest,
    TopicCandidateCreateRequest,
    TopicCandidateDecisionRequest,
    TopicCandidateGenerateRequest,
    TopicTitleSelectionRequest,
)
from api.tasks import Task, TaskStatus, TaskType, task_manager
from pixelle_video.config import config_manager
from pixelle_video.production import (
    ChannelConfig,
    ProducerAction,
    ProductionStore,
    audit_storyboard_content,
    build_quality_repair_plan,
    channel_semantic_gate,
    describe_custom_script_scene_count,
    draft_producer_response,
    ingest_content_source,
    inspect_storyboard_content,
    load_channel_configs,
    load_runner_config,
    plan_storyboard,
    recommend_custom_script_scene_count,
    rehearse_production_restore,
    resolve_channel_policies,
    resolve_channel_request,
    rollup_content_checks,
    score_topic,
    sync_job_project,
    validate_channel_bindings,
)
from pixelle_video.production.runner_control import production_runner_manager
from pixelle_video.production.sound import (
    apply_sound_preset,
    create_audio_preview,
    normalize_sound_preset,
    preset_preview_metadata,
)
from pixelle_video.production.topics import prepare_title_variants, propose_topics
from pixelle_video.rendering.subtitle_effects import (
    normalize_subtitle_effect,
    normalize_subtitle_keywords,
)
from pixelle_video.services.template_packs import TemplatePack, TemplatePackRegistry
from pixelle_video.utils.os_util import get_pixelle_video_root_path
from pixelle_video.utils.scene_direction import (
    IMAGE_MOTIONS,
    SCENE_TRANSITIONS,
)
from pixelle_video.utils.template_util import resolve_template_fingerprint
from pixelle_video.whiteboard.templates import WhiteboardTemplateRegistry

router = APIRouter(prefix="/production", tags=["Continuous Production"])

_channel_locks_guard = threading.Lock()
_channel_locks: dict[str, threading.RLock] = {}

_REDIRECTION_STEP_DEFINITIONS = (
    ("read_review", "读取审查建议"),
    ("prepare_scope", "定位需要修订的镜头"),
    ("director", "AI 重新导演"),
    ("merge", "合并目标镜头"),
    ("audit", "AI 事实与安全复核"),
    ("persist", "保存分镜结果"),
)
_REDIRECTION_HEARTBEAT_SECONDS = 15.0
_REDIRECTION_REQUEST_TIMEOUT_SECONDS = 75.0
_REDIRECTION_ROUTE_RETRY_COUNT = 0
_REDIRECTION_ROUTE_LIMIT = 2
_REDIRECTION_SCENES_PER_CALL = 3
_REDIRECTION_MAX_TOKENS = 5_000
_REDIRECTION_MIN_TOKENS = 1_800


def _redirection_steps(active_step: str) -> list[dict[str, str]]:
    """Build the visible step list for review-aware storyboard redirection."""
    step_ids = [step_id for step_id, _label in _REDIRECTION_STEP_DEFINITIONS]
    try:
        active_index = step_ids.index(active_step)
    except ValueError:
        active_index = 0
    return [
        {
            "id": step_id,
            "label": label,
            "status": (
                "completed"
                if index < active_index
                else "active"
                if index == active_index
                else "pending"
            ),
        }
        for index, (step_id, label) in enumerate(_REDIRECTION_STEP_DEFINITIONS)
    ]


def _redirection_output_budget(scene_count: int) -> int:
    """Keep targeted revisions compact while leaving room for full-draft fallback."""
    return min(
        _REDIRECTION_MAX_TOKENS,
        max(_REDIRECTION_MIN_TOKENS, max(scene_count, 1) * 1_400),
    )


def _redirection_batches(positions: list[int]) -> list[list[int]]:
    """Split a review into small provider-friendly model requests."""
    return [
        positions[index : index + _REDIRECTION_SCENES_PER_CALL]
        for index in range(0, len(positions), _REDIRECTION_SCENES_PER_CALL)
    ]


def _clip_prompt_text(value: Any, limit: int) -> str:
    """Bound prompt fields while retaining both context and the useful tail."""
    text = str(value or "")
    if len(text) <= limit:
        return text
    head = max(1, limit // 2)
    tail = max(1, limit - head - 24)
    return f"{text[:head]} …（中间已省略）… {text[-tail:]}"


def _compact_review_guidance(
    review_guidance: list[dict[str, Any]],
    scenes: list[dict[str, Any]],
    target_positions: set[int],
) -> list[dict[str, Any]]:
    """Keep only actionable findings relevant to the current batch."""
    target_narrations = [
        str(scenes[position].get("narration") or "")
        for position in target_positions
        if 0 <= position < len(scenes)
    ]
    compact: list[dict[str, Any]] = []
    for check in review_guidance:
        detail = check.get("detail")
        detail = detail if isinstance(detail, dict) else {}
        item: dict[str, Any] = {
            "name": check.get("name"),
            "status": check.get("status"),
        }
        for key in ("summary", "policy", "message", "recommendation", "reason"):
            value = detail.get(key)
            if value:
                item[key] = _clip_prompt_text(value, 500)

        issues = []
        for issue in detail.get("issues") or []:
            if not isinstance(issue, dict):
                continue
            scene_value = issue.get("scene")
            if scene_value is not None:
                try:
                    scene_position = int(scene_value) - 1
                except (TypeError, ValueError):
                    scene_position = None
                if scene_position not in target_positions:
                    continue
            issues.append(
                {
                    key: _clip_prompt_text(issue[key], 500)
                    for key in ("scene", "severity", "problem", "suggestion")
                    if issue.get(key) is not None
                }
            )
        if issues:
            item["issues"] = issues[:12]

        matches = [
            _clip_prompt_text(value, 300)
            for value in (detail.get("matches") or [])
            if value and any(str(value) in narration for narration in target_narrations)
        ]
        if matches:
            item["matches"] = matches[:12]

        empty_scenes = []
        for value in detail.get("empty_scenes") or []:
            try:
                if int(value) - 1 in target_positions:
                    empty_scenes.append(value)
            except (TypeError, ValueError):
                continue
        if empty_scenes:
            item["empty_scenes"] = empty_scenes

        # A broad, scene-independent finding still needs to be shown in every
        # batch so the director can add a qualification or safety instruction.
        if len(item) > 2 or not detail:
            compact.append(item)
    return compact


def _compact_redirection_scene(scene: dict[str, Any]) -> dict[str, Any]:
    """Expose only fields the compact director contract can change."""
    return {
        "position": scene["position"],
        "narration": _clip_prompt_text(scene.get("narration"), 800),
        "visual_prompt": _clip_prompt_text(scene.get("visual_prompt"), 2600),
        "image_motion": scene.get("image_motion"),
        "transition": scene.get("transition"),
        "transition_duration": scene.get("transition_duration"),
    }


def _format_elapsed(seconds: float) -> str:
    if seconds < 60:
        return f"{max(1, int(seconds))} 秒"
    return f"{seconds / 60:.1f} 分钟"


async def _await_redirection_stage(
    operation: Any,
    *,
    progress: Callable[..., None] | None,
    current: int,
    message: str,
    steps: list[dict[str, str]],
    operation_name: str,
) -> Any:
    """Await a slow model call while keeping task progress and watchdog alive."""
    if progress is None:
        return await operation

    started = time.monotonic()
    operation_task = asyncio.create_task(operation)
    logger.info("Storyboard redirection stage started: {}", operation_name)
    try:
        while not operation_task.done():
            try:
                await asyncio.wait_for(
                    asyncio.shield(operation_task),
                    timeout=_REDIRECTION_HEARTBEAT_SECONDS,
                )
            except asyncio.TimeoutError:
                elapsed = _format_elapsed(time.monotonic() - started)
                progress(
                    current,
                    100,
                    f"{message}（模型仍在处理中，已等待 {elapsed}）",
                    steps=steps,
                )
        result = await operation_task
        logger.info(
            "Storyboard redirection stage completed: {} (elapsed={:.1f}s)",
            operation_name,
            time.monotonic() - started,
        )
        return result
    except BaseException:
        if not operation_task.done():
            operation_task.cancel()
            await asyncio.gather(operation_task, return_exceptions=True)
        raise


async def execute_storyboard_planning_task(task: Task) -> dict[str, Any]:
    params = dict(task.request_params or {})
    content_policy = params.pop("content_policy", "general")
    llm_review = bool(params.pop("llm_review", True))
    core = await get_pixelle_video()

    def progress(current: int, total: int, message: str) -> None:
        task_manager.update_progress(task.task_id, current, total, message)

    return await plan_storyboard(
        params,
        core.llm,
        content_policy,
        llm_review,
        progress_callback=progress,
    )


task_manager.register_handler(
    TaskType.STORYBOARD_PLANNING,
    execute_storyboard_planning_task,
)


async def _prepare_review_redirection(
    job: dict[str, Any],
    body: StoryboardUpdateRequest,
    *,
    task_id: str | None = None,
    progress: Callable[..., None] | None = None,
) -> tuple[str, list[dict[str, Any]], str, list[dict[str, Any]], str]:
    """Run a targeted review pass and its follow-up content audit.

    Some compatible LLM endpoints only support fixed arrays in structured
    output. The prompt therefore prioritizes only scenes identified by the
    deterministic/LLM checks while retaining the full narration outline as
    continuity context. The returned
    ``changed_scene_positions`` (or the positions inferred from review issues)
    is the write boundary: scenes outside it are copied byte-for-byte from the
    user's current draft.
    """

    def report(current: int, message: str, active_step: str) -> None:
        if progress and task_id:
            progress(
                current,
                100,
                message,
                steps=_redirection_steps(active_step),
            )

    report(8, "正在读取审查建议", "read_review")
    scenes = []
    for index, scene in enumerate(body.scenes):
        payload = scene.model_dump()
        if index == 0:
            payload["transition"] = "none"
            payload["transition_duration"] = 0.0
        scenes.append({"position": index, **payload})

    policy = job["storyboard"].get("content_policy") or "general"
    review_guidance = [
        check
        for check in (job.get("content_checks") or [])
        if check.get("status") != "pass"
    ]
    target_positions = _review_target_positions(review_guidance, scenes)
    ordered_target_positions = sorted(target_positions)
    ordered_target_positions = ordered_target_positions or list(range(len(scenes)))
    target_positions = set(ordered_target_positions)
    redirection_batches = _redirection_batches(ordered_target_positions)
    target_summary = (
        ", ".join(str(position + 1) for position in ordered_target_positions)
        if ordered_target_positions
        else "由导演意见和审查建议判断"
    )
    report(
        20,
        f"已读取 {len(review_guidance)} 条审查建议，重点修订镜头：{target_summary}",
        "prepare_scope",
    )
    core = await get_pixelle_video()
    directed_scenes: list[dict[str, Any]] = []
    director_rationales: list[str] = []
    for batch_index, batch_positions in enumerate(redirection_batches, start=1):
        batch_target_positions = set(batch_positions)
        batch_scenes = [
            _compact_redirection_scene(scenes[position]) for position in batch_positions
        ]
        context_scenes = [
            {
                "position": scene["position"],
                "narration": _clip_prompt_text(scene.get("narration"), 500),
            }
            for scene in scenes
        ]
        batch_guidance = _compact_review_guidance(
            review_guidance,
            scenes,
            batch_target_positions,
        )
        prompt = (
            "你是短视频总导演和内容审校员。只修订当前批次列出的镜头，绝不重写整稿或增删镜头。"
            "必须逐条吸收与当前批次相关的审查建议，保留原稿事实边界，不凭空新增事实。"
            "每个返回的 scenes 项必须带原始的 position（从 0 开始），并完整返回该镜头的 narration 和 visual_prompt。"
            "只返回真正需要修改的镜头；未列出的镜头由系统原样保留。视觉提示词必须与对应旁白一致。"
            f"\n允许的 image_motion：{sorted(IMAGE_MOTIONS)}"
            f"\n允许的 transition：{sorted(SCENE_TRANSITIONS)}"
            f"\n内容策略：{policy}"
            f"\n用户补充导演意见：{_clip_prompt_text(body.director_note or '无', 800)}"
            f"\n当前标题：{_clip_prompt_text(body.title, 300)}"
            f"\n全稿旁白上下文：{json.dumps(context_scenes, ensure_ascii=False)}"
            f"\n当前批次镜头：{json.dumps(batch_scenes, ensure_ascii=False)}"
            f"\n本批相关审查建议：{json.dumps(batch_guidance, ensure_ascii=False)}"
        )
        current = 35 + round(20 * (batch_index - 1) / max(len(redirection_batches), 1))
        report(
            current,
            f"正在使用文字模型重新导演（第 {batch_index}/{len(redirection_batches)} 批，处理 {len(batch_positions)} 个镜头）",
            "director",
        )
        directed = await _await_redirection_stage(
            core.llm(
                prompt=prompt,
                temperature=0.2,
                max_tokens=_redirection_output_budget(len(batch_positions)),
                response_type=ReviewStoryboardDirection,
                # Compact structured editing does not need the route's default
                # high reasoning budget; keeping it off avoids multi-minute stalls.
                reasoning_effort="none",
                _request_timeout=_REDIRECTION_REQUEST_TIMEOUT_SECONDS,
                _route_retry_count=_REDIRECTION_ROUTE_RETRY_COUNT,
                _route_limit=_REDIRECTION_ROUTE_LIMIT,
                _empty_response_retries=0,
                _disable_provider_reasoning=True,
            ),
            progress=progress if task_id else None,
            current=current,
            message=f"正在使用文字模型重新导演（第 {batch_index}/{len(redirection_batches)} 批）",
            steps=_redirection_steps("director"),
            operation_name=f"AI 重新导演 {batch_index}/{len(redirection_batches)}",
        )
        director_rationales.append(directed.rationale)
        for offset, scene in enumerate(directed.scenes):
            payload = scene.model_dump(exclude_unset=True)
            position = payload.get("position")
            if position not in batch_target_positions:
                # Be tolerant of providers that omit or alter the position while
                # still returning the expected number of patches.
                position = batch_positions[min(offset, len(batch_positions) - 1)]
            payload["position"] = position
            directed_scenes.append(payload)

    next_title = body.title
    director_rationale = "；".join(
        rationale for rationale in director_rationales if rationale
    )[:2000]
    report(
        58,
        f"重新导演完成，正在合并 {len(target_positions)} 个目标镜头",
        "merge",
    )
    merged_scenes = _merge_review_scenes(scenes, directed_scenes, target_positions)
    report(70, "正在执行新一轮内容审查", "audit")
    checks = await _await_redirection_stage(
        audit_storyboard_content(
            core.llm,
            next_title,
            merged_scenes,
            policy,
            llm_options={
                "_request_timeout": _REDIRECTION_REQUEST_TIMEOUT_SECONDS,
                "_route_retry_count": _REDIRECTION_ROUTE_RETRY_COUNT,
                "_route_limit": _REDIRECTION_ROUTE_LIMIT,
                "_empty_response_retries": 0,
                "_disable_provider_reasoning": True,
            },
        ),
        progress=progress if task_id else None,
        current=70,
        message="正在执行新一轮内容审查",
        steps=_redirection_steps("audit"),
        operation_name="AI 事实与安全复核",
    )
    gate = rollup_content_checks(checks)
    return next_title, merged_scenes, director_rationale, checks, gate


def _review_target_positions(
    review_guidance: list[dict[str, Any]], scenes: list[dict[str, Any]]
) -> set[int]:
    """Resolve review findings to zero-based scene positions.

    LLM audits use human-friendly one-based positions. Deterministic checks
    generally expose matching text instead, so those matches are mapped back
    to the smallest possible set of scenes. Broad advice is applied to the
    final scene, where a short qualification or action is normally appropriate.
    """
    positions: set[int] = set()
    scene_count = len(scenes)

    def add_position(value: Any) -> None:
        try:
            number = int(value)
        except (TypeError, ValueError):
            return
        if 1 <= number <= scene_count:
            positions.add(number - 1)
        elif 0 <= number < scene_count:
            positions.add(number)

    for check in review_guidance:
        if check.get("status") == "pass":
            continue
        detail = check.get("detail")
        if not isinstance(detail, dict):
            continue
        for issue in detail.get("issues") or []:
            if isinstance(issue, dict):
                add_position(issue.get("scene"))
        for value in detail.get("empty_scenes") or []:
            add_position(value)

        matches = [str(value) for value in (detail.get("matches") or []) if value]
        if matches:
            for index, scene in enumerate(scenes):
                narration = str(scene.get("narration") or "")
                if any(match in narration for match in matches):
                    positions.add(index)

        if check.get("name") in {
            "content_actionable_advice",
            "content_fact_boundaries",
            "content_llm_review",
        }:
            if scene_count:
                positions.add(scene_count - 1)

    return positions


def _merge_review_scenes(
    original_scenes: list[dict[str, Any]],
    directed_scenes: list[dict[str, Any]],
    target_positions: set[int],
) -> list[dict[str, Any]]:
    """Apply only targeted director edits and preserve every other scene."""
    directed_by_position: dict[int, dict[str, Any]] = {}
    for index, scene in enumerate(directed_scenes):
        try:
            position = int(scene.get("position", index))
        except (TypeError, ValueError):
            position = index
        directed_by_position[position] = scene
    # Some providers follow the instruction to return only changed scenes even
    # though the compatibility schema describes a list. When the list length
    # matches the target set, map those drafts to the sorted target positions.
    if (
        len(directed_scenes) != len(original_scenes)
        and len(directed_scenes) == len(target_positions)
        and not set(directed_by_position).intersection(target_positions)
    ):
        directed_by_position = {
            position: directed_scenes[offset]
            for offset, position in enumerate(sorted(target_positions))
        }
    merged_scenes = []
    for index, original in enumerate(original_scenes):
        merged = dict(original)
        if index in target_positions and index in directed_by_position:
            merged.update(
                {
                    key: value
                    for key, value in directed_by_position[index].items()
                    if key != "position" and value is not None
                }
            )
        merged["position"] = index
        if index == 0:
            merged["transition"] = "none"
            merged["transition_duration"] = 0.0
        merged_scenes.append(merged)
    return merged_scenes


async def execute_storyboard_redirection_task(task: Task) -> dict[str, Any]:
    """Persist a recovered review-aware storyboard redirection to its production job."""
    params = dict(task.request_params or {})
    body = StoryboardUpdateRequest.model_validate(params["update"])

    def progress(
        current: int,
        total: int,
        message: str,
        *,
        steps: list[dict[str, str]] | None = None,
    ) -> None:
        task_manager.update_progress(
            task.task_id,
            current,
            total,
            message,
            steps=steps,
        )

    with ProductionStore(str(params["database_path"])) as store:
        job = store.get_job(params["job_id"])
        if job["status"] != "awaiting_storyboard" or not job.get("storyboard"):
            raise ValueError("Storyboard is not editable")
        if job.get("storyboard_task_id") not in {None, task.task_id}:
            raise ValueError("A newer storyboard task is current")

    # Keep the SQLite connection closed while waiting for external model calls.
    # The job is re-read and ownership-checked before the final write below.
    title, scenes, rationale, checks, gate = await _prepare_review_redirection(
        job,
        body,
        task_id=task.task_id,
        progress=progress,
    )
    progress(
        90,
        100,
        "内容复核完成，正在写入分镜与审查结果",
        steps=_redirection_steps("persist"),
    )
    # Do not hold a SQLite connection open while waiting for external model
    # calls. Re-read the job after the calls so concurrent edits are rejected
    # before the new storyboard is committed.
    with ProductionStore(str(params["database_path"])) as store:
        current = store.get_job(params["job_id"])
        if (
            current["status"] != "awaiting_storyboard"
            or current.get("storyboard_task_id") != task.task_id
        ):
            raise ValueError("Storyboard was changed while redirection was running")
        plan = {
            **current["storyboard"],
            "title": title,
            "scenes": scenes,
            "director_rationale": rationale or None,
            "director_note": body.director_note or None,
        }
        updated = store.update_job(
            params["job_id"],
            title=title,
            storyboard_json=plan,
            content_checks_json=checks,
            content_gate_status=gate,
            storyboard_status="review_pending",
        )
        return {
            "job_id": updated["id"],
            "storyboard": updated.get("storyboard"),
            "content_checks": checks,
            "content_gate_status": gate,
        }


task_manager.register_handler(
    TaskType.STORYBOARD_REDIRECTION,
    execute_storyboard_redirection_task,
)


async def execute_source_ingestion_task(task: Task) -> dict[str, Any]:
    source_id = str((task.request_params or {}).get("source_id") or "")
    if not source_id:
        raise ValueError("Source ingestion task is missing source_id")
    core = await get_pixelle_video()
    with _store() as store:
        source = store.get_content_source(source_id)
        channel = _get_channel(source["channel_id"])
        return await ingest_content_source(source_id, task.task_id, store, channel, core.llm)


task_manager.register_handler(
    TaskType.SOURCE_INGESTION,
    execute_source_ingestion_task,
)


async def execute_custom_script_recommendation_task(task: Task) -> dict[str, Any]:
    """Build one durable, restart-safe custom-copy run of show."""
    body = CustomScriptRecommendationRequest.model_validate(task.request_params or {})
    task_manager.update_progress(task.task_id, 1, 3, "正在读取频道制作配置")
    channel = _get_channel(body.channel_id)
    core = await get_pixelle_video()
    rewrite_instruction = (
        "在不改变事实、立场和关键信息的前提下重写并优化文案，去掉重复和生硬表达。"
        if body.rewrite_enabled
        else "文案必须逐字保持原样，只做制作方案推荐，不得改写 script 字段。"
    )
    review_instruction = (
        "同时自动审查改写结果；review_status 只能是 pass 或 warn，并给出审查摘要。"
        if body.review_mode == "ai_auto"
        else "review_status 返回 manual_pending，提醒用户人工审查文案。"
    )
    initial_scene_count = recommend_custom_script_scene_count(body.script)
    prompt = (
        "你是短视频制片主任。根据用户文案生成一份可以人工调整的制作任务单。"
        "制作方式含：direct_video 适合必须连续运动的画面；hyperframes 适合电台、科普、稳定批量生产和动态图形排版；"
        "whiteboard_animation 适合知识讲解与手绘演示。"
        f"\n频道：{channel.name}\n频道当前配置：{json.dumps(channel.video, ensure_ascii=False)}"
        "\n配置约束：频道 visual_memory、水印、声音/voice_preset、limit_scenes、"
        "制作方式、模板和模型路由是生产基线；推荐值不能否定它们。"
        "n_scenes 仅作为本次文案规模预览，不作为正式分镜上限；"
        "正式创建时仍由分镜规划按语义和口播节奏自主拆镜。"
        f"\n要求：{rewrite_instruction}{review_instruction}"
        f"\n当前文案按自然语义边界预估约 {initial_scene_count} 镜。"
        "这里只是制作规模预览，不是数量限制；正式规划必须按文案语义、口播节奏和画面信息密度自主拆镜，"
        "不得照搬频道分镜数，也不得为了凑数量把剩余文案堆积到最后一镜。"
        "请合理给出标题、内容策略、字幕效果、默认运镜、转场和选择理由。"
        f"\n用户标题：{body.title or '未填写'}\n用户文案：\n{body.script}"
    )
    task_manager.update_progress(task.task_id, 2, 3, "AI 正在生成制作方案")
    try:
        recommendation = await core.llm(
            prompt=prompt,
            temperature=0.2,
            max_tokens=6000,
            response_type=CustomScriptRecommendation,
        )
    except Exception as exc:
        raise ValueError(f"AI 制作方案生成失败：{exc}") from exc
    updates: dict[str, Any] = {}
    if not body.rewrite_enabled:
        updates["script"] = body.script
    if body.title:
        updates["title"] = body.title
    if body.review_mode == "manual":
        updates.update(
            review_status="manual_pending",
            review_summary="等待你确认文案与制作参数后再进入分镜规划。",
        )
    final_script = str(updates.get("script") or recommendation.script)
    final_scene_count = recommend_custom_script_scene_count(final_script)
    updates.update(
        original_script=body.script if body.rewrite_enabled else None,
        n_scenes=final_scene_count,
        scene_strategy="content_auto",
        scene_count_basis=describe_custom_script_scene_count(
            final_script, final_scene_count
        ),
    )
    task_manager.update_progress(task.task_id, 3, 3, "制作方案已就绪")
    recommendation = recommendation.model_copy(update=updates)
    return {"recommendation": recommendation.model_dump()}


task_manager.register_handler(
    TaskType.CUSTOM_SCRIPT_RECOMMENDATION,
    execute_custom_script_recommendation_task,
)


_config_cache_guard = threading.Lock()
_config_cache: dict[str, Any] = {
    "fingerprint": None,
    "config_path": None,
    "channels_dir": None,
    "config": None,
}


def _config():
    """Load runner config with mtime-based caching (still hot-reloads on change).

    Each request previously re-parsed every channel YAML (~0.6s); with a 1000-job
    dashboard this dominated response time. The mtime of the config plus the
    newest channel/source YAML is enough to detect changes without re-reading.
    """
    config_path = Path(api_config.production_config_path).expanduser().resolve()
    with _config_cache_guard:
        cached_channels_dir = (
            _config_cache["channels_dir"]
            if _config_cache["config_path"] == config_path
            else None
        )
        try:
            fingerprint = _config_fingerprint(config_path, cached_channels_dir)
        except OSError:
            fingerprint = None
        if _config_cache["fingerprint"] == fingerprint and fingerprint is not None:
            return _config_cache["config"]
        try:
            config = load_runner_config(config_path)
        except (FileNotFoundError, ValueError) as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from exc
        channels_dir = Path(config.channels_dir).resolve()
        try:
            fingerprint = _config_fingerprint(config_path, channels_dir)
        except OSError:
            fingerprint = None
        _config_cache["fingerprint"] = fingerprint
        _config_cache["config_path"] = config_path
        _config_cache["channels_dir"] = channels_dir
        _config_cache["config"] = config
        return config


def _config_fingerprint(config_path: Path, channels_dir: Path | None = None) -> str:
    """Return a compact fingerprint of the config + channel YAML mtimes."""
    config_stat = config_path.stat()
    parts: list[str] = [
        str(config_path),
        str(config_stat.st_mtime_ns),
        str(config_stat.st_size),
    ]
    channels_dir = channels_dir or config_path.parent / "channels"
    if channels_dir.is_dir():
        for channel_path in sorted(channels_dir.glob("*.y*ml")):
            channel_stat = channel_path.stat()
            parts.append(
                f"{channel_path.name}:{channel_stat.st_mtime_ns}:{channel_stat.st_size}"
            )
    return "|".join(parts)


@contextmanager
def _store() -> Iterator[ProductionStore]:
    store = ProductionStore(_config().database_path)
    try:
        yield store
    finally:
        store.close()


@router.get("/status")
def production_status():
    """Return inventory counters and non-secret channel configuration."""
    config = _config()
    with _store() as store:
        channels = []
        for channel in config.channels:
            snapshot = store.snapshot(channel.id, _today(config.timezone))
            channels.append(
                {
                    **snapshot,
                    "id": channel.id,
                    "name": channel.name,
                    "enabled": channel.enabled,
                    "topic": channel.topic.model_dump(),
                    "inventory": channel.inventory.model_dump(),
                    "planning": channel.planning.model_dump(),
                    "quality": channel.quality.model_dump(),
                    "visual_memory": channel.visual_memory.model_dump(),
                    "video": channel.video,
                }
            )
    return {
        "database": config.database_path,
        "timezone": config.timezone,
        "poll_interval_seconds": config.poll_interval_seconds,
        "runner": production_runner_manager.status(),
        "channels": channels,
    }


@router.post("/runner/start")
async def start_production_runner():
    """Enable and start the API-owned continuous production runner."""
    return await production_runner_manager.start()


@router.post("/runner/stop")
async def stop_production_runner():
    """Disable the continuous runner after its current reconciliation exits."""
    return await production_runner_manager.stop()


@router.get("/summary")
def production_summary():
    """Alias for the dashboard summary contract."""
    return production_status()


@router.get("/jobs")
def list_production_jobs(
    request: Request,
    channel_id: str | None = None,
    status: Literal[
        "planned",
        "planning",
        "awaiting_storyboard",
        "submitting",
        "pending",
        "running",
        "ready",
        "failed",
        "published",
        "cancelled",
    ]
    | None = None,
    limit: Annotated[int, Query(ge=1, le=1000)] = 100,
):
    """List newest production jobs with requests, results, and errors."""
    statuses = (status,) if status else None
    channel_names = {channel.id: channel.name for channel in _config().channels}
    with _store() as store:
        try:
            jobs = store.list_jobs(channel_id=channel_id, statuses=statuses, limit=limit)
            timelines = store.get_job_timelines(job["id"] for job in jobs)
            for job in jobs:
                job["timeline"] = timelines.get(job["id"], [])
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
    enriched = [
        {
            **_decorate_job_video(_with_task_progress(job), request),
            "channel_name": channel_names.get(job["channel_id"], job["channel_id"]),
        }
        for job in jobs
    ]
    return {"jobs": enriched, "count": len(enriched)}


@router.get("/channels")
def list_channels():
    """Return editable, validated channel configuration without secrets."""
    return {"channels": [channel.model_dump() for channel in _config().channels]}


@router.get("/sources")
def list_content_sources(
    channel_id: str | None = None,
    limit: Annotated[int, Query(ge=1, le=1000)] = 200,
):
    with _store() as store:
        items = store.list_content_sources(channel_id, limit)
    return {"sources": items, "count": len(items)}


@router.post("/sources", status_code=status.HTTP_201_CREATED)
def create_content_source(body: ContentSourceCreateRequest):
    _get_channel(body.channel_id)
    return _create_content_source(body)


def _create_content_source(body: ContentSourceCreateRequest) -> dict[str, Any]:
    with _store() as store:
        return store.create_content_source(
            body.channel_id,
            body.name,
            body.kind,
            str(body.url),
            body.poll_interval_minutes,
            body.items_per_poll,
            body.candidates_per_item,
            body.enabled,
        )


@router.patch("/sources/{source_id}")
def update_content_source(source_id: str, body: ContentSourceUpdateRequest):
    updates = body.model_dump(exclude_unset=True)
    if updates.get("channel_id"):
        _get_channel(str(updates["channel_id"]))
    if updates.get("url") is not None:
        updates["url"] = str(updates["url"])
    with _store() as store:
        try:
            return store.update_content_source(source_id, updates)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="Content source not found") from exc
        except ValueError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc


@router.post("/sources/{source_id}/poll", status_code=status.HTTP_202_ACCEPTED)
async def poll_content_source(source_id: str):
    """Queue one manual collection and return before network/LLM work begins."""
    try:
        task = await _queue_source_poll(source_id, force=True)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="Content source not found") from exc
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return {"task_id": task.task_id, "status": task.status.value}


@router.post("/sources/poll-due", status_code=status.HTTP_202_ACCEPTED)
async def poll_due_content_sources(
    limit: Annotated[int, Query(ge=1, le=50)] = 5,
):
    """Reserve and queue due sources; intended for the continuous Runner."""
    with _store() as store:
        due = store.due_content_sources(limit)
    tasks = []
    for source in due:
        try:
            task = await _queue_source_poll(source["id"], force=False)
        except (KeyError, ValueError, HTTPException):
            continue
        tasks.append({"source_id": source["id"], "task_id": task.task_id})
    return {"tasks": tasks, "count": len(tasks)}


async def _queue_source_poll(source_id: str, force: bool) -> Task:
    with _store() as store:
        source = store.get_content_source(source_id)
        if source["state"] in {"queued", "polling"}:
            raise HTTPException(status_code=409, detail="Content source is already collecting")
        key = (
            None
            if force
            else f"production:source:{source_id}:{source.get('next_poll_at') or source['created_at']}"
        )
        task = task_manager.create_task(
            TaskType.SOURCE_INGESTION,
            request_params={"source_id": source_id},
            idempotency_key=key,
        )
        try:
            store.queue_content_source(source_id, task.task_id, force=force)
        except Exception:
            task_manager.cancel_task(task.task_id)
            raise
    await task_manager.execute_task(task.task_id)
    return task


@router.get("/assistant/threads")
def list_producer_threads(
    limit: Annotated[int, Query(ge=1, le=100)] = 30,
):
    with _store() as store:
        threads = store.list_assistant_threads(limit)
    return {"threads": threads, "count": len(threads)}


@router.get("/assistant/threads/{thread_id}")
def get_producer_thread(thread_id: str):
    with _store() as store:
        try:
            return store.get_assistant_thread(thread_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="Producer thread not found") from exc


@router.post("/assistant/messages", status_code=status.HTTP_201_CREATED)
async def create_producer_message(body: ProducerMessageRequest):
    """Ask the producer for observations or an approval-gated write plan."""
    config = _config()
    core = await get_pixelle_video()
    with _store() as store:
        if body.thread_id:
            try:
                thread = store.get_assistant_thread(body.thread_id)
            except KeyError as exc:
                raise HTTPException(status_code=404, detail="Producer thread not found") from exc
        else:
            thread = store.create_assistant_thread(body.message[:80])
        conversation = list(thread.get("messages") or [])
        user_message = store.append_assistant_message(thread["id"], "user", body.message)
        try:
            draft = await draft_producer_response(
                body.message,
                store,
                config.channels,
                config.timezone,
                core.llm,
                conversation,
            )
        except Exception as exc:
            raise HTTPException(status_code=502, detail=f"Producer model failed: {exc}") from exc

        atomic_actions = _coalesce_new_channel_actions(draft.actions)
        accepted, rejected = _validate_producer_actions(
            atomic_actions, store, config.channels
        )
        observations = [*draft.observations]
        if rejected:
            observations.append(f"安全策略拦截 {len(rejected)} 个无效操作：{'；'.join(rejected)}")
        plan = None
        if accepted:
            prepared_actions = [
                _attach_producer_preconditions(action, store) for action in accepted
            ]
            plan = store.create_assistant_plan(
                thread["id"],
                user_message["id"],
                draft.reply,
                [action.model_dump() for action in prepared_actions],
            )
        assistant_message = store.append_assistant_message(
            thread["id"],
            "assistant",
            draft.reply,
            {
                "observations": observations,
                "plan_id": plan["id"] if plan else None,
                "rejected_actions": rejected,
            },
        )
    return {
        "thread_id": thread["id"],
        "message": assistant_message,
        "observations": observations,
        "plan": plan,
    }


@router.post("/assistant/plans/{plan_id}/decision")
async def decide_producer_plan(plan_id: str, body: ProducerPlanDecisionRequest):
    """Reject or explicitly approve a previously persisted producer plan."""
    config = _config()
    with _store() as store:
        try:
            plan = store.get_assistant_plan(plan_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="Producer plan not found") from exc
        if plan["status"] != "pending":
            raise HTTPException(status_code=409, detail="Producer plan is no longer pending")
        if not body.approved:
            try:
                rejected = store.update_assistant_plan(
                    plan_id,
                    "rejected",
                    {"note": body.note or "User rejected the plan"},
                    expected_status="pending",
                )
            except ValueError as exc:
                raise HTTPException(
                    status_code=409, detail="Producer plan is no longer pending"
                ) from exc
            store.append_assistant_message(
                plan["thread_id"],
                "system",
                body.note or "计划已拒绝，未执行任何操作。",
                {"plan_id": plan_id, "status": "rejected"},
            )
            return rejected

        actions = [ProducerAction.model_validate(item) for item in plan["actions"]]
        accepted, rejected_reasons = _validate_producer_actions(actions, store, config.channels)
        if rejected_reasons or len(accepted) != len(actions):
            try:
                failed = store.update_assistant_plan(
                    plan_id,
                    "failed",
                    error=f"Plan preflight failed: {'; '.join(rejected_reasons)}",
                    expected_status="pending",
                )
            except ValueError as exc:
                raise HTTPException(
                    status_code=409, detail="Producer plan is no longer pending"
                ) from exc
            return failed

        try:
            store.update_assistant_plan(plan_id, "executing", expected_status="pending")
        except ValueError as exc:
            raise HTTPException(
                status_code=409, detail="Producer plan is no longer pending"
            ) from exc
        results: list[dict[str, Any]] = []
        scene_versions: dict[str, str] = {}
        try:
            for action in accepted:
                execution_action = action
                if action.target_id in scene_versions and action.action in {
                    "update_scene_subtitle",
                    "update_scene_direction",
                }:
                    execution_action = action.model_copy(
                        update={
                            "preconditions": {
                                **action.preconditions,
                                "scene_updated_at": scene_versions[action.target_id],
                            }
                        }
                    )
                result = await _execute_producer_action(execution_action, store, config)
                if (
                    action.action in {"update_scene_subtitle", "update_scene_direction"}
                    and isinstance(result, dict)
                    and isinstance(result.get("updated_at"), str)
                ):
                    scene_versions[action.target_id] = result["updated_at"]
                results.append(
                    {"action": action.action, "target_id": action.target_id, "result": result}
                )
            completed = store.update_assistant_plan(
                plan_id, "completed", {"actions": results, "approval_note": body.note}
            )
            store.append_assistant_message(
                plan["thread_id"],
                "system",
                f"计划已执行，共完成 {len(results)} 个操作。",
                {"plan_id": plan_id, "status": "completed", "results": results},
            )
            return completed
        except Exception as exc:
            partial_error = (
                f"Plan stopped after {len(results)} action(s) were applied without automatic "
                f"rollback: {exc}"
                if results
                else str(exc)
            )
            failed = store.update_assistant_plan(
                plan_id,
                "failed",
                {"actions": results},
                partial_error,
            )
            store.append_assistant_message(
                plan["thread_id"],
                "system",
                (
                    f"计划执行中止，已有 {len(results)} 个操作成功且不会自动回滚：{exc}"
                    if results
                    else f"计划执行中止，尚未执行任何操作：{exc}"
                ),
                {"plan_id": plan_id, "status": "failed", "results": results},
            )
            return failed


@router.get("/deletions/{resource}/{target_id}")
def preview_production_deletion(resource: str, target_id: str):
    """Return the exact impact and blockers before showing a delete confirmation."""
    config = _config()
    with _store() as store:
        return _deletion_preview(resource, target_id, store, config)


@router.delete("/deletions/{resource}/{target_id}")
def delete_production_resource(
    resource: str,
    target_id: str,
    body: DeleteResourceRequest,
):
    """Permanently delete one explicitly confirmed resource and its owned files."""
    if body.confirm_id != target_id:
        raise HTTPException(status_code=422, detail="Confirmation id does not match target")
    config = _config()
    with _store() as store:
        preview = _deletion_preview(resource, target_id, store, config)
        if not preview["allowed"]:
            raise HTTPException(status_code=409, detail=preview["blocked_reason"])
        try:
            result = _delete_resource(resource, target_id, store, config)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="Delete target not found") from exc
        except ValueError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc

        task_ids = list(result.get("task_ids") or [])
        removed_tasks = []
        for task_id in task_ids:
            try:
                if task_manager.remove_task(task_id):
                    removed_tasks.append(task_id)
            except ValueError as exc:
                raise HTTPException(status_code=409, detail=str(exc)) from exc

        deletion = _delete_managed_paths(
            list(result.get("paths") or []),
            task_ids,
            config,
            resource,
            target_id,
            delete_task_directories=resource == "job",
        )
        if resource == "channel" and result.get("channel_path"):
            channel_deletion = _delete_managed_paths(
                [result["channel_path"]],
                [],
                config,
                resource,
                target_id,
            )
            deletion = _merge_deletion_results(deletion, channel_deletion)
        return {
            "deleted": True,
            "resource": resource,
            "id": target_id,
            "counts": result.get("counts") or preview["counts"],
            "removed_task_ids": removed_tasks,
            "file_deletion": deletion,
        }


def _validate_producer_actions(
    actions: list[ProducerAction],
    store: ProductionStore,
    channels: list[ChannelConfig],
) -> tuple[list[ProducerAction], list[str]]:
    channel_ids = {channel.id for channel in channels}
    channel_by_id = {channel.id: channel for channel in channels}
    planned_channel_ids: set[str] = set()
    accepted: list[ProducerAction] = []
    rejected: list[str] = []
    for action in actions:
        try:
            if action.action == "create_channel":
                if not re.fullmatch(r"[a-z0-9][a-z0-9_-]{1,63}", action.target_id):
                    raise ValueError("new channel id has an invalid format")
                if action.target_id in channel_ids or action.target_id in planned_channel_ids:
                    raise ValueError("new channel id is empty or already exists")
                template_id = str(action.params.get("template_channel_id") or "")
                if template_id and template_id not in channel_ids:
                    raise ValueError("template channel does not exist")
                _validate_create_channel_params(action)
                planned_channel_ids.add(action.target_id)
            elif action.action in {
                "update_channel",
                "pause_channel",
                "resume_channel",
            }:
                if action.target_id not in channel_ids:
                    raise ValueError("channel does not exist")
                if action.action == "update_channel":
                    video = action.params.get("video")
                    if isinstance(video, dict) and {
                        "frame_template",
                        "template_params",
                        "hyperframes",
                        "subtitle_effect",
                        "whiteboard",
                    } & set(video):
                        raise ValueError(
                            "template and subtitle settings require dedicated producer actions"
                        )
            elif action.action == "set_channel_template":
                if action.target_id not in channel_ids:
                    raise ValueError("channel does not exist")
                _resolve_channel_template_action(action, channel_by_id[action.target_id])
            elif action.action == "set_channel_whiteboard":
                if action.target_id not in channel_ids:
                    raise ValueError("channel does not exist")
                _resolve_channel_whiteboard_action(action)
            elif action.action == "set_channel_subtitle_effect":
                if action.target_id not in channel_ids:
                    raise ValueError("channel does not exist")
                _validate_exact_params(action, {"subtitle_effect"})
                if set(action.params) != {"subtitle_effect"}:
                    raise ValueError("subtitle_effect is required")
                if not isinstance(action.params["subtitle_effect"], str) or not action.params[
                    "subtitle_effect"
                ].strip():
                    raise ValueError("subtitle_effect must be a non-empty string")
                normalize_subtitle_effect(action.params["subtitle_effect"])
            elif action.action in {
                "pin_topic",
                "approve_topic",
                "defer_topic",
                "discard_topic",
            }:
                topic = store.get_topic_candidate(action.target_id)
                if topic["status"] == "consumed":
                    raise ValueError("topic is already consumed")
            elif action.action == "retry_job":
                job = store.get_job(action.target_id)
                if job["status"] != "failed":
                    raise ValueError("job is not failed")
            elif action.action == "approve_storyboard":
                job = store.get_job(action.target_id)
                if job["status"] != "awaiting_storyboard" or not job.get("storyboard"):
                    raise ValueError("storyboard is not awaiting approval")
                override = action.params.get("override_content_gate", False)
                if not isinstance(override, bool):
                    raise ValueError("override_content_gate must be boolean")
                if job.get("content_gate_status") == "fail" and not override:
                    raise ValueError("content gate failed and override was not requested")
            elif action.action == "regenerate_scene":
                context = store.get_scene_context(action.target_id)
                scene = context["scene"]
                revision = context["revision"]
                scope = action.params.get("scope", "full")
                if scope not in {"full", "visual", "voice", "composition"}:
                    raise ValueError("unsupported regeneration scope")
                if not isinstance(action.params.get("preserve_style", True), bool):
                    raise ValueError("preserve_style must be boolean")
                if revision["status"] != "draft":
                    raise ValueError("scene revision is not a draft")
                if scene["locked"]:
                    raise ValueError("scene is locked")
                if any(
                    item.get("regeneration_status") in {"pending", "running"}
                    for item in revision["scenes"]
                ):
                    raise ValueError("revision already has regeneration in progress")
            elif action.action == "update_scene_subtitle":
                context = _editable_scene_context(store, action.target_id)
                _require_scene_precondition(action, context["scene"])
                _normalized_scene_subtitle_updates(action, context["scene"])
            elif action.action == "update_scene_direction":
                context = _editable_scene_context(store, action.target_id)
                _require_scene_precondition(action, context["scene"])
                _normalized_scene_direction_updates(action, context["scene"])
            elif action.action == "auto_repair_revision":
                revision = store.get_revision(action.target_id)
                if revision["status"] != "active" or revision["quality_status"] != "fail":
                    raise ValueError("revision is not an active failed-quality revision")
                if not build_quality_repair_plan(revision)["steps"]:
                    raise ValueError("revision has no automatically repairable checks")
            elif action.action == "activate_revision":
                project_id = action.params.get("project_id")
                if not isinstance(project_id, str) or not project_id:
                    raise ValueError("project_id is required")
                revision = store.get_revision(action.target_id)
                if revision["project_id"] != project_id:
                    raise ValueError("revision does not belong to project")
                project = store.get_project(project_id)
                if project["current_revision_id"] == revision["id"]:
                    raise ValueError("revision is already active")
            accepted.append(action)
        except (KeyError, ValueError) as exc:
            rejected.append(f"{action.action}({action.target_id}): {exc}")
    return accepted, rejected


def _coalesce_new_channel_actions(
    actions: list[ProducerAction],
) -> list[ProducerAction]:
    """Fold setters for a not-yet-created channel into one auditable write.

    Models naturally describe channel creation as several sequential operations.
    Those setters cannot pass preflight before the channel exists and previously
    left users with a partially configured channel.  Collapsing them before the
    approval gate makes the write atomic and keeps one coherent audit record.
    """

    create_targets = {
        action.target_id for action in actions if action.action == "create_channel"
    }
    if not create_targets:
        return actions
    creates: dict[str, ProducerAction] = {}
    output: list[ProducerAction] = []
    absorbed: dict[str, list[str]] = {target: [] for target in create_targets}
    for action in actions:
        if action.action == "create_channel":
            creates[action.target_id] = action
            output.append(action)
            continue
        if action.target_id not in create_targets or action.action not in {
            "set_channel_template",
            "set_channel_whiteboard",
            "set_channel_subtitle_effect",
        }:
            output.append(action)
            continue
        create = creates.get(action.target_id)
        if create is None:
            # Keep unusual out-of-order plans explicit so normal validation can
            # reject them instead of silently changing execution order.
            output.append(action)
            continue
        params = dict(create.params)
        if action.action == "set_channel_template":
            params["production_mode"] = "hyperframes"
            for source, target in (
                ("template_id", "template_id"),
                ("template_version", "template_version"),
                ("variables", "template_variables"),
            ):
                if source in action.params:
                    params[target] = action.params[source]
        elif action.action == "set_channel_whiteboard":
            params["production_mode"] = "whiteboard_animation"
            params["whiteboard"] = dict(action.params)
        else:
            params["subtitle_effect"] = action.params.get("subtitle_effect")
        absorbed[action.target_id].append(action.action)
        replacement = create.model_copy(update={"params": params})
        creates[action.target_id] = replacement
        output[output.index(create)] = replacement
    return [
        action.model_copy(
            update={
                "impact": (
                    f"{action.impact}；原子合并：{', '.join(absorbed[action.target_id])}"
                )[:1000]
            }
        )
        if action.action == "create_channel" and absorbed[action.target_id]
        else action
        for action in output
    ]


def _validate_create_channel_params(action: ProducerAction) -> None:
    allowed = {
        "name",
        "template_channel_id",
        "enabled",
        "daily_target",
        "ready_target",
        "max_in_flight",
        "topic_prompt",
        "seeds",
        "content_policy",
        "production_mode",
        "template_id",
        "template_version",
        "template_variables",
        "whiteboard",
        "subtitle_effect",
        "prompt_prefix",
        "voice_id",
        "n_scenes",
        "limit_scenes",
        "watermark",
        "visual_memory",
        "voice_preset",
        "image_generation_concurrency",
    }
    _validate_exact_params(action, allowed)
    mode = str(action.params.get("production_mode") or "hyperframes")
    if mode not in {"hyperframes", "whiteboard_animation", "direct_video"}:
        raise ValueError("unsupported production_mode for a new channel")
    seeds = action.params.get("seeds")
    if seeds is not None and (
        not isinstance(seeds, list)
        or any(not isinstance(seed, str) for seed in seeds)
    ):
        raise ValueError("seeds must be an array of strings")
    if "subtitle_effect" in action.params:
        normalize_subtitle_effect(action.params["subtitle_effect"])
    if mode == "hyperframes":
        template_id = str(action.params.get("template_id") or "knowledge-card")
        version = action.params.get("template_version", 1)
        if isinstance(version, bool) or not isinstance(version, int):
            raise ValueError("template_version must be an integer")
        variables = action.params.get("template_variables") or {}
        if not isinstance(variables, dict):
            raise ValueError("template_variables must be an object")
        TemplatePackRegistry().load(template_id, version).resolve_variables(variables)
    if mode == "whiteboard_animation":
        whiteboard = action.params.get("whiteboard") or {
            "template_id": "minimal-whiteboard",
            "template_version": 1,
        }
        if not isinstance(whiteboard, dict):
            raise ValueError("whiteboard must be an object")
        WhiteboardTemplateRegistry().resolve(whiteboard)


def _attach_producer_preconditions(
    action: ProducerAction,
    store: ProductionStore,
) -> ProducerAction:
    """Freeze server-owned optimistic concurrency guards into the auditable plan."""
    preconditions: dict[str, Any] = {}
    if action.action in {"update_scene_subtitle", "update_scene_direction"}:
        scene = store.get_scene_context(action.target_id)["scene"]
        preconditions["scene_updated_at"] = scene["updated_at"]
    return action.model_copy(update={"preconditions": preconditions})


def _validate_exact_params(action: ProducerAction, allowed: set[str]) -> None:
    unknown = set(action.params) - allowed
    if unknown:
        raise ValueError(f"unsupported params: {sorted(unknown)}")


def _editable_scene_context(store: ProductionStore, scene_id: str) -> dict[str, Any]:
    context = store.get_scene_context(scene_id)
    scene = context["scene"]
    revision = context["revision"]
    if revision["status"] != "draft":
        raise ValueError("scene revision is not a draft")
    if scene["locked"]:
        raise ValueError("scene is locked")
    if scene.get("regeneration_status") in {"pending", "running"}:
        raise ValueError("scene regeneration is in progress")
    return context


def _require_scene_precondition(action: ProducerAction, scene: dict[str, Any]) -> str:
    expected = action.preconditions.get("scene_updated_at")
    if expected is not None and expected != scene.get("updated_at"):
        raise ValueError("scene changed after the producer plan was drafted")
    return str(expected or scene["updated_at"])


def _resolve_channel_template_action(
    action: ProducerAction,
    channel: ChannelConfig,
) -> tuple[TemplatePack, dict[str, Any]]:
    _validate_exact_params(action, {"template_id", "template_version", "variables"})
    if not action.params:
        raise ValueError("at least one template field is required")
    if channel.video.get("production_mode") == "direct_video":
        raise ValueError("direct_video channel does not use an image template")
    current = dict(channel.video.get("hyperframes") or {})
    template_id = str(
        action.params.get("template_id") or current.get("template_id") or ""
    ).strip()
    raw_version = action.params.get("template_version", current.get("template_version", 1))
    if isinstance(raw_version, bool) or not isinstance(raw_version, int):
        raise ValueError("template_version must be an integer")
    raw_variables = action.params.get("variables", {})
    if not isinstance(raw_variables, dict):
        raise ValueError("variables must be an object")
    try:
        pack = TemplatePackRegistry().load(template_id, raw_version)
    except (FileNotFoundError, ValueError) as exc:
        raise ValueError(str(exc)) from exc
    actual_template_matches = channel.video.get("frame_template") == pack.native_template
    explicit_template_selection = bool(
        {"template_id", "template_version"} & set(action.params)
    )
    if not explicit_template_selection and not actual_template_matches:
        raise ValueError(
            "variables-only update requires frame_template to match the resolved template pack; "
            "select template_id explicitly before changing variables"
        )
    same_template = (
        actual_template_matches
        and
        template_id == current.get("template_id")
        and raw_version == current.get("template_version", 1)
    )
    base_variables: dict[str, Any] = {}
    if same_template:
        for source in (
            current.get("variables") or {},
            channel.video.get("template_params") or {},
        ):
            if isinstance(source, dict):
                base_variables.update(
                    {key: value for key, value in source.items() if key in pack.variables}
                )
    try:
        variables = pack.resolve_variables({**base_variables, **raw_variables})
    except ValueError as exc:
        raise ValueError(str(exc)) from exc
    return pack, variables


def _normalized_scene_subtitle_updates(
    action: ProducerAction,
    scene: dict[str, Any],
) -> dict[str, Any]:
    fields = {
        "subtitle_effect",
        "subtitle_keywords",
        "subtitle_start_offset",
        "subtitle_end_offset",
    }
    _validate_exact_params(action, fields)
    if not action.params:
        raise ValueError("at least one subtitle field is required")
    updates: dict[str, Any] = {}
    if "subtitle_effect" in action.params:
        value = action.params["subtitle_effect"]
        updates["subtitle_effect"] = (
            None if value is None or str(value).strip() == "" else normalize_subtitle_effect(value)
        )
    if "subtitle_keywords" in action.params:
        raw_keywords = action.params["subtitle_keywords"]
        if not isinstance(raw_keywords, list):
            raise ValueError("subtitle_keywords must be an array")
        updates["subtitle_keywords"] = normalize_subtitle_keywords(raw_keywords)
    for field in ("subtitle_start_offset", "subtitle_end_offset"):
        if field in action.params:
            value = action.params[field]
            if isinstance(value, bool):
                raise ValueError(f"{field} must be a number")
            try:
                number = float(value)
            except (TypeError, ValueError) as exc:
                raise ValueError(f"{field} must be a number") from exc
            if not 0 <= number <= 3600:
                raise ValueError(f"{field} must be between 0 and 3600")
            updates[field] = number
    start = float(updates.get("subtitle_start_offset", scene.get("subtitle_start_offset") or 0))
    end = float(updates.get("subtitle_end_offset", scene.get("subtitle_end_offset") or 0))
    duration = float(scene.get("duration") or 0)
    if duration > 0 and start + end > duration - 0.1:
        raise ValueError("subtitle offsets must leave at least 0.1 seconds visible")
    return updates


def _normalized_scene_direction_updates(
    action: ProducerAction,
    scene: dict[str, Any],
) -> dict[str, Any]:
    _validate_exact_params(action, {"image_motion", "transition", "transition_duration"})
    if not action.params:
        raise ValueError("at least one direction field is required")
    updates: dict[str, Any] = {}
    if "image_motion" in action.params:
        motion = str(action.params["image_motion"])
        if motion not in IMAGE_MOTIONS:
            raise ValueError(f"image_motion must be one of {IMAGE_MOTIONS}")
        updates["image_motion"] = motion
    transition = str(action.params.get("transition", scene.get("transition") or "none"))
    if transition not in SCENE_TRANSITIONS:
        raise ValueError(f"transition must be one of {SCENE_TRANSITIONS}")
    if int(scene.get("position") or 0) == 0 and transition != "none":
        raise ValueError("the first scene transition must be none")
    if "transition" in action.params:
        updates["transition"] = transition
    raw_duration = action.params.get(
        "transition_duration", scene.get("transition_duration") or 0
    )
    if isinstance(raw_duration, bool):
        raise ValueError("transition_duration must be a number")
    try:
        duration = float(raw_duration)
    except (TypeError, ValueError) as exc:
        raise ValueError("transition_duration must be a number") from exc
    minimum = 0 if transition == "none" else 0.05
    if not minimum <= duration <= 2:
        raise ValueError(f"transition_duration must be between {minimum:g} and 2")
    if "transition_duration" in action.params:
        updates["transition_duration"] = duration
    elif "transition" in action.params and transition == "none":
        updates["transition_duration"] = 0.0
    updates["direction_reason"] = action.rationale
    return updates


async def _execute_producer_action(
    action: ProducerAction,
    store: ProductionStore,
    config,
) -> dict[str, Any]:
    if action.action == "pause_channel":
        return store.set_channel_paused(action.target_id, True)
    if action.action == "resume_channel":
        return store.set_channel_paused(action.target_id, False)
    if action.action in {"pin_topic", "approve_topic", "defer_topic", "discard_topic"}:
        status_by_action = {
            "pin_topic": "pinned",
            "approve_topic": "approved",
            "defer_topic": "deferred",
            "discard_topic": "discarded",
        }
        return store.update_topic_candidate(
            action.target_id,
            status_by_action[action.action],
            action.rationale,
            action.params.get("deferred_until"),
        )
    if action.action == "retry_job":
        return await _retry_failed_job(store, action.target_id)
    if action.action == "approve_storyboard":
        return store.approve_storyboard(
            action.target_id,
            override=bool(action.params.get("override_content_gate", False)),
        )
    if action.action == "regenerate_scene":
        return await _queue_scene_regeneration(store, action, config)
    if action.action == "auto_repair_revision":
        return await _queue_quality_repair(store, action.target_id, config)
    if action.action == "activate_revision":
        return store.activate_revision(
            str(action.params["project_id"]),
            action.target_id,
        )
    if action.action == "set_channel_template":
        return _set_channel_template_from_producer(action, store, config)
    if action.action == "set_channel_whiteboard":
        return _set_channel_whiteboard_from_producer(action, store, config)
    if action.action == "set_channel_subtitle_effect":
        return _set_channel_subtitle_effect_from_producer(action, store, config)
    if action.action == "update_scene_subtitle":
        context = _editable_scene_context(store, action.target_id)
        expected_updated_at = _require_scene_precondition(action, context["scene"])
        return store.update_scene(
            action.target_id,
            expected_updated_at=expected_updated_at,
            require_idle=True,
            **_normalized_scene_subtitle_updates(action, context["scene"]),
        )
    if action.action == "update_scene_direction":
        context = _editable_scene_context(store, action.target_id)
        expected_updated_at = _require_scene_precondition(action, context["scene"])
        return store.update_scene(
            action.target_id,
            expected_updated_at=expected_updated_at,
            require_idle=True,
            **_normalized_scene_direction_updates(action, context["scene"]),
        )
    if action.action == "create_channel":
        return _create_channel_from_producer(action, store, config)
    if action.action == "update_channel":
        return _update_channel_from_producer(action, store, config)
    raise ValueError(f"Unsupported producer action: {action.action}")


async def _queue_scene_regeneration(
    store: ProductionStore,
    action: ProducerAction,
    config,
) -> dict[str, Any]:
    scope = str(action.params.get("scope", "full"))
    task = task_manager.create_task(
        task_type=TaskType.SCENE_REGENERATION,
        request_params={
            "database_path": config.database_path,
            "scene_id": action.target_id,
            "scope": scope,
            "preserve_style": bool(action.params.get("preserve_style", True)),
        },
    )
    try:
        store.begin_scene_regeneration(action.target_id, task.task_id, scope)
    except Exception:
        task_manager.cancel_task(task.task_id)
        raise
    await task_manager.execute_task(task.task_id)
    return {"task_id": task.task_id, "scene_id": action.target_id, "status": "pending"}


async def _queue_quality_repair(
    store: ProductionStore,
    revision_id: str,
    config,
) -> dict[str, Any]:
    source = store.get_revision(revision_id)
    plan = build_quality_repair_plan(source)
    if not plan["steps"]:
        raise ValueError("No repairable failed technical quality checks")
    prepared = store.prepare_quality_repair(revision_id, plan)
    existing_task_id = prepared["source"].get("repair_task_id")
    if existing_task_id and prepared["source"].get("repair_status") in {
        "pending",
        "running",
        "completed",
    }:
        return {
            "task_id": existing_task_id,
            "source_revision_id": revision_id,
            "target_revision_id": prepared["target"]["id"],
            "plan": prepared["plan"],
            "status": prepared["source"]["repair_status"],
        }
    target_revision_id = prepared["target"]["id"]
    task = task_manager.create_task(
        task_type=TaskType.QUALITY_REPAIR,
        idempotency_key=f"quality-repair:{revision_id}",
        request_params={
            "database_path": config.database_path,
            "source_revision_id": revision_id,
            "target_revision_id": target_revision_id,
            "plan": prepared["plan"],
        },
    )
    store.attach_quality_repair_task(revision_id, target_revision_id, task.task_id)
    await task_manager.execute_task(task.task_id)
    return {
        "task_id": task.task_id,
        "source_revision_id": revision_id,
        "target_revision_id": target_revision_id,
        "plan": prepared["plan"],
        "status": "pending",
    }


async def _retry_failed_job(store: ProductionStore, job_id: str) -> dict[str, Any]:
    job = store.get_job(job_id)
    if job["status"] != "failed":
        raise ValueError("Only failed jobs can be retried")
    task_id = job.get("api_task_id") or job.get("storyboard_task_id")
    if task_id:
        accepted = await task_manager.retry_task(task_id)
        if not accepted:
            raise ValueError("The linked API task is unavailable or not failed")
        next_status = "planning" if job.get("storyboard_task_id") == task_id else "pending"
    else:
        next_status = "planned"
    return store.update_job(
        job_id,
        status=next_status,
        retries=job["retries"] + 1,
        error=None,
        review_status="not_ready",
        review_note=None,
        reviewed_at=None,
    )


def _create_channel_from_producer(action: ProducerAction, store: ProductionStore, config):
    directory = Path(config.channels_dir)
    with _channel_write_guard(directory, action.target_id):
        _validate_create_channel_params(action)
        template_id = str(action.params.get("template_channel_id") or "")
        channels = load_channel_configs(config.channels_dir)
        if action.target_id in {channel.id for channel in channels}:
            raise ValueError("channel was created after the producer plan was approved")
        template = next(
            (channel for channel in channels if channel.id == template_id),
            None,
        )
        payload = (
            template.model_dump()
            if template is not None
            else _new_producer_channel_payload(action)
        )
        payload.update(
            {
                "id": action.target_id,
                "name": str(action.params.get("name") or action.target_id),
                "enabled": bool(action.params.get("enabled", False)),
                "config_source": "ai",
                "generation_reason": action.rationale,
            }
        )
        inventory = dict(payload["inventory"])
        for key in ("daily_target", "ready_target", "max_in_flight"):
            if key in action.params:
                inventory[key] = action.params[key]
        payload["inventory"] = inventory
        topic_prompt = str(
            action.params.get("topic_prompt")
            or action.params.get("name")
            or action.target_id
        ).strip()
        seeds = _producer_topic_seeds(
            action.params.get("seeds"),
            topic_prompt,
            str(action.params.get("name") or action.target_id),
        )
        # Content identity is never inherited from a template channel.  This is
        # what prevents a new lifestyle/comic channel from receiving poetry
        # seeds just because the first configured channel happened to be poetry.
        payload["topic"] = {
            "strategy": "llm",
            "seeds": seeds,
            "prompt": topic_prompt,
            "history_window": 50,
            "fallback_to_seeds": True,
        }
        planning = dict(payload["planning"])
        if "content_policy" in action.params:
            planning["content_policy"] = action.params["content_policy"]
        payload["planning"] = planning
        if "visual_memory" in action.params:
            if not isinstance(action.params["visual_memory"], dict):
                raise ValueError("visual_memory must be an object")
            payload["visual_memory"] = action.params["visual_memory"]
        payload["video"] = _producer_channel_video(
            action,
            dict(payload.get("video") or {}),
            topic_prompt,
        )
        channel = ChannelConfig.model_validate(payload)
        _validate_channel_config_or_422(channel)
        _validate_bindings_or_422(store, channel)
        _write_channel(directory, channel, expected_fingerprint="missing")
        return channel.model_dump()


def _new_producer_channel_payload(action: ProducerAction) -> dict[str, Any]:
    return {
        "id": action.target_id,
        "name": str(action.params.get("name") or action.target_id),
        "enabled": False,
        "config_source": "ai",
        "generation_reason": action.rationale,
        "topic": {
            "strategy": "llm",
            "seeds": [],
            "prompt": "",
            "history_window": 50,
            "fallback_to_seeds": True,
        },
        "inventory": {
            "ready_target": 3,
            "daily_target": 1,
            "max_in_flight": 1,
            "refill_batch": 1,
            "max_task_retries": 2,
            "circuit_breaker_failures": 3,
            "failure_cooldown_seconds": 1800,
        },
        "planning": {
            "enabled": True,
            "approval": "auto",
            "content_policy": "general",
            "llm_review": True,
        },
        "quality": {"auto_repair": True},
        "visual_memory": {},
        "video": {},
    }


def _producer_topic_seeds(
    raw_seeds: object,
    topic_prompt: str,
    channel_name: str,
) -> list[str]:
    provided = [
        seed.strip()
        for seed in (raw_seeds if isinstance(raw_seeds, list) else [])
        if isinstance(seed, str) and seed.strip()
    ]
    if provided:
        return list(dict.fromkeys(provided))
    subject = topic_prompt.strip() or channel_name.strip() or "频道主题"
    return [
        f"{subject}：一个立刻能用的具体方法",
        f"{subject}：最常见但容易忽略的误区",
        f"{subject}：用一个生活场景讲清原理",
        f"{subject}：三步完成的实用清单",
        f"{subject}：前后对比带来的真实变化",
    ]


def _producer_channel_video(
    action: ProducerAction,
    inherited: dict[str, Any],
    topic_prompt: str,
) -> dict[str, Any]:
    mode = str(action.params.get("production_mode") or "hyperframes")
    name = str(action.params.get("name") or action.target_id)
    style = str(action.params.get("prompt_prefix") or "").strip()
    if not style:
        style = _producer_visual_style(name, topic_prompt, mode)
    voice_preset = dict(
        action.params.get("voice_preset")
        or inherited.get("voice_preset")
        or {}
    )
    voice_volume = float(
        voice_preset.get("voice_volume")
        if voice_preset.get("voice_volume") is not None
        else inherited.get("voice_volume", 1.0)
    )
    voice_preset["voice_volume"] = voice_volume
    common = {
        "mode": "generate",
        "n_scenes": int(action.params.get("n_scenes") or inherited.get("n_scenes") or 6),
        "video_fps": int(inherited.get("video_fps") or 30),
        "voice_id": str(
            action.params.get("voice_id")
            or voice_preset.get("voice_id")
            or inherited.get("voice_id")
            or "zh-CN-YunxiNeural"
        ),
        "tts_speed": float(
            voice_preset.get("tts_speed")
            or inherited.get("tts_speed")
            or 1
        ),
        "voice_volume": voice_volume,
        "prompt_prefix": style,
        "subtitle_effect": str(
            action.params.get("subtitle_effect")
            or inherited.get("subtitle_effect")
            or "static"
        ),
        "limit_scenes": bool(action.params.get("limit_scenes", inherited.get("limit_scenes", True))),
        "watermark": dict(
            action.params.get("watermark")
            or inherited.get("watermark")
            or {"enabled": False}
        ),
        "voice_preset": voice_preset,
        "bgm_path": str(voice_preset.get("bgm_path") or inherited.get("bgm_path") or ""),
        "bgm_mode": str(voice_preset.get("bgm_mode") or inherited.get("bgm_mode") or "loop"),
        "bgm_volume": float(
            voice_preset.get("bgm_volume")
            if voice_preset.get("bgm_volume") is not None
            else inherited.get("bgm_volume", 0.18)
        ),
        "image_generation_concurrency": int(
            action.params.get("image_generation_concurrency")
            or inherited.get("image_generation_concurrency")
            or 4
        ),
    }
    if mode == "whiteboard_animation":
        whiteboard = action.params.get("whiteboard") or {
            "template_id": "minimal-whiteboard",
            "template_version": 1,
        }
        return {
            **common,
            "production_mode": mode,
            "render_engine": "whiteboard_cv",
            "media_workflow": "api/default/image",
            "frame_template": None,
            "whiteboard": whiteboard,
        }
    if mode == "direct_video":
        return {
            **common,
            "production_mode": mode,
            "render_engine": "native_image_html",
            "media_workflow": "api/default/video",
            "frame_template": "1080x1920/video_default.html",
        }
    pack = TemplatePackRegistry().load(
        str(action.params.get("template_id") or "knowledge-card"),
        int(action.params.get("template_version") or 1),
    )
    variables = pack.resolve_variables(action.params.get("template_variables") or {})
    return {
        **common,
        "production_mode": "hyperframes",
        "render_engine": "hyperframes",
        "media_workflow": "api/default/image",
        "frame_template": pack.native_template,
        "template_params": variables,
        "hyperframes": {
            "template_id": pack.template_id,
            "template_version": pack.version,
            "variables": variables,
            "quality": "standard",
            "strictness": "strict",
            "use_gpu": True,
            "fallback_to_native": True,
        },
    }


def _producer_visual_style(name: str, topic_prompt: str, mode: str) -> str:
    subject = f"{name}；{topic_prompt}".strip("；")
    if mode == "whiteboard_animation":
        return (
            f"Hand-drawn whiteboard comic explainer for {subject}, expressive ink line art, "
            "simple characters and props, clear visual hierarchy, warm humor, vertical 9:16, "
            "no labels, no text, no watermark"
        )
    if mode == "direct_video":
        return (
            f"Short-form cinematic scene about {subject}, clear subject action, coherent motion, "
            "vertical 9:16, natural lighting, no labels, no text, no watermark"
        )
    return (
        f"Editorial comic explainer for {subject}, friendly illustrated panels, expressive characters, "
        "clean information hierarchy, consistent palette, vertical 9:16, no labels, no text, no watermark"
    )


def _update_channel_from_producer(action: ProducerAction, store: ProductionStore, config):
    directory = Path(config.channels_dir)
    with _channel_write_guard(directory, action.target_id):
        channel, fingerprint = _current_channel_snapshot(config, action.target_id)
        allowed = {"name", "enabled", "inventory", "topic", "planning", "quality", "visual_memory", "video"}
        updates = {key: value for key, value in action.params.items() if key in allowed}
        updated = ChannelConfig.model_validate(_deep_merge(channel.model_dump(), updates))
        _validate_bindings_or_422(store, updated)
        _write_channel(
            directory,
            updated,
            replace_id=channel.id,
            expected_fingerprint=fingerprint,
        )
        return updated.model_dump()


def _current_channel(config, channel_id: str) -> ChannelConfig:
    return _current_channel_snapshot(config, channel_id)[0]


def _current_channel_snapshot(config, channel_id: str) -> tuple[ChannelConfig, str]:
    directory = Path(config.channels_dir).expanduser().resolve()
    target = _find_channel_path(directory, channel_id)
    if target is None:
        raise ValueError("channel does not exist")
    raw = target.read_bytes()
    payload = yaml.safe_load(raw.decode("utf-8")) or {}
    channel = ChannelConfig.model_validate(payload)
    if channel.id != channel_id:
        raise ValueError("channel file identity changed concurrently")
    return channel, hashlib.sha256(raw).hexdigest()


def _set_channel_template_from_producer(
    action: ProducerAction,
    store: ProductionStore,
    config,
) -> dict[str, Any]:
    directory = Path(config.channels_dir)
    with _channel_write_guard(directory, action.target_id):
        channel, fingerprint = _current_channel_snapshot(config, action.target_id)
        pack, variables = _resolve_channel_template_action(action, channel)
        video = dict(channel.video)
        hyperframes = dict(video.get("hyperframes") or {})
        hyperframes.update(
            template_id=pack.template_id,
            template_version=pack.version,
            variables=variables,
        )
        video.update(
            frame_template=pack.native_template,
            template_params=variables,
            hyperframes=hyperframes,
        )
        updated = ChannelConfig.model_validate({**channel.model_dump(), "video": video})
        _validate_bindings_or_422(store, updated)
        _write_channel(
            directory,
            updated,
            replace_id=channel.id,
            expected_fingerprint=fingerprint,
        )
        return {
            "channel_id": channel.id,
            "template_id": pack.template_id,
            "template_version": pack.version,
            "frame_template": pack.native_template,
            "variables": variables,
        }


def _resolve_channel_whiteboard_action(action: ProducerAction) -> dict[str, Any]:
    _validate_exact_params(
        action,
        {
            "template_id",
            "template_version",
            "hand_enabled",
            "fallback_policy",
            "render_profile",
        },
    )
    if "template_id" not in action.params or "template_version" not in action.params:
        raise ValueError("template_id and template_version are required")
    return WhiteboardTemplateRegistry().resolve(action.params)


def _set_channel_whiteboard_from_producer(
    action: ProducerAction,
    store: ProductionStore,
    config,
) -> dict[str, Any]:
    whiteboard = _resolve_channel_whiteboard_action(action)
    directory = Path(config.channels_dir)
    with _channel_write_guard(directory, action.target_id):
        channel, fingerprint = _current_channel_snapshot(config, action.target_id)
        video = {
            **channel.video,
            "production_mode": "whiteboard_animation",
            "render_engine": "whiteboard_cv",
            "renderer_version": "whiteboard-cv-v1",
            "media_workflow": "api/default/image",
            "frame_template": None,
            "whiteboard": whiteboard,
        }
        updated = ChannelConfig.model_validate({**channel.model_dump(), "video": video})
        _validate_bindings_or_422(store, updated)
        _write_channel(
            directory,
            updated,
            replace_id=channel.id,
            expected_fingerprint=fingerprint,
        )
        return {
            "channel_id": channel.id,
            "production_mode": "whiteboard_animation",
            "render_engine": "whiteboard_cv",
            "whiteboard": whiteboard,
        }


def _set_channel_subtitle_effect_from_producer(
    action: ProducerAction,
    store: ProductionStore,
    config,
) -> dict[str, Any]:
    _validate_exact_params(action, {"subtitle_effect"})
    if set(action.params) != {"subtitle_effect"}:
        raise ValueError("subtitle_effect is required")
    if not isinstance(action.params["subtitle_effect"], str) or not action.params[
        "subtitle_effect"
    ].strip():
        raise ValueError("subtitle_effect must be a non-empty string")
    directory = Path(config.channels_dir)
    with _channel_write_guard(directory, action.target_id):
        channel, fingerprint = _current_channel_snapshot(config, action.target_id)
        effect = normalize_subtitle_effect(action.params["subtitle_effect"])
        video = {**channel.video, "subtitle_effect": effect}
        updated = ChannelConfig.model_validate({**channel.model_dump(), "video": video})
        _validate_bindings_or_422(store, updated)
        _write_channel(
            directory,
            updated,
            replace_id=channel.id,
            expected_fingerprint=fingerprint,
        )
        return {"channel_id": channel.id, "subtitle_effect": effect}


@router.get("/topics")
def list_topic_candidates(
    channel_id: str | None = None,
    status_filter: Annotated[str | None, Query(alias="status")] = None,
    limit: Annotated[int, Query(ge=1, le=1000)] = 200,
):
    statuses = tuple(item for item in (status_filter or "").split(",") if item) or None
    with _store() as store:
        try:
            items = store.list_topic_candidates(channel_id, statuses, limit)
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
    return {"topics": items, "count": len(items)}


@router.post("/topics", status_code=status.HTTP_201_CREATED)
def create_topic_candidate(body: TopicCandidateCreateRequest):
    channel = _get_channel(body.channel_id)
    with _store() as store:
        scoring = score_topic(
            channel,
            body.title,
            body.topic,
            store.topic_references(channel.id),
        )
        return store.create_topic_candidate(
            channel.id,
            body.title,
            body.topic,
            {
                **scoring,
                "cover_copy": body.cover_copy,
                "platform_description": body.platform_description,
                "tags": body.tags,
                "source_type": "manual",
                "status": "discarded" if scoring.get("duplicate_of") else "new",
                "title_variants": prepare_title_variants(body.title),
            },
        )


@router.post("/topics/generate", status_code=status.HTTP_201_CREATED)
async def generate_topic_candidates(body: TopicCandidateGenerateRequest):
    channel = _get_channel(body.channel_id)
    core = await get_pixelle_video()
    with _store() as store:
        references = store.topic_references(channel.id)
        history = store.recent_topics(channel.id, channel.topic.history_window)
        _, _, topic_prompt = resolve_channel_policies(store, channel)
        fallback = False
        try:
            suggestions = await propose_topics(
                channel,
                core.llm,
                body.count,
                history,
                body.source_text,
                topic_prompt,
            )
            source_type = "llm"
        except Exception as exc:
            if not channel.topic.fallback_to_seeds:
                raise HTTPException(status_code=502, detail=str(exc)) from exc
            fallback = True
            source_type = "seed_fallback"
            suggestions = [
                {
                    "title": seed,
                    "topic": seed,
                    "cover_copy": seed[:18],
                    "platform_description": "",
                    "tags": [],
                }
                for seed in channel.topic.seeds[: body.count]
            ]
        created = []
        for suggestion in suggestions:
            scoring = score_topic(
                channel,
                suggestion["title"],
                suggestion["topic"],
                references,
                suggestion.get("semantic_terms", []),
            )
            candidate = store.create_topic_candidate(
                channel.id,
                suggestion["title"],
                suggestion["topic"],
                {
                    **scoring,
                    "cover_copy": suggestion.get("cover_copy", ""),
                    "platform_description": suggestion.get("platform_description", ""),
                    "tags": suggestion.get("tags", []),
                    "source_type": source_type,
                    "source_label": body.source_label or body.source_type,
                    "status": "discarded" if scoring.get("duplicate_of") else "new",
                    "title_variants": prepare_title_variants(
                        suggestion["title"], suggestion.get("title_variants", [])
                    ),
                },
            )
            created.append(candidate)
            references.append(
                {
                    "id": candidate["id"],
                    "topic": candidate["topic"],
                    "semantic_terms": candidate["semantic_terms"],
                    "semantic_vector": candidate["semantic_vector"],
                }
            )
    return {"topics": created, "count": len(created), "fallback": fallback}


@router.patch("/topics/{candidate_id}")
def decide_topic_candidate(candidate_id: str, body: TopicCandidateDecisionRequest):
    with _store() as store:
        try:
            return store.update_topic_candidate(
                candidate_id, body.status, body.note, body.deferred_until
            )
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="Topic candidate not found") from exc
        except ValueError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc


@router.patch("/topics/{candidate_id}/title")
def select_topic_candidate_title(candidate_id: str, body: TopicTitleSelectionRequest):
    with _store() as store:
        try:
            return store.select_topic_title(candidate_id, body.variant_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="Topic candidate not found") from exc
        except ValueError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc


@router.post("/storyboards/plan", status_code=status.HTTP_202_ACCEPTED)
async def create_storyboard_plan(
    body: StoryboardPlanningRequest,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
):
    """Plan and audit a storyboard without invoking TTS or a media model."""
    task = task_manager.create_task(
        TaskType.STORYBOARD_PLANNING,
        request_params=body.model_dump(),
        idempotency_key=idempotency_key,
    )
    await task_manager.execute_task(task.task_id)
    return {"task_id": task.task_id, "status": "pending"}


@router.post("/custom-script/recommend", status_code=status.HTTP_202_ACCEPTED)
async def recommend_custom_script(
    body: CustomScriptRecommendationRequest,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
):
    """Queue a durable custom-copy recommendation and return its task handle."""
    params = body.model_dump()
    params.setdefault("title", "自定义文案编排")
    task = task_manager.create_task(
        TaskType.CUSTOM_SCRIPT_RECOMMENDATION,
        request_params=params,
        idempotency_key=idempotency_key,
    )
    await task_manager.execute_task(task.task_id)
    return {"task_id": task.task_id, "status": task.status.value}


@router.post("/custom-script/jobs", status_code=status.HTTP_202_ACCEPTED)
async def create_custom_script_job(body: CustomScriptJobRequest):
    """Freeze an approved rundown and immediately start storyboard planning."""
    channel = _get_channel(body.channel_id)
    route = config_manager.resolve_model(
        "video" if body.production_mode == "direct_video" else "image"
    )
    media_workflow = f"api/{route['channel_id']}/{route['model']}"
    native = {
        **dict(channel.video.get("native") or {}),
        "image_motion": body.image_motion,
        "transition": body.transition,
        "scene_direction": "auto",
    }
    channel_hyperframes = dict(channel.video.get("hyperframes") or {})
    hyperframes_pack = TemplatePackRegistry().load(
        str(channel_hyperframes.get("template_id") or "knowledge-card"),
        int(channel_hyperframes.get("template_version") or 1),
    )
    hyperframes_variables = hyperframes_pack.resolve_variables(
        channel_hyperframes.get("variables") or {}
    )
    mode_overrides = {
        "direct_video": {
            "production_mode": "direct_video",
            "render_engine": "native_image_html",
            "renderer_version": "native-image-html-v2",
            "media_workflow": media_workflow,
            "frame_template": "1080x1920/video_default.html",
        },
        "hyperframes": {
            "production_mode": "hyperframes",
            "render_engine": "hyperframes",
            "renderer_version": "0.8.4",
            "media_workflow": media_workflow,
            "frame_template": hyperframes_pack.native_template,
            "template_params": hyperframes_variables,
            "hyperframes": {
                **channel_hyperframes,
                "template_id": hyperframes_pack.template_id,
                "template_version": hyperframes_pack.version,
                "variables": hyperframes_variables,
            },
        },
        "whiteboard_animation": {
            "production_mode": "whiteboard_animation",
            "render_engine": "whiteboard_cv",
            "renderer_version": "whiteboard-cv-v1",
            "media_workflow": media_workflow,
            "frame_template": None,
            "template_sha256": None,
        },
    }[body.production_mode]
    mode_overrides.update(
        native=native,
        subtitle_effect=body.subtitle_effect,
        image_generation_concurrency=body.image_generation_concurrency,
    )
    if body.production_mode == "whiteboard_animation" and body.whiteboard_template_id:
        mode_overrides["whiteboard"] = {
            **dict(channel.video.get("whiteboard") or {}),
            "template_id": body.whiteboard_template_id,
        }
    with _store() as store:
        video_request = resolve_channel_request(
            store,
            channel,
            body.script,
            body.title,
            video_overrides=mode_overrides,
        )
        planning, _, _ = resolve_channel_policies(store, channel)
        video_request.update(
            text=body.script,
            title=body.title,
            mode="fixed",
            split_mode="sentence",
            custom_script=True,
            n_scenes=body.n_scenes,
            scene_strategy="content_auto",
            image_generation_concurrency=body.image_generation_concurrency,
            subtitle_effect=body.subtitle_effect,
            image_motion=body.image_motion,
            transition=body.transition,
            scene_direction="auto",
            voice_id=body.voice_id,
            tts_speed=body.tts_speed,
            bgm_volume=body.bgm_volume,
        )
        production = dict(video_request.get("_production") or {})
        production["custom_script"] = {
            "rewrite_enabled": body.rewrite_enabled,
            "review_mode": body.review_mode,
            "original_script": body.original_script if body.rewrite_enabled else None,
            "scene_count_basis": describe_custom_script_scene_count(
                body.script, body.n_scenes
            ),
            "scene_strategy": "content_auto",
        }
        production["planning"] = {
            **planning,
            "enabled": True,
            "approval": "manual" if body.review_mode == "manual" else "auto",
            "content_policy": body.content_policy,
            "llm_review": body.review_mode == "ai_auto",
        }
        video_request["_production"] = production
        try:
            job = store.create_job(channel.id, body.script, body.title, video_request)
        except ValueError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        task = task_manager.create_task(
            TaskType.STORYBOARD_PLANNING,
            request_params={
                **video_request,
                "content_policy": body.content_policy,
                "llm_review": body.review_mode == "ai_auto",
            },
            idempotency_key=f"custom-script-plan:{job['id']}",
        )
        job = store.update_job(
            job["id"],
            status="planning",
            storyboard_task_id=task.task_id,
            storyboard_status="planning",
        )
    await task_manager.execute_task(task.task_id)
    return {"job": job, "task_id": task.task_id}


@router.post("/channels", status_code=status.HTTP_201_CREATED)
def create_channel(channel: ChannelConfig):
    directory = Path(_config().channels_dir)
    with _channel_write_guard(directory, channel.id):
        config = _config()
        if channel.id in {item.id for item in config.channels}:
            raise HTTPException(status_code=409, detail="Production channel already exists")
        channel = channel.model_copy(update={
            "config_source": "api",
            "generation_reason": channel.generation_reason or "通过频道配置 API 创建",
        })
        _validate_channel_config_or_422(channel)
        with _store() as store:
            _validate_bindings_or_422(store, channel)
        try:
            _write_channel(directory, channel, expected_fingerprint="missing")
        except ValueError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
    return channel


@router.patch("/channels/{channel_id}")
def update_channel(
    channel_id: str,
    updates: Annotated[dict[str, Any], Body()],
):
    directory = Path(_config().channels_dir)
    with _channel_write_guard(directory, channel_id):
        config = _config()
        try:
            current, fingerprint = _current_channel_snapshot(config, channel_id)
        except ValueError:
            raise HTTPException(status_code=404, detail="Production channel not found")
        if "id" in updates and updates["id"] != channel_id:
            raise HTTPException(status_code=409, detail="Channel id cannot be changed")
        try:
            channel = ChannelConfig.model_validate(_deep_merge(current.model_dump(), updates))
        except ValidationError as exc:
            raise HTTPException(status_code=422, detail=exc.errors()) from exc
        _validate_channel_config_or_422(channel)
        with _store() as store:
            _validate_bindings_or_422(store, channel)
        try:
            _write_channel(
                directory,
                channel,
                replace_id=channel_id,
                expected_fingerprint=fingerprint,
            )
        except ValueError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
    return channel


@router.post("/channels/{channel_id}/copy", status_code=status.HTTP_201_CREATED)
def copy_channel(channel_id: str, body: CopyChannelRequest):
    directory = Path(_config().channels_dir)
    with _channel_write_guard(directory, body.id):
        config = _config()
        current = next((item for item in config.channels if item.id == channel_id), None)
        if current is None:
            raise HTTPException(status_code=404, detail="Production channel not found")
        if body.id in {item.id for item in config.channels}:
            raise HTTPException(status_code=409, detail="Target channel already exists")
        copied = current.model_copy(
            update={
                "id": body.id,
                "name": body.name,
                "enabled": False,
                "config_source": "copy",
                "generation_reason": f"复制频道 {current.id} 后由人工确认名称",
            }
        )
        _validate_channel_config_or_422(copied)
        with _store() as store:
            _validate_bindings_or_422(store, copied)
        try:
            _write_channel(directory, copied, expected_fingerprint="missing")
        except ValueError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
    return copied


@router.post("/channels/{channel_id}/test", status_code=status.HTTP_202_ACCEPTED)
async def create_channel_test(channel_id: str, body: ChannelTestRequest, request: Request):
    config = _config()
    channel = next((item for item in config.channels if item.id == channel_id), None)
    if channel is None:
        raise HTTPException(status_code=404, detail="Production channel not found")
    topic = (body.topic or "").strip()
    if not topic:
        topic = channel.topic.seeds[0] if channel.topic.seeds else f"{channel.name}测试样片"
    with _store() as store:
        video_request = resolve_channel_request(store, channel, topic, f"[测试] {topic}")
        planning, _, _ = resolve_channel_policies(store, channel)
        job = store.create_job(
            channel.id,
            topic,
            f"[测试] {topic}",
            video_request,
            allow_duplicate=True,
        )
        if planning["enabled"]:
            task = task_manager.create_task(
                TaskType.STORYBOARD_PLANNING,
                request_params={
                    **video_request,
                    "content_policy": planning["content_policy"],
                    "llm_review": planning["llm_review"],
                },
                idempotency_key=f"production:test-plan:{job['id']}",
            )
            job = store.update_job(
                job["id"],
                status="planning",
                storyboard_task_id=task.task_id,
                storyboard_status="planning",
            )
        else:
            task = task_manager.create_task(
                TaskType.VIDEO_GENERATION,
                request_params={
                    **video_request,
                    "_request_base_url": str(request.base_url).rstrip("/"),
                },
                idempotency_key=f"production:test:{job['id']}",
            )
            job = store.update_job(job["id"], status="pending", api_task_id=task.task_id)
    await task_manager.execute_task(task.task_id)
    return {"job": job, "task_id": task.task_id}


@router.get("/jobs/{job_id}")
def get_production_job(job_id: str, request: Request):
    with _store() as store:
        try:
            job = store.get_job(job_id, with_timeline=True)
            return _decorate_job_video(_with_task_progress(job, store), request)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="Production job not found") from exc


@router.post("/channels/{channel_id}/sound/preview")
def preview_channel_sound(
    channel_id: str,
    request: Request,
    body: Annotated[dict[str, Any], Body()],
):
    _require_channel(channel_id)
    try:
        preset = normalize_sound_preset(channel_id, body)
        output = Path("output") / "previews" / f"sound-{channel_id}-{uuid.uuid4().hex}.m4a"
        result = create_audio_preview(preset=preset, output_path=output)
        return {
            **preset_preview_metadata(preset),
            **result,
            "url": path_to_url_from_base(str(request.base_url), str(output.resolve())),
        }
    except (OSError, ValueError, RuntimeError) as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.post("/jobs/{job_id}/sound/remix")
def remix_job_sound(
    job_id: str,
    request: Request,
    body: Annotated[dict[str, Any], Body()],
):
    with _store() as store:
        job = store.get_job(job_id)
        video = str((job.get("result") or {}).get("video_path") or "")
        if not video:
            raise HTTPException(status_code=409, detail="Job has no finished video")
        preset = normalize_sound_preset(job["channel_id"], body)
        frames = (job.get("storyboard") or {}).get("frames") or []
        output = Path(video).resolve().with_name("final-sound-remix.mp4")
        try:
            result = apply_sound_preset(
                video_path=video,
                preset=preset,
                output_path=output,
                scene_segment_paths=[frame.get("audio_path") for frame in frames if frame.get("audio_path")],
                scene_pauses=[preset.override_for(index + 1).pause_seconds or 0 if preset.override_for(index + 1) else 0 for index in range(len(frames))],
            )
        except (OSError, ValueError, RuntimeError) as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        current_result = dict(job.get("result") or {})
        updated = store.update_job(job_id, result_json={**current_result, "video_path": str(output), "sound_remix": result})
    return {"job": _decorate_job_video(updated, request), **result}


def _decorate_job_video(job: dict[str, Any], request: Request) -> dict[str, Any]:
    """Build a fresh request-host URL from the durable local video path."""
    result = job.get("result")
    if not isinstance(result, dict) or not result.get("video_path"):
        return job
    value = dict(job)
    value["result"] = {
        **result,
        "video_url": path_to_url_from_base(str(request.base_url), str(result["video_path"])),
    }
    return value


def _with_task_progress(
    job: dict[str, Any],
    store: ProductionStore | None = None,
) -> dict[str, Any]:
    """Attach live durable-task progress without storing transient ticks in SQLite."""
    task_id = (
        job.get("storyboard_task_id")
        if job.get("status") in {"planning", "awaiting_storyboard"}
        else job.get("api_task_id")
    )
    task = task_manager.get_task(str(task_id)) if task_id else None
    value = dict(job)
    if task is None:
        value["progress"] = None
        return value
    progress = task.progress.model_dump() if task.progress else {
        "current": 0,
        "total": 100,
        "percentage": 0,
        "message": "等待任务状态",
    }
    value["progress"] = {
        **progress,
        "task_id": task.task_id,
        "task_type": task.task_type.value,
        "task_status": task.status.value,
        "attempt": task.attempts,
    }
    if store is not None:
        stage = _progress_stage(task.task_type.value, progress.get("message") or "")
        store.sync_job_progress_stage(
            job["id"], task.task_id, task.task_type.value, stage,
            message=progress.get("message"),
        )
        value["timeline"] = store.get_job_timeline(job["id"])
    return value


def _progress_stage(task_type: str, message: str) -> str:
    text = f"{task_type} {message}".lower()
    for stage, markers in (
        ("planning", ("planning", "分镜", "脚本")),
        ("voice", ("audio", "tts", "配音", "旁白")),
        ("image", ("image", "图片", "画面")),
        ("cover", ("cover", "封面")),
        ("quality", ("quality", "质检", "修复")),
        ("render", ("render", "渲染", "合成", "video")),
    ):
        if any(marker in text for marker in markers):
            return stage
    return "background"


def _assert_storyboard_not_redirecting(job: dict[str, Any]) -> None:
    """Reject edits while a durable redirection still owns the storyboard."""
    task_id = job.get("storyboard_task_id")
    task = task_manager.get_task(str(task_id)) if task_id else None
    if (
        task is not None
        and task.task_type == TaskType.STORYBOARD_REDIRECTION
        and task.status in {TaskStatus.PENDING, TaskStatus.RUNNING}
    ):
        raise HTTPException(status_code=409, detail="Storyboard redirection is still running")


async def _queue_storyboard_redirection(
    store: ProductionStore,
    job_id: str,
    body: StoryboardUpdateRequest,
) -> tuple[dict[str, Any], Task]:
    """Validate, reserve, and durably enqueue one review-aware redirection."""
    job = store.get_job(job_id)
    if job["status"] != "awaiting_storyboard" or not job.get("storyboard"):
        raise HTTPException(status_code=409, detail="Storyboard is not editable")
    _assert_storyboard_not_redirecting(job)

    update = body.model_dump()
    story_state = {
        "title": job.get("title"),
        "storyboard": job.get("storyboard"),
        "content_checks": job.get("content_checks"),
        "content_gate_status": job.get("content_gate_status"),
        "update": update,
    }
    fingerprint = hashlib.sha256(
        json.dumps(story_state, ensure_ascii=False, sort_keys=True).encode("utf-8")
    ).hexdigest()[:16]
    task = task_manager.create_task(
        TaskType.STORYBOARD_REDIRECTION,
        request_params={
            "title": body.title,
            "job_id": job_id,
            "database_path": _config().database_path,
            "update": update,
        },
        idempotency_key=(
            f"production:storyboard-redirect:{job_id}:{fingerprint}"
        ),
    )
    reserved = store.update_job(
        job_id,
        storyboard_task_id=task.task_id,
        storyboard_status="redirecting",
    )
    if task.status == TaskStatus.FAILED:
        await task_manager.retry_task(task.task_id)
    else:
        await task_manager.execute_task(task.task_id)
    return reserved, task


@router.patch("/jobs/{job_id}/storyboard")
async def update_job_storyboard(job_id: str, body: StoryboardUpdateRequest):
    """Edit a storyboard or regenerate it from the visible review guidance."""
    with _store() as store:
        try:
            job = store.get_job(job_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="Production job not found") from exc
        if job["status"] != "awaiting_storyboard" or not job.get("storyboard"):
            raise HTTPException(status_code=409, detail="Storyboard is not editable")
        _assert_storyboard_not_redirecting(job)
        scenes = []
        for index, scene in enumerate(body.scenes):
            payload = scene.model_dump()
            if index == 0:
                payload["transition"] = "none"
                payload["transition_duration"] = 0.0
            scenes.append({"position": index, **payload})
        policy = job["storyboard"].get("content_policy") or "general"
        director_rationale = ""
        next_title = body.title
        if body.auto_direct:
            reserved, task = await _queue_storyboard_redirection(store, job_id, body)
            return {
                "job": reserved,
                "task_id": task.task_id,
                "status": task.status.value,
            }
        else:
            checks = inspect_storyboard_content(next_title, scenes, policy)
            checks.append(
                {
                    "name": "content_llm_review",
                    "status": "warn",
                    "detail": {
                        "policy": policy,
                        "summary": "分镜已人工修改；生成前建议重新执行文字模型内容复核",
                        "stale": True,
                    },
                }
            )
            gate = (
                "fail" if any(item["status"] == "fail" for item in checks) else "warn"
            )
        plan = {
            **job["storyboard"],
            "title": next_title,
            "scenes": scenes,
            "director_rationale": director_rationale or None,
            "director_note": body.director_note or None,
        }
        return store.update_job(
            job_id,
            title=next_title,
            storyboard_json=plan,
            content_checks_json=checks,
            content_gate_status=gate,
            storyboard_status="review_pending",
        )


@router.post(
    "/jobs/{job_id}/storyboard/redirect",
    status_code=status.HTTP_202_ACCEPTED,
)
async def redirect_job_storyboard(job_id: str, body: StoryboardUpdateRequest):
    """Create a durable background task; closing Studio does not cancel it."""
    with _store() as store:
        job, task = await _queue_storyboard_redirection(store, job_id, body)
    return {
        "job": job,
        "task_id": task.task_id,
        "status": task.status.value,
    }


@router.post("/jobs/{job_id}/storyboard/approve")
def approve_job_storyboard(job_id: str, body: StoryboardApprovalRequest | None = None):
    with _store() as store:
        try:
            job = store.get_job(job_id)
            _assert_storyboard_not_redirecting(job)
            return store.approve_storyboard(
                job_id,
                override=bool(body and body.override_content_gate),
            )
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="Production job not found") from exc
        except ValueError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc


@router.get("/library/videos")
def list_library_videos(
    request: Request,
    channel_id: str | None = None,
    review_status: Literal["pending", "approved", "rejected"] | None = None,
    limit: Annotated[int, Query(ge=1, le=1000)] = 100,
):
    """Return generated videos for the poster-style review library."""
    with _store() as store:
        videos = store.list_library(
            channel_id=channel_id,
            review_status=review_status,
            limit=limit,
        )
    decorated = [_decorate_job_video(video, request) for video in videos]
    return {"videos": decorated, "count": len(decorated)}


@router.post("/reviews/batch/preview")
def preview_batch_review(body: BatchReviewRequest):
    """Validate every target and report exact all-or-nothing impact."""
    with _store() as store:
        return _batch_review_preflight(store, body)


@router.post("/reviews/batch")
def execute_batch_review(body: BatchReviewRequest):
    """Atomically review a bounded set after repeating the quality preflight."""
    with _store() as store:
        impact = _batch_review_preflight(store, body)
        if impact["blocked"]:
            raise HTTPException(status_code=409, detail=impact)
        try:
            jobs = store.review_jobs_batch(body.job_ids, body.decision, body.note)
        except ValueError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
    return {**impact, "completed": len(jobs), "jobs": jobs}


def _batch_review_preflight(
    store: ProductionStore,
    body: BatchReviewRequest,
) -> dict[str, Any]:
    eligible: list[dict[str, str]] = []
    blocked: list[dict[str, str]] = []
    for job_id in body.job_ids:
        try:
            job = store.get_job(job_id)
        except KeyError:
            blocked.append({"job_id": job_id, "reason": "Production job not found"})
            continue
        reason = _review_blocker(store, job, body.decision)
        target = {"job_id": job_id, "title": job.get("title") or job["topic"]}
        if reason:
            blocked.append({**target, "reason": reason})
        else:
            eligible.append(target)
    return {
        "decision": body.decision,
        "requested": len(body.job_ids),
        "eligible": eligible,
        "blocked": blocked,
        "atomic": True,
    }


def _review_blocker(
    store: ProductionStore,
    job: dict[str, Any],
    decision: str,
) -> str | None:
    if job["status"] != "ready":
        return "Only ready jobs can be reviewed"
    if decision != "approved":
        return None
    try:
        project = store.get_project_by_job(job["id"])
    except KeyError:
        if not job.get("api_task_id"):
            return None
        try:
            project = sync_job_project(store, job)
        except (FileNotFoundError, ValueError) as exc:
            return str(exc)
    active_revision = next(
        (
            revision
            for revision in project["revisions"]
            if revision["id"] == project["current_revision_id"]
        ),
        None,
    )
    if active_revision is None:
        return "Project has no active revision"
    if active_revision["quality_status"] in {"fail", "stale", "pending"}:
        return "Technical quality gate is not ready"
    return None


@router.post("/jobs/batch/retry/preview")
def preview_batch_job_retry(body: BatchJobRequest):
    """Check that every selected queue item is still retryable."""
    with _store() as store:
        return _batch_retry_preflight(store, body.job_ids)


@router.post("/jobs/batch/parameters/preview")
def preview_batch_job_parameters(body: BatchParameterRequest):
    with _store() as store:
        return _batch_parameter_preflight(store, body)


@router.post("/jobs/batch/parameters")
def update_batch_job_parameters(body: BatchParameterRequest):
    with _store() as store:
        preview = _batch_parameter_preflight(store, body)
        if preview["blocked"]:
            raise HTTPException(status_code=409, detail=preview)
        requests = {
            item["job_id"]: {**store.get_job(item["job_id"])["request"], **body.updates}
            for item in preview["eligible"]
        }
        jobs = store.update_job_requests_batch(requests)
    return {**preview, "completed": len(jobs), "jobs": jobs}


def _batch_parameter_preflight(
    store: ProductionStore,
    body: BatchParameterRequest,
) -> dict[str, Any]:
    structural = {"production_mode", "frame_template", "media_workflow"}
    audio = {"voice_id", "tts_speed", "voice_volume", "bgm_path", "bgm_volume"}
    eligible = []
    blocked = []
    for job_id in body.job_ids:
        try:
            job = store.get_job(job_id)
        except KeyError:
            blocked.append({"job_id": job_id, "reason": "Production job not found"})
            continue
        fields = set(body.updates)
        reason = None
        if job["status"] in {"submitting", "pending", "running", "ready", "published"}:
            reason = "Task parameters are frozen after media generation has started"
        elif job["status"] in {"planning", "awaiting_storyboard"} and fields & structural:
            reason = "Production mode, template, and model route freeze when storyboard planning starts"
        differences = [
            {"field": key, "before": job["request"].get(key), "after": value}
            for key, value in body.updates.items()
            if job["request"].get(key) != value
        ]
        item = {
            "job_id": job_id,
            "title": job.get("title") or job["topic"],
            "status": job["status"],
            "differences": differences,
            "redo_impact": (
                "render_and_media" if fields & structural else
                "audio_only" if fields & audio else
                "composition_only"
            ),
        }
        (blocked if reason else eligible).append({**item, **({"reason": reason} if reason else {})})
    return {
        "requested": len(body.job_ids),
        "updates": body.updates,
        "eligible": eligible,
        "blocked": blocked,
        "atomic": True,
    }


@router.post("/operations/restore/rehearsal")
def rehearse_restore(body: RestoreRehearsalRequest):
    try:
        return rehearse_production_restore(body.backup_path)
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.get("/search")
def global_production_search(
    q: Annotated[str, Query(min_length=2, max_length=200)],
    limit: Annotated[int, Query(ge=1, le=200)] = 80,
):
    needle = q.casefold().strip()
    results: list[dict[str, Any]] = []
    config = _config()
    for channel in config.channels:
        haystack = " ".join((channel.name, channel.id, channel.topic.prompt, *channel.topic.seeds))
        if needle in haystack.casefold():
            results.append({"type": "channel", "id": channel.id, "title": channel.name, "detail": channel.topic.prompt, "href": "#channels"})
    with _store() as store:
        for topic in store.list_topic_candidates(limit=1000):
            if needle in f"{topic['title']} {topic['topic']} {topic.get('source_label') or ''}".casefold():
                results.append({"type": "topic", "id": topic["id"], "title": topic["title"], "detail": topic["topic"], "href": "#topics"})
        for source in store.list_content_sources(limit=1000):
            if needle in f"{source['name']} {source['url']} {source.get('last_error') or ''}".casefold():
                results.append({"type": "source", "id": source["id"], "title": source["name"], "detail": source["url"], "href": "#sources"})
        for job in store.list_jobs(limit=1000):
            request_text = json.dumps(job.get("request") or {}, ensure_ascii=False)
            if needle in f"{job.get('title') or ''} {job['topic']} {job.get('error') or ''} {request_text}".casefold():
                results.append({"type": "video" if job["status"] in {"ready", "published"} else "job", "id": job["id"], "title": job.get("title") or job["topic"], "detail": job.get("error") or job["status"], "href": "#library" if job["status"] in {"ready", "published"} else "#queue"})
    return {"query": q, "results": results[:limit], "count": min(len(results), limit)}


@router.post("/jobs/batch/retry")
async def retry_production_jobs_batch(body: BatchJobRequest):
    """Retry a preflighted selection of failed jobs."""
    with _store() as store:
        impact = _batch_retry_preflight(store, body.job_ids)
        if impact["blocked"]:
            raise HTTPException(status_code=409, detail=impact)
        jobs = [await _retry_production_job(store, job_id) for job_id in body.job_ids]
    return {**impact, "completed": len(jobs), "jobs": jobs}


@router.post("/jobs/batch/delete/preview")
def preview_batch_job_delete(body: BatchJobRequest):
    """Aggregate exact ledger and file impact for a queue selection."""
    config = _config()
    with _store() as store:
        return _batch_delete_preflight(store, body.job_ids, config)


@router.delete("/jobs/batch")
def delete_production_jobs_batch(body: BatchJobDeleteRequest):
    """Atomically delete selected terminal jobs and permanently remove their files."""
    config = _config()
    with _store() as store:
        impact = _batch_delete_preflight(store, body.job_ids, config)
        if impact["blocked"]:
            raise HTTPException(status_code=409, detail=impact)
        try:
            result = store.delete_jobs_batch(body.job_ids)
        except (KeyError, ValueError) as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc

        removed_tasks = []
        for task_id in result["task_ids"]:
            try:
                if task_manager.remove_task(task_id):
                    removed_tasks.append(task_id)
            except ValueError as exc:
                raise HTTPException(status_code=409, detail=str(exc)) from exc
        deletion = _delete_managed_paths(
            result["paths"],
            result["task_ids"],
            config,
            "job-batch",
            uuid.uuid4().hex,
            delete_task_directories=True,
        )
    return {
        **impact,
        "deleted": len(body.job_ids),
        "counts": result["counts"],
        "removed_task_ids": removed_tasks,
        "file_deletion": deletion,
    }


def _batch_retry_preflight(store: ProductionStore, job_ids: list[str]) -> dict[str, Any]:
    eligible: list[dict[str, str]] = []
    blocked: list[dict[str, str]] = []
    for job_id in job_ids:
        try:
            job = store.get_job(job_id)
        except KeyError:
            blocked.append({"job_id": job_id, "reason": "Production job not found"})
            continue
        reason = None
        if job["status"] != "failed":
            reason = "Only failed jobs can be retried"
        else:
            task_id = job.get("api_task_id") or job.get("storyboard_task_id")
            task = task_manager.get_task(task_id) if task_id else None
            if task is not None and task.status != TaskStatus.FAILED:
                reason = "The linked API task is unavailable or not failed"
        target = {"job_id": job_id, "title": job.get("title") or job["topic"]}
        (blocked if reason else eligible).append(
            {**target, **({"reason": reason} if reason else {})}
        )
    return {
        "action": "retry",
        "requested": len(job_ids),
        "eligible": eligible,
        "blocked": blocked,
    }


def _batch_delete_preflight(
    store: ProductionStore,
    job_ids: list[str],
    config,
) -> dict[str, Any]:
    eligible: list[dict[str, Any]] = []
    blocked: list[dict[str, str]] = []
    counts: dict[str, int] = {}
    files_count = 0
    file_bytes = 0
    for job_id in job_ids:
        try:
            preview = _deletion_preview("job", job_id, store, config)
        except HTTPException as exc:
            blocked.append({"job_id": job_id, "reason": str(exc.detail)})
            continue
        target = {"job_id": job_id, "title": preview["label"]}
        if not preview["allowed"]:
            blocked.append({**target, "reason": preview["blocked_reason"]})
            continue
        eligible.append(target)
        files_count += preview["files_count"]
        file_bytes += preview["file_bytes"]
        for key, value in preview["counts"].items():
            counts[key] = counts.get(key, 0) + int(value)
    return {
        "action": "delete",
        "requested": len(job_ids),
        "eligible": eligible,
        "blocked": blocked,
        "counts": counts,
        "files_count": files_count,
        "file_bytes": file_bytes,
        "recoverable": False,
        "atomic_ledger": True,
    }


@router.post("/jobs/{job_id}/approve")
def approve_production_job(job_id: str, body: ReviewRequest | None = None):
    with _store() as store:
        try:
            job = store.get_job(job_id)
            blocker = _review_blocker(store, job, "approved")
            if blocker:
                raise ValueError(blocker)
            return store.review_job(job_id, "approved", body.note if body else None)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="Production job not found") from exc
        except (FileNotFoundError, ValueError) as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc


@router.post("/jobs/{job_id}/reject")
def reject_production_job(job_id: str, body: ReviewRequest):
    with _store() as store:
        try:
            return store.review_job(job_id, "rejected", body.note)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="Production job not found") from exc
        except ValueError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc


@router.post("/jobs/{job_id}/retry")
async def retry_production_job(job_id: str):
    with _store() as store:
        try:
            return await _retry_production_job(store, job_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="Production job not found") from exc
        except (RuntimeError, ValueError) as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc


async def _retry_production_job(store: ProductionStore, job_id: str) -> dict[str, Any]:
    job = store.get_job(job_id)
    if job["status"] != "failed":
        raise ValueError("Only failed jobs can be retried")
    task_id = job.get("api_task_id") or job.get("storyboard_task_id")
    if task_id:
        task = task_manager.get_task(task_id)
        if task is None:
            is_storyboard = job.get("storyboard_task_id") == task_id
            task_type = (
                TaskType.STORYBOARD_PLANNING
                if is_storyboard
                else TaskType.VIDEO_GENERATION
            )
            request_params = dict(job.get("request") or {})
            if not is_storyboard:
                request_params.setdefault("_request_base_url", "http://localhost:18123")
            task = task_manager.restore_missing_failed_task(
                task_id,
                task_type,
                request_params,
                idempotency_key=(
                    f"storyboard:{job_id}" if is_storyboard else f"production:{job_id}"
                ),
            )
        if (
            task is not None
            and task.task_type == TaskType.VIDEO_GENERATION
            and bool(job.get("request", {}).get("custom_script"))
        ):
            repaired_request = _repair_custom_script_request(job["request"])
            previous_params = task.request_params or {}
            if previous_params.get("_request_base_url"):
                repaired_request["_request_base_url"] = previous_params[
                    "_request_base_url"
                ]
            task_manager.replace_failed_task_request(task_id, repaired_request)
            job = store.update_job(job_id, request_json=repaired_request)
        accepted = await task_manager.retry_task(task_id)
        if not accepted:
            raise ValueError("The linked API task is unavailable or not failed")
        status = "planning" if job.get("storyboard_task_id") == task_id else "pending"
    else:
        status = "planned"
    return store.update_job(
        job_id,
        status=status,
        retries=job["retries"] + 1,
        error=None,
        review_status="not_ready",
        review_note=None,
        reviewed_at=None,
    )


def _repair_custom_script_request(request: dict[str, Any]) -> dict[str, Any]:
    """Migrate custom-script requests created before renderer overrides were frozen."""
    repaired = dict(request)
    mode = str(repaired.get("production_mode") or "native_image_html")
    engine = {
        "whiteboard_animation": "whiteboard_cv",
        "hyperframes": "hyperframes",
    }.get(mode, "native_image_html")
    version = {
        "whiteboard_animation": "whiteboard-cv-v1",
        "hyperframes": "0.8.4",
    }.get(mode, "native-image-html-v2")
    capability = "video" if mode == "direct_video" else "image"
    workflow = str(repaired.get("media_workflow") or "")
    if workflow in {"api/default/image", "api/default/video"}:
        selection = config_manager.resolve_model(capability)
        workflow = f"api/{selection['channel_id']}/{selection['model']}"

    native = {
        **dict(repaired.get("native") or {}),
        "image_motion": repaired.get("image_motion") or "ken_burns",
        "transition": repaired.get("transition") or "crossfade",
        "scene_direction": repaired.get("scene_direction") or "auto",
    }
    template_sha256 = None
    if engine == "whiteboard_cv":
        frame_template = None
        whiteboard = WhiteboardTemplateRegistry().resolve(repaired.get("whiteboard"))
        recipe = str(whiteboard["prompt_recipe"])
        current_prefix = str(repaired.get("prompt_prefix") or "").strip()
        if recipe not in current_prefix:
            repaired["prompt_prefix"] = " ".join(
                value
                for value in (
                    recipe,
                    "竖屏 9:16 构图，无文字、无 Logo、无水印，底部保留字幕安全区。",
                    current_prefix,
                )
                if value
            )
        repaired["whiteboard"] = whiteboard
    else:
        frame_template = str(
            repaired.get("frame_template")
            or config_manager.config.template.default_template
        )
        _, template_sha256 = resolve_template_fingerprint(frame_template)

    repaired.update(
        production_mode=mode,
        render_engine=engine,
        renderer_version=version,
        media_workflow=workflow,
        frame_template=frame_template,
        template_sha256=template_sha256,
        image_generation_concurrency=int(
            repaired.get("image_generation_concurrency") or 4
        ),
        native=native,
    )
    production = dict(repaired.get("_production") or {})
    rendering = {
        **dict(production.get("rendering") or {}),
        "mode": mode,
        "engine": engine,
        "renderer_version": version,
        "image_generation_concurrency": int(
            repaired.get("image_generation_concurrency") or 4
        ),
        "subtitle_effect": repaired.get("subtitle_effect") or "static",
        "template": {"path": frame_template, "sha256": template_sha256},
        "native": native,
        "hyperframes": dict(repaired.get("hyperframes") or {}),
    }
    if engine == "whiteboard_cv":
        rendering["whiteboard"] = dict(repaired.get("whiteboard") or {})
    else:
        rendering.pop("whiteboard", None)
    production["rendering"] = rendering
    repaired["_production"] = production
    return repaired


@router.post("/jobs/{job_id}/cancel")
def cancel_production_job(job_id: str):
    with _store() as store:
        try:
            job = store.get_job(job_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="Production job not found") from exc
        if job["status"] == "cancelled":
            return job
        if job["status"] not in {
            "planned",
            "planning",
            "awaiting_storyboard",
            "submitting",
            "pending",
            "running",
        }:
            raise HTTPException(status_code=409, detail="This job can no longer be cancelled")

        task_id = job.get("api_task_id") or job.get("storyboard_task_id")
        task = task_manager.get_task(task_id) if task_id else None
        active_status = job["status"] in {"planning", "submitting", "pending", "running"}
        if active_status and task is not None and not task_manager.cancel_task(task_id):
            raise HTTPException(status_code=409, detail="The linked API task is already terminal")
        return store.update_job(
            job_id,
            status="cancelled",
            review_status="not_ready",
            error="Cancelled from Production Desk",
            completed_at=_now_iso(),
        )


@router.post("/channels/{channel_id}/publish")
def mark_channel_published(channel_id: str, body: PublishRequest):
    config = _config()
    if channel_id not in {channel.id for channel in config.channels}:
        raise HTTPException(status_code=404, detail="Production channel not found")
    with _store() as store:
        jobs = store.mark_published(channel_id, body.count)
    if not jobs:
        raise HTTPException(status_code=409, detail="No approved videos are ready to publish")
    return {"jobs": jobs, "count": len(jobs)}


@router.post("/channels/{channel_id}/pause")
def pause_channel(channel_id: str):
    _require_channel(channel_id)
    with _store() as store:
        return store.set_channel_paused(channel_id, True)


@router.post("/channels/{channel_id}/resume")
def resume_channel(channel_id: str):
    _require_channel(channel_id)
    with _store() as store:
        return store.set_channel_paused(channel_id, False)


@router.get("/events")
async def production_events(request: Request):
    """Stream durable snapshots; clients may reconnect and refill over REST."""

    async def stream():
        last_payload = ""
        while not await request.is_disconnected():
            payload = json.dumps(production_status(), ensure_ascii=False, separators=(",", ":"))
            if payload != last_payload:
                yield f"event: production\ndata: {payload}\n\n"
                last_payload = payload
            else:
                yield ": keep-alive\n\n"
            await asyncio.sleep(3)

    return StreamingResponse(
        stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


def _require_channel(channel_id: str) -> None:
    if channel_id not in {channel.id for channel in _config().channels}:
        raise HTTPException(status_code=404, detail="Production channel not found")


def _get_channel(channel_id: str) -> ChannelConfig:
    channel = next((item for item in _config().channels if item.id == channel_id), None)
    if channel is None:
        raise HTTPException(status_code=404, detail="Production channel not found")
    return channel


def _validate_bindings_or_422(store: ProductionStore, channel: ChannelConfig) -> None:
    try:
        validate_channel_bindings(store, channel)
    except KeyError as exc:
        raise HTTPException(
            status_code=422,
            detail=f"Preset version does not exist or has the wrong type: {exc.args[0]}",
        ) from exc


def _validate_channel_config_or_422(channel: ChannelConfig) -> None:
    result = channel_semantic_gate(channel)
    if result["blocking"]:
        raise HTTPException(status_code=422, detail=result)


def _write_channel(
    directory: Path,
    channel: ChannelConfig,
    replace_id: str | None = None,
    expected_fingerprint: str | None = None,
) -> None:
    directory = directory.expanduser().resolve()
    lock_id = replace_id or channel.id
    with _channel_write_guard(directory, lock_id):
        directory.mkdir(parents=True, exist_ok=True)
        target = _find_channel_path(directory, lock_id)
        if target is None:
            target = directory / f"{channel.id}.yaml"
        if expected_fingerprint is not None:
            actual_fingerprint = _channel_path_fingerprint(target)
            if actual_fingerprint != expected_fingerprint:
                raise ValueError(
                    "Channel configuration changed concurrently; reload before saving"
                )
        temporary = directory / f".{channel.id}.{uuid.uuid4().hex}.yaml.tmp"
        try:
            temporary.write_text(
                yaml.safe_dump(channel.model_dump(), allow_unicode=True, sort_keys=False),
                encoding="utf-8",
            )
            temporary.replace(target)
        finally:
            temporary.unlink(missing_ok=True)


@contextmanager
def _channel_write_guard(directory: Path, channel_id: str):
    key = f"{directory.expanduser().resolve()}::{channel_id}"
    with _channel_locks_guard:
        lock = _channel_locks.setdefault(key, threading.RLock())
    with lock:
        yield


def _channel_path_fingerprint(path: Path) -> str:
    if not path.is_file():
        return "missing"
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _find_channel_path(directory: Path, channel_id: str) -> Path | None:
    for path in sorted(directory.glob("*.y*ml")):
        raw = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
        if raw.get("id") == channel_id:
            return path
    return None


def _deep_merge(current: dict[str, Any], updates: dict[str, Any]) -> dict[str, Any]:
    merged = dict(current)
    for key, value in updates.items():
        if isinstance(value, dict) and isinstance(merged.get(key), dict):
            merged[key] = _deep_merge(merged[key], value)
        else:
            merged[key] = value
    return merged


def _deletion_preview(resource: str, target_id: str, store: ProductionStore, config):
    allowed_resources = {
        "job",
        "topic",
        "source",
        "channel",
        "assistant-thread",
        "revision",
        "scene",
    }
    if resource not in allowed_resources:
        raise HTTPException(status_code=404, detail="Unsupported delete resource")
    try:
        blocked_reason = None
        paths: list[str] = []
        task_ids: list[str] = []
        if resource == "job":
            context = store.inspect_job_deletion(target_id)
            job = context["job"]
            label = job.get("title") or job["topic"]
            counts = context["counts"]
            paths = context["paths"]
            task_ids = context["task_ids"]
            if job["status"] in {
                "planned",
                "planning",
                "awaiting_storyboard",
                "submitting",
                "pending",
                "running",
            }:
                blocked_reason = "请先取消仍在生产中的任务，再执行整体删除"
            consequences = [
                "删除生产记录、项目、全部版本、分镜、质检和异步任务记录",
                "已消费的选题会恢复为已通过，可再次进入生产",
                "对应 output 与 temp 任务目录及其中全部文件会被永久删除且不可恢复",
            ]
        elif resource == "topic":
            candidate = store.get_topic_candidate(target_id)
            label = candidate["title"]
            counts = {"topics": 1}
            if candidate["status"] == "consumed" or candidate.get("consumed_job_id"):
                blocked_reason = "该选题已生成视频，请先删除对应视频"
            consequences = ["删除候选、评分、语义向量和标题实验", "其他候选对它的重复关联会被清除"]
        elif resource == "source":
            source = store.get_content_source(target_id)
            label = source["name"]
            counts = {"sources": 1, "source_items": source["item_count"]}
            task_ids = [source["last_task_id"]] if source.get("last_task_id") else []
            if source["state"] in {"queued", "polling"}:
                blocked_reason = "该来源正在采集，请等待任务结束后删除"
            consequences = ["删除来源配置和已采集素材索引", "已经生成的选题候选会保留"]
        elif resource == "channel":
            channel = next((item for item in config.channels if item.id == target_id), None)
            if channel is None:
                raise KeyError(target_id)
            label = channel.name
            counts = {"channels": 1, **store.channel_dependencies(target_id)}
            dependencies = sum(counts[key] for key in ("jobs", "topics", "sources", "projects"))
            if len(config.channels) <= 1:
                blocked_reason = "至少需要保留一个频道配置"
            elif dependencies:
                blocked_reason = "频道仍有关联任务、选题或内容源，请先逐项清空"
            consequences = ["频道 YAML 将被永久删除", "Runner 下一轮热加载后停止管理该频道"]
        elif resource == "assistant-thread":
            context = store.inspect_assistant_thread_deletion(target_id)
            label = context["thread"]["title"]
            counts = context["counts"]
            if context["executing"]:
                blocked_reason = "该制片任务仍有计划正在执行"
            consequences = ["删除本任务的对话、计划和审批审计", "已经执行的生产修改不会回滚"]
        elif resource == "revision":
            context = store.inspect_revision_deletion(target_id)
            revision = context["revision"]
            label = f"V{revision['number']} · {revision.get('note') or '未命名版本'}"
            counts = context["counts"]
            paths = context["paths"]
            task_ids = context["task_ids"]
            if context["project"] and context["project"]["current_revision_id"] == target_id:
                blocked_reason = "当前启用版本不能删除，请先切换到其他版本"
            elif context["revision_count"] <= 1:
                blocked_reason = "项目必须至少保留一个版本"
            elif revision.get("repair_status") in {"planned", "pending", "running"}:
                blocked_reason = "版本正在自动修复，暂不能删除"
            elif any(
                scene.get("regeneration_status") in {"pending", "running"}
                for scene in revision["scenes"]
            ):
                blocked_reason = "版本中仍有镜头正在生成"
            consequences = ["删除该版本的全部分镜、素材和质检", "其他版本与项目主记录继续保留"]
        else:
            context = store.inspect_scene_deletion(target_id)
            scene = context["scene"]
            label = f"第 {int(scene['position']) + 1} 镜"
            counts = context["counts"]
            paths = context["paths"]
            task_ids = context["task_ids"]
            if context["revision"]["status"] != "draft":
                blocked_reason = "只能删除草稿版本中的镜头"
            elif scene["locked"]:
                blocked_reason = "请先解锁该镜头"
            elif context["scene_count"] <= 1:
                blocked_reason = "一个版本至少需要保留一个镜头"
            elif scene.get("regeneration_status") in {"pending", "running"}:
                blocked_reason = "该镜头正在生成，暂不能删除"
            consequences = [
                "删除镜头文字与生成素材，并自动重排后续镜头",
                "版本质量状态会变为待重检",
            ]

        active_tasks = _active_task_ids(task_ids)
        if active_tasks and not blocked_reason:
            blocked_reason = f"仍有异步任务运行中：{'、'.join(active_tasks)}"
        existing_files: set[str] = set()
        total_bytes = 0
        for value in paths:
            path = Path(value).expanduser()
            if path.is_file():
                resolved = str(path.resolve())
                if resolved not in existing_files:
                    existing_files.add(resolved)
                    total_bytes += path.stat().st_size
        if resource == "job":
            for directory in _job_task_directories(paths, task_ids, config):
                if not directory.is_dir():
                    continue
                for path in directory.rglob("*"):
                    if not path.is_file():
                        continue
                    resolved = str(path.resolve())
                    if resolved not in existing_files:
                        existing_files.add(resolved)
                        total_bytes += path.stat().st_size
        return {
            "resource": resource,
            "id": target_id,
            "label": label,
            "allowed": blocked_reason is None,
            "blocked_reason": blocked_reason,
            "counts": counts,
            "consequences": consequences,
            "files_count": len(existing_files),
            "file_bytes": total_bytes,
            "recoverable": False,
        }
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="Delete target not found") from exc


def _delete_resource(resource: str, target_id: str, store: ProductionStore, config):
    if resource == "job":
        return store.delete_job(target_id)
    if resource == "topic":
        return store.delete_topic_candidate(target_id)
    if resource == "source":
        return store.delete_content_source(target_id)
    if resource == "assistant-thread":
        return store.delete_assistant_thread(target_id)
    if resource == "revision":
        return store.delete_revision(target_id)
    if resource == "scene":
        return store.delete_scene(target_id)
    if resource == "channel":
        if len(config.channels) <= 1:
            raise ValueError("At least one channel configuration must remain")
        path = _find_channel_path(Path(config.channels_dir), target_id)
        if path is None:
            raise KeyError(target_id)
        dependencies = store.channel_dependencies(target_id)
        if sum(dependencies.values()):
            raise ValueError("Channel still has related production data")
        store.delete_channel_state(target_id)
        return {
            "channel_path": str(path),
            "counts": {"channels": 1, **dependencies},
        }
    raise KeyError(resource)


def _active_task_ids(task_ids: list[str]) -> list[str]:
    active = []
    for task_id in task_ids:
        task = task_manager.get_task(task_id)
        if task and task.status in {TaskStatus.PENDING, TaskStatus.RUNNING}:
            active.append(task_id)
    return active


def _delete_managed_paths(
    paths: list[str],
    task_ids: list[str],
    config,
    resource: str,
    target_id: str,
    *,
    delete_task_directories: bool = False,
):
    """Permanently remove owned files and task-scoped output/temp directories."""
    database_parent = Path(config.database_path).expanduser().resolve().parent
    runtime_root = Path(get_pixelle_video_root_path()).expanduser().resolve()
    media_roots = _managed_media_roots(config, runtime_root=runtime_root)
    allowed_roots = list(
        dict.fromkeys(
            [
                database_parent,
                Path(config.channels_dir).expanduser().resolve(),
                *media_roots,
            ]
        )
    )
    resolved_paths: list[Path] = []
    skipped: list[dict[str, str]] = []
    for raw in dict.fromkeys(paths):
        if not raw or raw.startswith(("http://", "https://")):
            continue
        source = Path(raw).expanduser()
        if not source.is_absolute():
            source = (runtime_root / source).resolve()
        else:
            source = source.resolve()
        root = next((item for item in allowed_roots if source.is_relative_to(item)), None)
        if root is None:
            skipped.append({"path": str(source), "reason": "outside managed roots"})
            continue
        resolved_paths.append(source)

    task_directories = (
        _job_task_directories(
            [str(path) for path in resolved_paths],
            task_ids,
            config,
            runtime_root=runtime_root,
        )
        if delete_task_directories
        else set()
    )

    deleted_directories: list[str] = []
    deleted_files: list[str] = []
    deleted_bytes = 0
    for directory in sorted(task_directories, key=lambda item: len(item.parts), reverse=True):
        if directory.parent not in media_roots:
            skipped.append(
                {"path": str(directory), "reason": "not a managed output/temp task directory"}
            )
            continue
        if not directory.exists():
            continue
        try:
            deleted_bytes += sum(
                item.stat().st_size for item in directory.rglob("*") if item.is_file()
            )
            shutil.rmtree(directory)
            deleted_directories.append(str(directory))
        except OSError as exc:
            skipped.append({"path": str(directory), "reason": str(exc)})

    for source in resolved_paths:
        if any(source == directory or source.is_relative_to(directory) for directory in task_directories):
            continue
        if not source.exists():
            continue
        if not source.is_file():
            skipped.append({"path": str(source), "reason": "managed path is not a file"})
            continue
        try:
            deleted_bytes += source.stat().st_size
            source.unlink()
            deleted_files.append(str(source))
        except OSError as exc:
            skipped.append({"path": str(source), "reason": str(exc)})
    return {
        "resource": resource,
        "id": target_id,
        "directories": deleted_directories,
        "files": deleted_files,
        "bytes": deleted_bytes,
        "skipped": skipped,
        "permanent": True,
    }


def _merge_deletion_results(*results: dict[str, Any]) -> dict[str, Any]:
    return {
        "directories": [item for result in results for item in result.get("directories", [])],
        "files": [item for result in results for item in result.get("files", [])],
        "bytes": sum(int(result.get("bytes") or 0) for result in results),
        "skipped": [item for result in results for item in result.get("skipped", [])],
        "permanent": True,
    }


def _managed_media_roots(config, *, runtime_root: Path | None = None) -> list[Path]:
    """Return every supported output/temp root without relying on process cwd."""
    root = runtime_root or Path(get_pixelle_video_root_path()).expanduser().resolve()
    database_parent = Path(config.database_path).expanduser().resolve().parent
    database_runtime_root = (
        database_parent.parent if database_parent.name == "data" else database_parent
    )
    return list(
        dict.fromkeys(
            [
                (root / "output").resolve(),
                (root / "temp").resolve(),
                (database_runtime_root / "output").resolve(),
                (database_runtime_root / "temp").resolve(),
            ]
        )
    )


def _job_task_directories(
    paths: list[str],
    task_ids: list[str],
    config,
    *,
    runtime_root: Path | None = None,
) -> set[Path]:
    """Resolve only direct task children of managed output/temp roots."""
    root = runtime_root or Path(get_pixelle_video_root_path()).expanduser().resolve()
    media_roots = _managed_media_roots(config, runtime_root=root)
    output_roots = {item for item in media_roots if item.name == "output"}
    directory_ids = {
        task_id
        for task_id in task_ids
        if re.fullmatch(r"[a-zA-Z0-9_-]+", task_id or "")
    }
    directories: set[Path] = set()
    for raw in paths:
        if not raw or raw.startswith(("http://", "https://")):
            continue
        source = Path(raw).expanduser()
        source = source.resolve() if source.is_absolute() else (root / source).resolve()
        for media_root in media_roots:
            if not source.is_relative_to(media_root):
                continue
            relative = source.relative_to(media_root)
            if not relative.parts:
                continue
            task_directory = (media_root / relative.parts[0]).resolve()
            if task_directory.parent != media_root:
                continue
            if len(relative.parts) > 1 or task_directory.is_dir():
                directories.add(task_directory)
                if media_root in output_roots:
                    directory_ids.add(relative.parts[0])
            break

    for directory_id in directory_ids:
        for media_root in media_roots:
            candidate = (media_root / directory_id).resolve()
            if candidate.parent == media_root:
                directories.add(candidate)
    return directories


def _now_iso() -> str:
    from datetime import datetime, timezone

    return datetime.now(timezone.utc).isoformat()


def _today(timezone_name: str) -> str:
    from datetime import datetime
    from zoneinfo import ZoneInfo

    return datetime.now(ZoneInfo(timezone_name)).date().isoformat()
