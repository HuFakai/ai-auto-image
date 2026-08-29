"""Isolated scene regeneration and revision-level recomposition."""

from __future__ import annotations

import json
import subprocess
from datetime import datetime
from pathlib import Path
from typing import Any, Callable

from loguru import logger

from pixelle_video.models.storyboard import Storyboard, StoryboardConfig, StoryboardFrame
from pixelle_video.rendering.subtitle_effects import resolve_native_subtitle_effect
from pixelle_video.services.video import VideoService
from pixelle_video.utils.os_util import get_task_final_video_path, get_task_path

from .quality import inspect_subtitle_layout, inspect_video
from .store import ProductionStore


async def regenerate_scene(
    store: ProductionStore,
    scene_id: str,
    task_id: str,
    scope: str,
    core: Any,
    preserve_style: bool = True,
    quality_inspector: Callable[..., list[dict[str, Any]]] = inspect_video,
    video_service: VideoService | None = None,
    output_dir: str | Path | None = None,
) -> dict[str, Any]:
    """Regenerate one scene and only replace artifacts after recomposition succeeds."""
    store.set_scene_regeneration_status(scene_id, task_id, "running")
    try:
        context = store.get_scene_context(scene_id)
        scene = context["scene"]
        revision = context["revision"]
        project = context["project"]
        job = context["job"]
        _validate_revision_inputs(revision, scene_id)

        raw_config = {**(job.get("request") or {}), **(revision.get("config") or {})}
        api_video_params = dict(raw_config.get("api_video_params") or {})
        if preserve_style and scope in {"full", "visual"} and scene.get("media_path"):
            reference = _prepare_style_reference(
                scene["media_path"], task_id, output_dir=output_dir
            )
            if reference:
                api_video_params["reference_image_paths"] = [reference]

        native_subtitle = resolve_native_subtitle_effect(raw_config.get("subtitle_effect"))
        config = StoryboardConfig(
            task_id=task_id,
            n_storyboard=len(revision["scenes"]),
            min_narration_words=int(raw_config.get("min_narration_words") or 5),
            max_narration_words=int(raw_config.get("max_narration_words") or 20),
            min_image_prompt_words=int(raw_config.get("min_image_prompt_words") or 30),
            max_image_prompt_words=int(raw_config.get("max_image_prompt_words") or 60),
            video_fps=int(raw_config.get("video_fps") or 30),
            render_engine=raw_config.get("render_engine") or "native_image_html",
            renderer_version=raw_config.get("renderer_version")
            or "native-image-html-v1",
            image_motion=raw_config.get("image_motion") or "none",
            transition=raw_config.get("transition") or "none",
            transition_duration=float(raw_config.get("transition_duration") or 0.35),
            subtitle_effect=native_subtitle.requested,
            subtitle_effect_applied=native_subtitle.applied,
            subtitle_effect_fallback_reason=native_subtitle.fallback_reason,
            voice_id=raw_config.get("voice_id"),
            tts_speed=raw_config.get("tts_speed"),
            voice_volume=float(raw_config.get("voice_volume", 1.0)),
            media_width=int(raw_config.get("media_width") or 512),
            media_height=int(raw_config.get("media_height") or 288),
            media_workflow=raw_config.get("media_workflow"),
            api_video_params=api_video_params,
            frame_template=(
                None
                if raw_config.get("render_engine") == "whiteboard_cv"
                else raw_config.get("frame_template") or "1080x1920/video_default.html"
            ),
            template_sha256=raw_config.get("template_sha256"),
            template_snapshot_path=raw_config.get("template_snapshot_path"),
            template_params=raw_config.get("template_params"),
            whiteboard=raw_config.get("whiteboard"),
        )
        frame = _build_target_frame(scene, scope)
        storyboard = Storyboard(
            title=project["title"],
            config=config,
            frames=[frame],
            created_at=datetime.now(),
        )

        processed = await core.frame_processor(
            frame=frame,
            storyboard=storyboard,
            config=config,
            total_frames=len(revision["scenes"]),
        )
        segment_paths = [
            processed.video_segment_path if item["id"] == scene_id else item["segment_path"]
            for item in revision["scenes"]
        ]
        if any(not path or not Path(path).is_file() for path in segment_paths):
            raise FileNotFoundError(
                "Every revision scene must have a rendered segment before recomposition"
            )

        service = video_service or VideoService()
        final_path = (
            str(Path(output_dir).expanduser().resolve() / task_id / "final.mp4")
            if output_dir
            else get_task_final_video_path(task_id)
        )
        Path(final_path).parent.mkdir(parents=True, exist_ok=True)
        total_duration = sum(
            processed.duration if item["id"] == scene_id else float(item.get("duration") or 0)
            for item in revision["scenes"]
        )
        service.concat_videos(
            videos=segment_paths,
            output=final_path,
            bgm_path=raw_config.get("bgm_path"),
            bgm_volume=float(raw_config.get("bgm_volume") or 0.2),
            bgm_mode=raw_config.get("bgm_mode") or "loop",
            transition=[
                item.get("transition") or config.transition
                for item in revision["scenes"][1:]
            ],
            transition_duration=[
                float(
                    item.get("transition_duration")
                    if item.get("transition_duration") is not None
                    else config.transition_duration
                )
                for item in revision["scenes"][1:]
            ],
        )
        checks = quality_inspector(
            final_path,
            expected_duration=total_duration or None,
            deep=True,
        )
        layout_frames = []
        for offset, item in enumerate(revision["scenes"]):
            overlay_path = processed.composed_image_path if item["id"] == scene_id else next(
                (
                    artifact["path"]
                    for artifact in item.get("artifacts", [])
                    if artifact["kind"] == "overlay"
                ),
                None,
            )
            layout_frames.append({"index": offset, "composed_image_path": overlay_path})
        if any(frame.get("composed_image_path") for frame in layout_frames):
            checks.append(inspect_subtitle_layout(layout_frames))
        frame_payload = {
            "audio_path": processed.audio_path,
            "media_path": processed.video_path or processed.image_path,
            "media_type": processed.media_type,
            "composed_image_path": processed.composed_image_path,
            "overlay_image_path": processed.overlay_image_path,
            "subtitle_overlay_path": processed.subtitle_overlay_path,
            "segment_path": processed.video_segment_path,
            "duration": processed.duration,
            "image_motion": processed.image_motion,
            "transition": processed.transition,
            "transition_duration": processed.transition_duration,
            "direction_reason": processed.direction_reason,
            "subtitle_effect": processed.subtitle_effect,
            "subtitle_effect_applied": processed.subtitle_effect_applied,
            "subtitle_effect_fallback_reason": processed.subtitle_effect_fallback_reason,
            "subtitle_keywords": list(processed.subtitle_keywords),
            "subtitle_start_offset": processed.subtitle_start_offset,
            "subtitle_end_offset": processed.subtitle_end_offset,
            "focus_x": processed.focus_x,
            "focus_y": processed.focus_y,
            "focus_confidence": processed.focus_confidence,
            "focus_source": processed.focus_source,
            "total_duration": total_duration,
        }
        metadata = {
            "config": {"llm_model": "grok-4.5"},
            "input": {
                **raw_config,
                "scope": scope,
                "preserve_style": preserve_style,
                "scene_id": scene_id,
            },
        }
        completed = store.complete_scene_regeneration(
            scene_id,
            task_id,
            frame_payload,
            final_path,
            checks,
            metadata,
        )
        _write_revision_storyboard(
            task_id,
            completed["project"],
            completed["revision"],
            final_path,
            output_dir=output_dir,
        )
        logger.success(f"Regenerated scene {scene_id} and recomposed {final_path}")
        return {
            "scene_id": scene_id,
            "revision_id": revision["id"],
            "project_id": project["id"],
            "video_path": final_path,
            "quality_status": completed["revision"]["quality_status"],
        }
    except Exception as exc:
        store.set_scene_regeneration_status(scene_id, task_id, "failed", str(exc))
        raise


def _build_target_frame(scene: dict[str, Any], scope: str) -> StoryboardFrame:
    media_path = scene.get("media_path")
    is_image = bool(
        media_path and Path(media_path).suffix.lower() in {".png", ".jpg", ".jpeg", ".webp"}
    )
    keep_audio = scope in {"visual", "composition"}
    keep_media = scope in {"voice", "composition"}
    return StoryboardFrame(
        index=int(scene["position"]),
        narration=scene["narration"],
        image_prompt=None if keep_media else scene["visual_prompt"],
        audio_path=scene.get("audio_path") if keep_audio else None,
        media_type=("image" if is_image else "video") if keep_media else None,
        image_path=media_path if keep_media and is_image else None,
        video_path=media_path if keep_media and not is_image else None,
        duration=float(scene.get("duration") or 0) if keep_audio else 0,
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


def _validate_revision_inputs(revision: dict[str, Any], scene_id: str) -> None:
    if revision["status"] != "draft":
        raise ValueError("Only draft revisions can regenerate scenes")
    for scene in revision["scenes"]:
        if scene["id"] == scene_id:
            continue
        path = scene.get("segment_path")
        if not path or not Path(path).is_file():
            raise FileNotFoundError(
                f"Scene {scene['position'] + 1} has no rendered segment; regenerate it first"
            )


def _prepare_style_reference(
    media_path: str,
    task_id: str,
    output_dir: str | Path | None = None,
) -> str | None:
    source = Path(media_path)
    if not source.is_file():
        return None
    if source.suffix.lower() in {".png", ".jpg", ".jpeg", ".webp"}:
        return str(source.resolve())
    output = (
        Path(output_dir).expanduser().resolve() / task_id / "style_reference.jpg"
        if output_dir
        else Path(get_task_path(task_id, "style_reference.jpg"))
    )
    output.parent.mkdir(parents=True, exist_ok=True)
    command = [
        "ffmpeg",
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        str(source),
        "-frames:v",
        "1",
        "-q:v",
        "2",
        "-y",
        str(output),
    ]
    try:
        subprocess.run(command, capture_output=True, text=True, check=True)
    except (OSError, subprocess.CalledProcessError) as exc:
        logger.warning(f"Could not extract style reference from {source}: {exc}")
        return None
    return str(output) if output.is_file() else None


def _write_revision_storyboard(
    task_id: str,
    project: dict[str, Any],
    revision: dict[str, Any],
    final_path: str,
    output_dir: str | Path | None = None,
) -> None:
    def frame_payload(scene: dict[str, Any]) -> dict[str, Any]:
        media_type = next(
            (
                artifact.get("media_type")
                for artifact in scene.get("artifacts", [])
                if artifact["kind"] == "source_media"
            ),
            None,
        )
        media_path = scene.get("media_path")
        return {
            "index": scene["position"],
            "narration": scene["narration"],
            "image_prompt": scene["visual_prompt"],
            "audio_path": scene.get("audio_path"),
            "media_type": media_type,
            "image_path": media_path if media_type == "image" else None,
            "video_path": media_path if media_type != "image" else None,
            "composed_image_path": next(
                (
                    artifact["path"]
                    for artifact in scene.get("artifacts", [])
                    if artifact["kind"] == "overlay"
                ),
                None,
            ),
            "overlay_image_path": next(
                (
                    artifact["path"]
                    for artifact in scene.get("artifacts", [])
                    if artifact["kind"] == "text_overlay"
                ),
                None,
            ),
            "subtitle_overlay_path": next(
                (
                    artifact["path"]
                    for artifact in scene.get("artifacts", [])
                    if artifact["kind"] == "subtitle_overlay"
                ),
                None,
            ),
            "video_segment_path": scene.get("segment_path"),
            "duration": scene.get("duration") or 0,
            "image_motion": scene.get("image_motion"),
            "transition": scene.get("transition"),
            "transition_duration": scene.get("transition_duration"),
            "direction_reason": scene.get("direction_reason"),
            "subtitle_effect": scene.get("subtitle_effect"),
            "subtitle_effect_applied": scene.get("subtitle_effect_applied"),
            "subtitle_effect_fallback_reason": scene.get(
                "subtitle_effect_fallback_reason"
            ),
            "subtitle_keywords": list(scene.get("subtitle_keywords") or []),
            "subtitle_start_offset": float(scene.get("subtitle_start_offset") or 0),
            "subtitle_end_offset": float(scene.get("subtitle_end_offset") or 0),
            "focus_x": scene.get("focus_x"),
            "focus_y": scene.get("focus_y"),
            "focus_confidence": scene.get("focus_confidence"),
            "focus_source": scene.get("focus_source"),
        }

    payload = {
        "title": project["title"],
        "config": revision["config"],
        "frames": [frame_payload(scene) for scene in revision["scenes"]],
        "final_video_path": final_path,
        "total_duration": sum(float(scene.get("duration") or 0) for scene in revision["scenes"]),
        "completed_at": datetime.now().isoformat(),
    }
    path = (
        Path(output_dir).expanduser().resolve() / task_id / "storyboard.json"
        if output_dir
        else Path(get_task_path(task_id, "storyboard.json"))
    )
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
