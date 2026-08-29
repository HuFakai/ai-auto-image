"""Render two revisions from frozen, identical image and narration assets."""

from __future__ import annotations

from dataclasses import asdict
from datetime import datetime
from pathlib import Path
from typing import Any, Callable

from loguru import logger

from pixelle_video.models.storyboard import Storyboard, StoryboardConfig, StoryboardFrame
from pixelle_video.rendering.subtitle_effects import (
    normalize_subtitle_effect,
    resolve_native_subtitle_effect,
)
from pixelle_video.rendering_versions import (
    HYPERFRAMES_RENDERER_VERSION,
    NATIVE_RENDERER_VERSION,
    WHITEBOARD_RENDERER_VERSION,
)
from pixelle_video.services.video import VideoService
from pixelle_video.utils.os_util import get_task_final_video_path, get_task_path

from .quality import inspect_subtitle_layout, inspect_video
from .regeneration import _write_revision_storyboard
from .store import ProductionStore

VariantProgress = Callable[[float, str], None]


async def render_revision_variant(
    store: ProductionStore,
    revision_id: str,
    task_id: str,
    core: Any,
    progress: VariantProgress | None = None,
) -> dict[str, Any]:
    """Render a prepared variant without invoking TTS or media generation."""
    store.set_renderer_variant_status(revision_id, task_id, "running")
    try:
        revision = store.get_revision(revision_id)
        project = store.get_project(revision["project_id"])
        job = store.get_job(project["job_id"])
        raw = {**(job.get("request") or {}), **(revision.get("config") or {})}
        engine = revision.get("render_engine") or raw.get("render_engine")
        if engine not in {"native_image_html", "hyperframes", "whiteboard_cv"}:
            raise ValueError(f"Unsupported renderer variant: {engine}")
        config = _storyboard_config(raw, task_id, len(revision["scenes"]), engine)
        frames = [_storyboard_frame(scene) for scene in revision["scenes"]]
        storyboard = Storyboard(
            title=project["title"],
            config=config,
            frames=frames,
            created_at=datetime.now(),
        )
        _report(progress, 3, "正在校验同素材快照")
        _validate_frozen_assets(frames)

        manifest_path = None
        check_report_path = None
        if engine in {"native_image_html", "whiteboard_cv"}:
            final_path = await _render_native(
                storyboard,
                core,
                raw,
                progress,
            )
        else:
            final_path, manifest_path, check_report_path = await _render_hyperframes(
                storyboard,
                raw,
                progress,
            )

        _report(progress, 94, "正在执行成片技术质检")
        checks = inspect_video(
            final_path,
            expected_duration=sum(frame.duration for frame in storyboard.frames) or None,
            deep=True,
        )
        if engine in {"native_image_html", "whiteboard_cv"}:
            checks.append(
                inspect_subtitle_layout(
                    [
                        {"index": frame.index, "composed_image_path": frame.composed_image_path}
                        for frame in storyboard.frames
                    ]
                )
            )
        config_payload = {**raw, **asdict(config)}
        completed = store.complete_renderer_variant(
            revision_id,
            task_id,
            [_frame_payload(frame) for frame in storyboard.frames],
            final_path,
            config_payload,
            checks,
            hyperframes_manifest_path=manifest_path,
            check_report_path=check_report_path,
        )
        _write_revision_storyboard(
            task_id,
            project,
            completed,
            final_path,
        )
        _report(progress, 100, "同素材渲染版本已完成")
        logger.success("Rendered {} variant {} from frozen assets", engine, revision_id)
        return {
            "project_id": project["id"],
            "revision_id": revision_id,
            "render_engine": engine,
            "video_path": final_path,
            "quality_status": completed["quality_status"],
        }
    except Exception as exc:
        store.set_renderer_variant_status(revision_id, task_id, "failed", str(exc))
        raise


async def _render_native(
    storyboard: Storyboard,
    core: Any,
    raw: dict[str, Any],
    progress: VariantProgress | None,
) -> str:
    total = len(storyboard.frames)
    for index, frame in enumerate(storyboard.frames):
        _report(progress, 8 + index / max(total, 1) * 70, f"原生合成第 {index + 1}/{total} 镜")
        storyboard.frames[index] = await core.frame_processor(
            frame=frame,
            storyboard=storyboard,
            config=storyboard.config,
            total_frames=total,
        )
    segment_paths = [frame.video_segment_path for frame in storyboard.frames]
    if any(not path or not Path(path).is_file() for path in segment_paths):
        raise FileNotFoundError("Native variant did not produce every scene segment")
    final_path = get_task_final_video_path(storyboard.config.task_id or "")
    Path(final_path).parent.mkdir(parents=True, exist_ok=True)
    _report(progress, 82, "正在拼接原生镜头")
    VideoService().concat_videos(
        videos=[str(path) for path in segment_paths],
        output=final_path,
        bgm_path=raw.get("bgm_path"),
        bgm_volume=float(raw.get("bgm_volume") or 0.2),
        bgm_mode=raw.get("bgm_mode") or "loop",
        transition=[frame.transition or "none" for frame in storyboard.frames[1:]],
        transition_duration=[
            float(frame.transition_duration or 0.35) for frame in storyboard.frames[1:]
        ],
    )
    return final_path


async def _render_hyperframes(
    storyboard: Storyboard,
    raw: dict[str, Any],
    progress: VariantProgress | None,
) -> tuple[str, str, str | None]:
    from pixelle_video.services.hyperframes_process import hyperframes_process_manager
    from pixelle_video.services.hyperframes_project import HyperFramesProjectBuilder
    from pixelle_video.services.hyperframes_renderer import HyperFramesRendererAdapter

    settings = dict(raw.get("hyperframes") or {})
    _report(progress, 8, "正在构建 HyperFrames 同素材工程")
    build = HyperFramesProjectBuilder().build(
        storyboard,
        get_task_path(storyboard.config.task_id or ""),
        bgm_path=raw.get("bgm_path"),
        bgm_volume=float(raw.get("bgm_volume") or 0.2),
        template_id=str(
            settings.get("template_id") or raw.get("hyperframes_template_id") or "knowledge-card"
        ),
        template_version=int(
            settings.get("template_version") or raw.get("hyperframes_template_version") or 1
        ),
        template_variables=dict(
            settings.get("variables") or raw.get("hyperframes_template_variables") or {}
        ),
    )
    storyboard.config.hyperframes_project_path = build.project_dir
    storyboard.config.hyperframes_manifest_path = build.manifest_path
    storyboard.config.hyperframes_template_id = build.template_id
    storyboard.config.hyperframes_template_version = build.template_version
    storyboard.config.hyperframes_template_fingerprint = build.template_fingerprint
    storyboard.config.hyperframes_template_variables = build.template_variables
    adapter = HyperFramesRendererAdapter(
        base_url=settings.get("renderer_url"),
        render_timeout=float(settings.get("render_timeout") or 1800),
    )
    try:
        await adapter.ready()
    except Exception:
        if settings.get("renderer_url"):
            raise
        await hyperframes_process_manager.ensure_started()
        await adapter.ready()
    final_path = get_task_final_video_path(storyboard.config.task_id or "")
    submitted = await adapter.submit(
        build.project_dir,
        output_path=final_path,
        fps=storyboard.config.video_fps,
        quality=str(settings.get("quality") or "standard"),
        strictness=str(settings.get("strictness") or "strict"),
        workers=settings.get("workers"),
        use_gpu=bool(settings.get("use_gpu", True)),
    )
    storyboard.config.hyperframes_render_id = str(submitted["id"])

    def renderer_progress(value: float, stage: str, message: str) -> None:
        _report(progress, 12 + min(max(value, 0), 100) / 100 * 78, message or stage)

    result = await adapter.wait(storyboard.config.hyperframes_render_id, renderer_progress)
    if not Path(result.output_path).is_file() or result.size_bytes <= 0:
        raise RuntimeError("HyperFrames variant completed without a non-empty video")
    report = result.check_report_path or str(Path(build.project_dir) / "check-report.json")
    storyboard.config.hyperframes_check_report_path = report if Path(report).is_file() else None
    return result.output_path, build.manifest_path, storyboard.config.hyperframes_check_report_path


def _storyboard_config(
    raw: dict[str, Any],
    task_id: str,
    scene_count: int,
    engine: str,
) -> StoryboardConfig:
    requested_subtitle_effect = normalize_subtitle_effect(raw.get("subtitle_effect"))
    native_subtitle = resolve_native_subtitle_effect(requested_subtitle_effect)
    return StoryboardConfig(
        media_width=int(raw.get("media_width") or 1024),
        media_height=int(raw.get("media_height") or 1024),
        task_id=task_id,
        n_storyboard=scene_count,
        min_narration_words=int(raw.get("min_narration_words") or 5),
        max_narration_words=int(raw.get("max_narration_words") or 20),
        min_image_prompt_words=int(raw.get("min_image_prompt_words") or 30),
        max_image_prompt_words=int(raw.get("max_image_prompt_words") or 60),
        video_fps=int(raw.get("video_fps") or 30),
        render_engine=engine,
        renderer_version=(
            NATIVE_RENDERER_VERSION
            if engine == "native_image_html"
            else WHITEBOARD_RENDERER_VERSION
            if engine == "whiteboard_cv"
            else HYPERFRAMES_RENDERER_VERSION
        ),
        image_motion=raw.get("image_motion") or "none",
        transition=raw.get("transition") or "none",
        transition_duration=float(raw.get("transition_duration") or 0.35),
        subtitle_effect=requested_subtitle_effect,
        subtitle_effect_applied=(
            requested_subtitle_effect if engine == "hyperframes" else native_subtitle.applied
        ),
        subtitle_effect_fallback_reason=(
            None if engine == "hyperframes" else native_subtitle.fallback_reason
        ),
        voice_id=raw.get("voice_id"),
        tts_speed=raw.get("tts_speed"),
        voice_volume=float(raw.get("voice_volume", 1.0)),
        media_workflow=raw.get("media_workflow"),
        api_video_params=raw.get("api_video_params"),
        frame_template=(
            None
            if engine == "whiteboard_cv"
            else raw.get("frame_template") or "1080x1920/image_default.html"
        ),
        template_sha256=raw.get("template_sha256"),
        template_snapshot_path=raw.get("template_snapshot_path"),
        template_params=raw.get("template_params"),
        whiteboard=raw.get("whiteboard"),
    )


def _storyboard_frame(scene: dict[str, Any]) -> StoryboardFrame:
    return StoryboardFrame(
        index=int(scene["position"]),
        narration=scene["narration"],
        image_prompt=scene["visual_prompt"],
        audio_path=scene.get("audio_path"),
        media_type="image",
        image_path=scene.get("media_path"),
        duration=float(scene.get("duration") or 0),
        image_motion=scene.get("image_motion"),
        transition=scene.get("transition"),
        transition_duration=scene.get("transition_duration"),
        direction_reason=scene.get("direction_reason"),
        subtitle_effect=scene.get("subtitle_effect"),
        subtitle_keywords=list(scene.get("subtitle_keywords") or []),
        subtitle_start_offset=float(scene.get("subtitle_start_offset") or 0),
        subtitle_end_offset=float(scene.get("subtitle_end_offset") or 0),
        focus_x=scene.get("focus_x"),
        focus_y=scene.get("focus_y"),
        focus_confidence=scene.get("focus_confidence"),
        focus_source=scene.get("focus_source"),
    )


def _validate_frozen_assets(frames: list[StoryboardFrame]) -> None:
    for frame in frames:
        if not frame.image_path or not Path(frame.image_path).is_file():
            raise FileNotFoundError(f"Scene {frame.index + 1} image asset is unavailable")
        if not frame.audio_path or not Path(frame.audio_path).is_file():
            raise FileNotFoundError(f"Scene {frame.index + 1} audio asset is unavailable")


def _frame_payload(frame: StoryboardFrame) -> dict[str, Any]:
    return {
        "duration": frame.duration,
        "composed_image_path": frame.composed_image_path,
        "overlay_image_path": frame.overlay_image_path,
        "subtitle_overlay_path": frame.subtitle_overlay_path,
        "segment_path": frame.video_segment_path,
        "whiteboard_silent_path": frame.whiteboard_silent_path,
        "whiteboard_analysis_path": frame.whiteboard_analysis_path,
        "subtitle_effect": frame.subtitle_effect,
        "subtitle_effect_applied": frame.subtitle_effect_applied,
        "subtitle_effect_fallback_reason": frame.subtitle_effect_fallback_reason,
        "subtitle_keywords": list(frame.subtitle_keywords),
        "subtitle_start_offset": frame.subtitle_start_offset,
        "subtitle_end_offset": frame.subtitle_end_offset,
    }


def _report(callback: VariantProgress | None, value: float, message: str) -> None:
    if callback:
        callback(min(max(value, 0), 100), message)
