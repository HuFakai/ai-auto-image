# Copyright (C) 2025 AIDC-AI
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#     http://www.apache.org/licenses/LICENSE-2.0
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

"""
Video generation endpoints

Supports both synchronous and asynchronous video generation.
"""

import os

from fastapi import APIRouter, Header, HTTPException, Request
from loguru import logger

from api.dependencies import PixelleVideoDep, get_pixelle_video
from api.schemas.video import (
    VideoGenerateAsyncResponse,
    VideoGenerateRequest,
    VideoGenerateResponse,
)
from api.tasks import Task, TaskType, task_manager

router = APIRouter(prefix="/video", tags=["Video Generation"])


def path_to_url(request: Request, file_path: str) -> str:
    """
    Convert file path to accessible URL
    
    Handles both absolute and relative paths, extracting the path relative
    to the output directory for URL construction.
    
    Args:
        request: FastAPI Request object (provides base_url from actual request)
        file_path: Absolute or relative file path
    
    Returns:
        Full URL to access the file
    
    Examples:
        Windows: G:\\...\\output\\20251205_233630_c939\\final.mp4
              -> http://localhost:18123/api/files/20251205_233630_c939/final.mp4
        
        Linux:   /home/user/.../output/20251205_233630_c939/final.mp4
              -> http://localhost:18123/api/files/20251205_233630_c939/final.mp4
        
        Domain:  With domain request -> https://your-domain.com/api/files/...
    """
    return path_to_url_from_base(str(request.base_url), file_path)


def path_to_url_from_base(base_url: str, file_path: str) -> str:
    """Convert an output path to a URL using a persisted request base URL."""
    from pathlib import Path
    
    # Normalize path separators to forward slashes first (for cross-platform compatibility)
    file_path = file_path.replace("\\", "/")
    
    # Check if it's an absolute path (works for both Windows and Linux)
    is_absolute = os.path.isabs(file_path) or Path(file_path).is_absolute()
    
    if is_absolute:
        # Find "output" in the path and get everything after it
        # Split by / to work with normalized paths
        parts = file_path.split("/")
        try:
            output_idx = parts.index("output")
            # Get all parts after "output" and join them
            relative_parts = parts[output_idx + 1:]
            file_path = "/".join(relative_parts)
        except ValueError:
            # If "output" not in path, use the filename only
            file_path = Path(file_path).name
    else:
        # If relative path starting with "output/", remove it
        if file_path.startswith("output/"):
            file_path = file_path[7:]  # Remove "output/"
    
    # Build URL using the original request base URL, including after recovery.
    base_url = base_url.rstrip("/")
    return f"{base_url}/api/files/{file_path}"


def build_video_params(request_body: VideoGenerateRequest, task_id: str | None = None) -> dict:
    """Build core pipeline parameters once for sync, async, and recovery paths."""
    template_sha256 = None
    whiteboard = request_body.whiteboard
    prompt_prefix = request_body.prompt_prefix
    if request_body.render_engine == "whiteboard_cv":
        from pixelle_video.whiteboard.templates import WhiteboardTemplateRegistry

        media_width, media_height = 1080, 1920
        if request_body.frame_template:
            raise ValueError("whiteboard_animation does not accept frame_template")
        whiteboard = WhiteboardTemplateRegistry().resolve(whiteboard)
        prompt_prefix = " ".join(
            value
            for value in (
                str(whiteboard["prompt_recipe"]),
                "竖屏 9:16 构图，无文字、无 Logo、无水印，底部保留字幕安全区。",
                str(prompt_prefix or "").strip(),
            )
            if value
        )
    else:
        if not request_body.frame_template:
            raise ValueError("frame_template is required to determine media size")
        from pixelle_video.services.frame_html import HTMLFrameGenerator
        from pixelle_video.utils.template_util import resolve_template_fingerprint

        template_path, template_sha256 = resolve_template_fingerprint(
            request_body.frame_template,
            request_body.template_sha256,
        )
        generator = HTMLFrameGenerator(template_path, expected_sha256=template_sha256)
        media_width, media_height = generator.get_media_size()
        logger.debug(f"Auto-determined media size from template: {media_width}x{media_height}")

    video_params = {
        "text": request_body.text,
        "mode": request_body.mode,
        "title": request_body.title,
        **({"n_scenes": request_body.n_scenes} if request_body.n_scenes is not None else {}),
        "limit_scenes": request_body.limit_scenes,
        "narrations": request_body.narrations,
        "image_prompts": request_body.image_prompts,
        "min_narration_words": request_body.min_narration_words,
        "max_narration_words": request_body.max_narration_words,
        "min_image_prompt_words": request_body.min_image_prompt_words,
        "max_image_prompt_words": request_body.max_image_prompt_words,
        "media_width": media_width,
        "media_height": media_height,
        "media_workflow": request_body.media_workflow,
        "video_fps": request_body.video_fps,
        "production_mode": request_body.production_mode,
        "render_engine": request_body.render_engine,
        "renderer_version": request_body.renderer_version,
        "image_motion": request_body.image_motion,
        "transition": request_body.transition,
        "transition_duration": request_body.transition_duration,
        "subtitle_effect": request_body.subtitle_effect,
        "scene_direction": request_body.scene_direction,
        "motion_pool": request_body.motion_pool,
        "transition_pool": request_body.transition_pool,
        "scene_directions": (
            [item.model_dump() for item in request_body.scene_directions]
            if request_body.scene_directions is not None
            else None
        ),
        "hyperframes": request_body.hyperframes,
        "whiteboard": whiteboard,
        "frame_template": request_body.frame_template,
        "template_sha256": template_sha256,
        "prompt_prefix": prompt_prefix,
        "visual_memory": request_body.visual_memory,
        "visual_memory_prompt": request_body.visual_memory_prompt,
        "cover_prompt": request_body.cover_prompt,
        "watermark": request_body.watermark.model_dump(),
        "bgm_path": request_body.bgm_path,
        "bgm_volume": request_body.bgm_volume,
        "voice_volume": request_body.voice_volume,
    }
    if task_id:
        video_params["task_id"] = task_id
    if request_body.voice_id:
        video_params["voice_id"] = request_body.voice_id
    if request_body.tts_speed is not None:
        video_params["tts_speed"] = request_body.tts_speed
    if request_body.template_params:
        video_params["template_params"] = request_body.template_params
    return video_params


async def execute_video_request(
    request_body: VideoGenerateRequest,
    pixelle_video,
    base_url: str,
    task_id: str | None = None,
) -> dict:
    """Execute one deterministic video task and return a serializable result."""
    video_params = build_video_params(request_body, task_id=task_id)
    if task_id:

        def progress_callback(event) -> None:
            task_manager.update_progress(
                task_id,
                current=int(event.progress * 100),
                total=100,
                message=_video_progress_message(event),
            )

        video_params["progress_callback"] = progress_callback

    result = await pixelle_video.generate_video(**video_params)
    file_size = os.path.getsize(result.video_path) if os.path.exists(result.video_path) else 0
    return {
        "video_path": result.video_path,
        "video_url": path_to_url_from_base(base_url, result.video_path),
        "duration": result.duration,
        "file_size": file_size,
        "render_engine": result.storyboard.config.render_engine,
        "render_fallback_reason": result.storyboard.config.render_fallback_reason,
    }


def _video_progress_message(event) -> str:
    """Translate structured pipeline progress into queue-facing activity text."""
    labels = {
        "generating_title": "正在生成标题",
        "generating_narrations": "正在生成分镜旁白",
        "splitting_script": "正在拆分旁白脚本",
        "generating_image_prompts": "正在生成画面提示词",
        "generating_images_parallel": "正在并行生成并下载分镜图片",
        "processing_frame": "正在处理镜头素材",
        "restoring_checkpoint": "正在恢复已有镜头素材",
        "building_hyperframes_project": "正在构建 HyperFrames 项目",
        "restoring_final_video": "正在恢复已完成成片",
        "hyperframes_native_fallback": "HyperFrames 异常，正在切换原生合成",
        "concatenating": "正在拼接镜头与音频",
        "completed": "视频生成完成",
    }
    actions = {
        "audio": "生成配音",
        "media": "生成画面",
        "image": "生成图片",
        "video": "生成视频",
        "compose": "合成 HTML 画面",
        "hyperframes_assets": "准备 HyperFrames 镜头素材",
    }
    message = labels.get(event.event_type, event.event_type.replace("_", " "))
    if event.event_type == "frame_step" and event.action:
        message = actions.get(event.action, event.action)
    if event.frame_current and event.frame_total:
        message = f"镜头 {event.frame_current}/{event.frame_total} · {message}"
    if event.extra_info:
        message = f"{message} · {event.extra_info}"
    return message


async def execute_durable_video_task(task: Task) -> dict:
    """Recreate a video request from durable metadata after process restart."""
    request_params = dict(task.request_params or {})
    base_url = request_params.pop("_request_base_url", "http://localhost:18123")
    request_body = VideoGenerateRequest.model_validate(request_params)
    pixelle_video = await get_pixelle_video()
    return await execute_video_request(
        request_body=request_body,
        pixelle_video=pixelle_video,
        base_url=base_url,
        task_id=task.task_id,
    )


task_manager.register_handler(TaskType.VIDEO_GENERATION, execute_durable_video_task)


@router.post("/generate/sync", response_model=VideoGenerateResponse)
async def generate_video_sync(
    request_body: VideoGenerateRequest,
    pixelle_video: PixelleVideoDep,
    request: Request
):
    """
    Generate video synchronously
    
    This endpoint blocks until video generation is complete.
    Suitable for small videos (< 30 seconds).
    
    **Note**: May timeout for large videos. Use `/generate/async` instead.
    
    Request body includes all video generation parameters.
    See VideoGenerateRequest schema for details.
    
    Returns path to generated video, duration, and file size.
    """
    try:
        logger.info(f"Sync video generation: {request_body.text[:50]}...")
        
        result = await execute_video_request(
            request_body=request_body,
            pixelle_video=pixelle_video,
            base_url=str(request.base_url),
        )
        return VideoGenerateResponse(**result)
        
    except Exception as e:
        logger.error(f"Sync video generation error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/generate/async", response_model=VideoGenerateAsyncResponse)
async def generate_video_async(
    request_body: VideoGenerateRequest,
    request: Request,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
):
    """
    Generate video asynchronously
    
    Creates a background task for video generation.
    Returns immediately with a task_id for tracking progress.
    
    **Workflow:**
    1. Submit video generation request
    2. Receive task_id in response
    3. Poll `/api/tasks/{task_id}` to check status
    4. When status is "completed", retrieve video from result
    
    Request body includes all video generation parameters.
    See VideoGenerateRequest schema for details.
    
    Returns task_id for tracking progress.
    """
    try:
        logger.info(f"Async video generation: {request_body.text[:50]}...")
        if idempotency_key and len(idempotency_key) > 200:
            raise HTTPException(status_code=400, detail="Idempotency-Key is too long")
        
        # Create task
        durable_request = request_body.model_dump()
        durable_request["_request_base_url"] = str(request.base_url)
        task = task_manager.create_task(
            task_type=TaskType.VIDEO_GENERATION,
            request_params=durable_request,
            idempotency_key=idempotency_key,
        )
        await task_manager.execute_task(task_id=task.task_id)
        
        return VideoGenerateAsyncResponse(
            task_id=task.task_id
        )
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Async video generation error: {e}")
        raise HTTPException(status_code=500, detail=str(e))
