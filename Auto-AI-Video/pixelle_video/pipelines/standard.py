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
Standard Video Generation Pipeline

Standard workflow for generating short videos from topic or fixed script.
This is the default pipeline for general-purpose video generation.
Refactored to use LinearVideoPipeline (Template Method Pattern).
"""

import asyncio
import json
import shutil
from datetime import datetime
from pathlib import Path

from loguru import logger

from pixelle_video.models.progress import ProgressEvent
from pixelle_video.models.storyboard import (
    Storyboard,
    StoryboardConfig,
    StoryboardFrame,
    VideoGenerationResult,
)
from pixelle_video.pipelines.linear import LinearVideoPipeline, PipelineContext
from pixelle_video.services.video import VideoService
from pixelle_video.utils.content_generators import (
    generate_image_prompts,
    generate_narrations_from_topic,
    generate_title,
    split_narration_script,
)
from pixelle_video.utils.os_util import create_task_output_dir, get_task_final_video_path
from pixelle_video.utils.prompt_helper import build_image_prompt
from pixelle_video.utils.scene_direction import direct_storyboard_scenes
from pixelle_video.utils.template_util import (
    get_template_type,
    resolve_template_fingerprint,
    snapshot_template_for_task,
)


class StandardPipeline(LinearVideoPipeline):
    """
    Standard video generation pipeline
    
    Workflow:
    1. Generate/determine title
    2. Generate narrations (from topic or split fixed script)
    3. Generate image prompts for each narration
    4. For each frame:
       - Generate audio (TTS)
       - Generate image
       - Compose frame with template
       - Create video segment
    5. Concatenate all segments
    6. Add BGM (optional)
    
    Supports two modes:
    - "generate": LLM generates narrations from topic
    - "fixed": Use provided script as-is (each line = one narration)
    """
    
    # ==================== Lifecycle Methods ====================

    async def setup_environment(self, ctx: PipelineContext):
        """Step 1: Setup task directory and environment."""
        text = ctx.input_text
        mode = ctx.params.get("mode", "generate")
        
        logger.info(f"🚀 Starting StandardPipeline in '{mode}' mode")
        logger.info(f"   Text length: {len(text)} chars")
        
        # Create isolated task directory
        task_dir, task_id = create_task_output_dir(ctx.params.get("task_id"))
        ctx.task_id = task_id
        ctx.task_dir = task_dir
        if ctx.params.get("render_engine") == "whiteboard_cv":
            ctx.params["frame_template"] = None
            ctx.params["template_sha256"] = None
            ctx.params["template_snapshot_path"] = None
        else:
            frame_template = ctx.params.get("frame_template") or "1080x1920/default.html"
            template_snapshot_path, template_sha256 = snapshot_template_for_task(
                frame_template,
                task_dir,
                ctx.params.get("template_sha256"),
            )
            ctx.params["template_sha256"] = template_sha256
            ctx.params["template_snapshot_path"] = template_snapshot_path
        
        logger.info(f"📁 Task directory created: {task_dir}")
        logger.info(f"   Task ID: {task_id}")

        ctx.resume_storyboard = await self.core.persistence.load_storyboard(task_id)
        if ctx.resume_storyboard is not None:
            logger.info(
                f"♻️ Found storyboard checkpoint with "
                f"{len(ctx.resume_storyboard.frames)} scenes"
            )
        
        # Determine final video path
        output_path = ctx.params.get("output_path")
        if output_path is None:
            ctx.final_video_path = get_task_final_video_path(task_id)
        else:
            # We will copy to this path in finalize/post_production
            # For internal processing, we still use the task dir path? 
            # Actually StandardPipeline logic used get_task_final_video_path as the target for concat
            # and then copied. Let's stick to that.
            ctx.final_video_path = get_task_final_video_path(task_id)
            logger.info(f"   Will copy final video to: {output_path}")

    async def generate_content(self, ctx: PipelineContext):
        """Step 2: Generate or process script/narrations."""
        if ctx.params.get("narrations"):
            ctx.narrations = list(ctx.params["narrations"])
            logger.info(f"✅ Loaded {len(ctx.narrations)} approved narration scenes")
            return
        if ctx.resume_storyboard and ctx.resume_storyboard.frames:
            ctx.narrations = [frame.narration for frame in ctx.resume_storyboard.frames]
            logger.info(f"♻️ Reused {len(ctx.narrations)} narrations from checkpoint")
            return
        mode = ctx.params.get("mode", "generate")
        text = ctx.input_text
        limit_scenes = bool(ctx.params.get("limit_scenes", True))
        n_scenes = ctx.params.get("n_scenes", 5) if limit_scenes else None
        min_words = ctx.params.get("min_narration_words", 5)
        max_words = ctx.params.get("max_narration_words", 20)
        
        if mode == "generate":
            self._report_progress(ctx.progress_callback, "generating_narrations", 0.05)
            ctx.narrations = await generate_narrations_from_topic(
                self.llm,
                topic=text,
                n_scenes=n_scenes,
                min_words=min_words,
                max_words=max_words
            )
            logger.info(f"✅ Generated {len(ctx.narrations)} narrations")
        else:  # fixed
            self._report_progress(ctx.progress_callback, "splitting_script", 0.05)
            split_mode = ctx.params.get("split_mode", "paragraph")
            ctx.narrations = await split_narration_script(text, split_mode=split_mode)
            logger.info(f"✅ Split script into {len(ctx.narrations)} segments (mode={split_mode})")
            logger.info(f"   Note: n_scenes={n_scenes} is ignored in fixed mode")

    async def determine_title(self, ctx: PipelineContext):
        """Step 3: Determine or generate video title."""
        # Note: Swapped order with generate_content in base class call, 
        # but in StandardPipeline original code, title was determined BEFORE narrations.
        # However, LinearVideoPipeline defines generate_content BEFORE determine_title.
        # This is fine as they are independent in StandardPipeline logic.
        
        title = ctx.params.get("title")
        mode = ctx.params.get("mode", "generate")
        text = ctx.input_text
        
        if title:
            ctx.title = title
            logger.info(f"   Title: '{title}' (user-specified)")
        elif ctx.resume_storyboard and ctx.resume_storyboard.title:
            ctx.title = ctx.resume_storyboard.title
            logger.info(f"   Title: '{ctx.title}' (checkpoint)")
        else:
            self._report_progress(ctx.progress_callback, "generating_title", 0.10)
            if mode == "generate":
                ctx.title = await generate_title(self.llm, text, strategy="auto")
                logger.info(f"   Title: '{ctx.title}' (auto-generated)")
            else:  # fixed
                ctx.title = await generate_title(self.llm, text, strategy="llm")
                logger.info(f"   Title: '{ctx.title}' (LLM-generated)")

    async def plan_visuals(self, ctx: PipelineContext):
        """Step 4: Generate image prompts or visual descriptions."""
        if ctx.params.get("image_prompts"):
            ctx.image_prompts = list(ctx.params["image_prompts"])
            if len(ctx.image_prompts) != len(ctx.narrations):
                raise ValueError("Approved storyboard narration and visual prompt counts differ")
            logger.info(f"✅ Loaded {len(ctx.image_prompts)} approved visual prompts")
            return
        if (
            ctx.resume_storyboard
            and len(ctx.resume_storyboard.frames) == len(ctx.narrations)
            and [frame.narration for frame in ctx.resume_storyboard.frames]
            == ctx.narrations
        ):
            ctx.image_prompts = [
                frame.image_prompt for frame in ctx.resume_storyboard.frames
            ]
            logger.info(
                f"♻️ Reused {len(ctx.image_prompts)} visual prompts from checkpoint"
            )
            return
        # Detect template type to determine if media generation is needed
        frame_template = ctx.params.get("frame_template") or "1080x1920/default.html"
        whiteboard_mode = ctx.params.get("render_engine") == "whiteboard_cv"

        template_name = Path(frame_template).name
        template_type = "image" if whiteboard_mode else get_template_type(template_name)
        media_workflow = ctx.params.get("media_workflow")
        template_requires_media = whiteboard_mode or template_type in ["image", "video"]
        model_media_type = None
        if template_requires_media:
            fallback_media_type = "video" if template_type == "video" else "image"
            model_media_type = self.media.resolve_media_type(
                media_workflow,
                fallback=fallback_media_type,
            )
        
        if template_requires_media and model_media_type == "image":
            logger.info("📸 Selected media model generates images")
        elif template_requires_media and model_media_type == "video":
            logger.info("🎬 Selected media model generates videos")
        else:  # static
            logger.info("⚡ Static template - skipping media generation pipeline")
            logger.info("   Benefits: faster generation and no media model call")
        
        # Only generate image prompts if template requires media
        if template_requires_media:
            self._report_progress(ctx.progress_callback, "generating_image_prompts", 0.15)
            
            prompt_prefix = ctx.params.get("prompt_prefix")
            min_words = ctx.params.get("min_image_prompt_words", 30)
            max_words = ctx.params.get("max_image_prompt_words", 60)
            
            if prompt_prefix is not None:
                logger.info(f"Using custom prompt_prefix: '{prompt_prefix}'")

            try:
                # Create progress callback wrapper for image prompt generation
                def image_prompt_progress(completed: int, total: int, message: str):
                    batch_progress = completed / total if total > 0 else 0
                    overall_progress = 0.15 + (batch_progress * 0.15)
                    self._report_progress(
                        ctx.progress_callback,
                        "generating_image_prompts",
                        overall_progress,
                        extra_info=message
                    )
                
                # Generate base image prompts
                base_image_prompts = await generate_image_prompts(
                    self.llm,
                    narrations=ctx.narrations,
                    min_words=min_words,
                    max_words=max_words,
                    progress_callback=image_prompt_progress
                )
                
                # Apply prompt prefix
                image_config = self.core.config.get("media", {}).get("image", {})
                prompt_prefix_to_use = prompt_prefix if prompt_prefix is not None else image_config.get("prompt_prefix", "")
                
                ctx.image_prompts = []
                for base_prompt in base_image_prompts:
                    final_prompt = build_image_prompt(base_prompt, prompt_prefix_to_use)
                    ctx.image_prompts.append(final_prompt)
                
            finally:
                pass
            
            logger.info(f"✅ Generated {len(ctx.image_prompts)} image prompts")
        else:
            # Static template - skip image prompt generation entirely
            ctx.image_prompts = [None] * len(ctx.narrations)
            logger.info("⚡ Skipped image prompt generation (static template)")
            logger.info(f"   💡 Savings: {len(ctx.narrations)} LLM calls + {len(ctx.narrations)} media generations")

    async def initialize_storyboard(self, ctx: PipelineContext):
        """Step 5: Create Storyboard object and frames."""
        frame_template = ctx.params.get("frame_template")
        template_snapshot_path = ctx.params.get("template_snapshot_path")
        if ctx.params.get("render_engine") == "whiteboard_cv":
            template_sha256 = None
        else:
            frame_template = frame_template or "1080x1920/default.html"
            _, template_sha256 = resolve_template_fingerprint(
                template_snapshot_path or frame_template,
                ctx.params.get("template_sha256"),
            )
        ctx.params["template_sha256"] = template_sha256
        # === Handle TTS parameter compatibility ===
        tts_voice = ctx.params.get("tts_voice")
        voice_id = ctx.params.get("voice_id")
        final_voice_id = voice_id or tts_voice or self.core.config.get("tts", {}).get(
            "voice", "zh-CN-YunjianNeural"
        )
        logger.debug(f"TTS provider=edge (voice={final_voice_id})")

        from pixelle_video.rendering.subtitle_effects import (
            normalize_subtitle_effect,
            resolve_native_subtitle_effect,
        )

        requested_subtitle_effect = normalize_subtitle_effect(
            ctx.params.get("subtitle_effect")
        )
        if ctx.params.get("render_engine") == "hyperframes":
            applied_subtitle_effect = requested_subtitle_effect
            subtitle_fallback_reason = None
        else:
            native_subtitle = resolve_native_subtitle_effect(requested_subtitle_effect)
            applied_subtitle_effect = native_subtitle.applied
            subtitle_fallback_reason = native_subtitle.fallback_reason
            if subtitle_fallback_reason:
                logger.warning(subtitle_fallback_reason)
            
        # Create config
        ctx.config = StoryboardConfig(
            task_id=ctx.task_id,
            n_storyboard=len(ctx.narrations), # Use actual length
            min_narration_words=ctx.params.get("min_narration_words", 5),
            max_narration_words=ctx.params.get("max_narration_words", 20),
            min_image_prompt_words=ctx.params.get("min_image_prompt_words", 30),
            max_image_prompt_words=ctx.params.get("max_image_prompt_words", 60),
            video_fps=ctx.params.get("video_fps", 30),
            render_engine=ctx.params.get("render_engine", "hyperframes"),
            renderer_version=ctx.params.get(
                "renderer_version", "0.8.4"
            ),
            image_motion=ctx.params.get("image_motion", "none"),
            transition=ctx.params.get("transition", "none"),
            transition_duration=ctx.params.get("transition_duration", 0.35),
            subtitle_effect=requested_subtitle_effect,
            subtitle_effect_applied=applied_subtitle_effect,
            subtitle_effect_fallback_reason=subtitle_fallback_reason,
            voice_id=final_voice_id,
            tts_speed=ctx.params.get("tts_speed", 1.2),
            voice_volume=float(ctx.params.get("voice_volume", 1.0)),
            media_width=ctx.params.get("media_width"),
            media_height=ctx.params.get("media_height"),
            media_workflow=ctx.params.get("media_workflow"),
            api_video_params=ctx.params.get("api_video_params"),
            frame_template=frame_template,
            template_sha256=template_sha256,
            template_snapshot_path=template_snapshot_path,
            template_params=ctx.params.get("template_params"),
            whiteboard=ctx.params.get("whiteboard"),
        )
        
        # Create storyboard
        ctx.storyboard = Storyboard(
            title=ctx.title,
            config=ctx.config,
            content_metadata=ctx.params.get("content_metadata"),
            created_at=datetime.now()
        )
        
        # Freeze scene-level camera and transition direction before media generation.
        raw_scenes = [
            {"position": index, "narration": narration, "visual_prompt": image_prompt}
            for index, (narration, image_prompt) in enumerate(
                zip(ctx.narrations, ctx.image_prompts)
            )
        ]
        provided_directions = ctx.params.get("scene_directions")
        if provided_directions is not None:
            if len(provided_directions) != len(raw_scenes):
                raise ValueError("Scene direction count does not match storyboard frames")
            directed_scenes = [
                {**scene, **dict(provided_directions[index])}
                for index, scene in enumerate(raw_scenes)
            ]
        else:
            directed_scenes = direct_storyboard_scenes(
                raw_scenes,
                strategy=str(ctx.params.get("scene_direction") or "auto"),
                motion_pool=ctx.params.get("motion_pool"),
                transition_pool=ctx.params.get("transition_pool"),
                default_motion=ctx.config.image_motion,
                default_transition=ctx.config.transition,
                default_transition_duration=ctx.config.transition_duration,
            )

        # Create frames
        for i, scene in enumerate(directed_scenes):
            frame = StoryboardFrame(
                index=i,
                narration=scene["narration"],
                image_prompt=scene["visual_prompt"],
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
                created_at=datetime.now()
            )
            ctx.storyboard.frames.append(frame)

        resume_frames = (
            ctx.resume_storyboard.frames
            if ctx.resume_storyboard
            and len(ctx.resume_storyboard.frames) == len(ctx.storyboard.frames)
            else self._load_hyperframes_manifest_checkpoint(ctx, ctx.storyboard.frames)
        )
        recovered = 0
        for frame, previous in zip(ctx.storyboard.frames, resume_frames):
            if (
                frame.narration != previous.narration
                or frame.image_prompt != previous.image_prompt
            ):
                continue
            recovered += self._restore_frame_assets(frame, previous)

        await self.core.persistence.save_storyboard(ctx.task_id, ctx.storyboard)
        if recovered:
            recovered_scenes = sum(
                1
                for frame in ctx.storyboard.frames
                if self._usable_file(frame.audio_path)
                and self._usable_file(frame.image_path or frame.video_path)
            )
            logger.info(
                f"♻️ Restored generated assets for {recovered_scenes}/"
                f"{len(ctx.storyboard.frames)} scenes"
            )
            self._report_progress(
                ctx.progress_callback,
                "restoring_checkpoint",
                0.2 + (0.6 * recovered_scenes / len(ctx.storyboard.frames)),
                extra_info=f"已恢复 {recovered_scenes}/{len(ctx.storyboard.frames)} 个镜头",
            )

    @staticmethod
    def _usable_file(value: str | None) -> bool:
        if not value:
            return False
        path = Path(value)
        return path.is_file() and path.stat().st_size > 0

    @classmethod
    def _restore_frame_assets(
        cls,
        frame: StoryboardFrame,
        previous: StoryboardFrame,
    ) -> int:
        restored = 0
        for attribute in (
            "audio_path",
            "image_path",
            "video_path",
        ):
            value = getattr(previous, attribute)
            if cls._usable_file(value):
                setattr(frame, attribute, value)
                restored += 1
        same_composition = all(
            (
                frame.image_motion == previous.image_motion,
                frame.transition == previous.transition,
                frame.transition_duration == previous.transition_duration,
                frame.subtitle_effect == previous.subtitle_effect,
                frame.subtitle_keywords == previous.subtitle_keywords,
                frame.subtitle_start_offset == previous.subtitle_start_offset,
                frame.subtitle_end_offset == previous.subtitle_end_offset,
            )
        )
        for attribute in (
            "composed_image_path",
            "overlay_image_path",
            "subtitle_overlay_path",
            "whiteboard_silent_path",
            "whiteboard_analysis_path",
            "video_segment_path",
        ):
            if not same_composition:
                continue
            value = getattr(previous, attribute)
            if cls._usable_file(value):
                setattr(frame, attribute, value)
                restored += 1
        if cls._usable_file(frame.image_path):
            frame.media_type = "image"
        elif cls._usable_file(frame.video_path):
            frame.media_type = "video"
        if restored and previous.duration > 0:
            frame.duration = previous.duration
        if previous.focus_x is not None and previous.focus_y is not None:
            frame.focus_x = previous.focus_x
            frame.focus_y = previous.focus_y
            frame.focus_confidence = previous.focus_confidence
            frame.focus_source = previous.focus_source
        return restored

    @classmethod
    def _load_hyperframes_manifest_checkpoint(
        cls,
        ctx: PipelineContext,
        current_frames: list[StoryboardFrame],
    ) -> list[StoryboardFrame]:
        """Recover assets created before storyboard checkpoints were introduced."""
        if ctx.params.get("render_engine") != "hyperframes" or not ctx.task_dir:
            return []
        project_dir = Path(ctx.task_dir) / "hyperframes"
        manifest_path = project_dir / "manifest.json"
        if not manifest_path.is_file():
            return []
        try:
            scenes = json.loads(manifest_path.read_text(encoding="utf-8")).get(
                "scenes", []
            )
        except (OSError, json.JSONDecodeError):
            return []
        if len(scenes) != len(current_frames):
            return []
        recovered: list[StoryboardFrame] = []
        for current, scene in zip(current_frames, scenes):
            image = (project_dir / str(scene.get("image", ""))).resolve()
            audio = (project_dir / str(scene.get("audio", ""))).resolve()
            recovered.append(
                StoryboardFrame(
                    index=current.index,
                    narration=str(scene.get("narration") or current.narration),
                    image_prompt=current.image_prompt,
                    audio_path=str(audio) if cls._usable_file(str(audio)) else None,
                    media_type="image" if cls._usable_file(str(image)) else None,
                    image_path=str(image) if cls._usable_file(str(image)) else None,
                    duration=float(scene.get("duration") or 0),
                    image_motion=scene.get("image_motion"),
                    transition=scene.get("transition"),
                    transition_duration=scene.get("transition_duration"),
                    direction_reason=scene.get("direction_reason"),
                    subtitle_effect=scene.get("subtitle_effect"),
                    subtitle_effect_applied=scene.get("subtitle_effect_applied"),
                    subtitle_effect_fallback_reason=scene.get(
                        "subtitle_effect_fallback_reason"
                    ),
                    subtitle_keywords=list(scene.get("subtitle_keywords") or []),
                    subtitle_start_offset=float(
                        scene.get("subtitle_start_offset") or 0
                    ),
                    subtitle_end_offset=float(scene.get("subtitle_end_offset") or 0),
                    focus_x=scene.get("focus_x"),
                    focus_y=scene.get("focus_y"),
                    focus_confidence=scene.get("focus_confidence"),
                    focus_source=scene.get("focus_source"),
                )
            )
        logger.info("♻️ Loaded legacy HyperFrames assets from manifest checkpoint")
        return recovered

    async def produce_assets(self, ctx: PipelineContext):
        """Step 6: Generate audio, images, and render frames (Core processing)."""
        storyboard = ctx.storyboard
        config = ctx.config
        storyboard.total_duration = 0.0

        # Image models do not depend on narration duration. Start those requests as
        # one bounded batch, persist every completed download, then keep audio,
        # composition and ffmpeg segment rendering serial and deterministic.
        media_type = (
            self.core.media.resolve_media_type(config.media_workflow, fallback="image")
            if config.media_workflow
            else None
        )
        image_parallel_limit = int(
            ctx.params.get("image_generation_concurrency") or 4
        )
        pending_images = [
            (index, frame)
            for index, frame in enumerate(storyboard.frames)
            if media_type == "image"
            and frame.image_prompt is not None
            and not frame.image_path
            and not frame.video_path
        ]
        prefetched_images = bool(pending_images and image_parallel_limit > 1)
        if prefetched_images:
            import asyncio

            semaphore = asyncio.Semaphore(image_parallel_limit)
            checkpoint_lock = asyncio.Lock()
            completed_images = 0

            async def generate_image(index: int, frame: StoryboardFrame):
                nonlocal completed_images
                async with semaphore:
                    await self.core.frame_processor._step_generate_media(frame, config)
                    async with checkpoint_lock:
                        storyboard.frames[index] = frame
                        completed_images += 1
                        await self.core.persistence.save_storyboard(
                            ctx.task_id, storyboard
                        )
                        self._report_progress(
                            ctx.progress_callback,
                            "generating_images_parallel",
                            0.2 + 0.22 * completed_images / len(pending_images),
                            frame_current=completed_images,
                            frame_total=len(pending_images),
                            action="image",
                        )

            logger.info(
                "Generating {} storyboard images in parallel (concurrency={})",
                len(pending_images),
                image_parallel_limit,
            )
            await asyncio.gather(
                *(generate_image(index, frame) for index, frame in pending_images)
            )
            logger.info("✅ Parallel storyboard image batch downloaded")

        asset_base_progress = 0.43 if prefetched_images else 0.2
        asset_progress_range = 0.37 if prefetched_images else 0.6
        
        parallel_limit = 1

        if parallel_limit > 1:
            logger.info(f"Using parallel frame processing (max {parallel_limit} concurrent)")
            
            import asyncio

            semaphore = asyncio.Semaphore(parallel_limit)
            checkpoint_lock = asyncio.Lock()
            completed_count = 0
            
            async def process_frame_with_semaphore(i: int, frame: StoryboardFrame):
                nonlocal completed_count
                async with semaphore:
                    base_progress = asset_base_progress
                    frame_range = asset_progress_range
                    per_frame_progress = frame_range / len(storyboard.frames)
                    
                    # Create frame-specific progress callback
                    def frame_progress_callback(event: ProgressEvent):
                        overall_progress = base_progress + (per_frame_progress * completed_count) + (per_frame_progress * event.progress)
                        if ctx.progress_callback:
                            adjusted_event = ProgressEvent(
                                event_type=event.event_type,
                                progress=overall_progress,
                                frame_current=i+1,
                                frame_total=len(storyboard.frames),
                                step=event.step,
                                action=event.action
                            )
                            ctx.progress_callback(adjusted_event)
                    
                    # Report frame start
                    self._report_progress(
                        ctx.progress_callback,
                        "processing_frame",
                        base_progress + (per_frame_progress * completed_count),
                        frame_current=i+1,
                        frame_total=len(storyboard.frames)
                    )
                    
                    processed_frame = await self.core.frame_processor(
                        frame=frame,
                        storyboard=storyboard,
                        config=config,
                        total_frames=len(storyboard.frames),
                        progress_callback=frame_progress_callback
                    )
                    async with checkpoint_lock:
                        storyboard.frames[i] = processed_frame
                        storyboard.total_duration = sum(
                            item.duration for item in storyboard.frames
                        )
                        await self.core.persistence.save_storyboard(
                            ctx.task_id, storyboard
                        )
                    
                    completed_count += 1
                    logger.info(f"✅ Frame {i+1} completed ({processed_frame.duration:.2f}s) [{completed_count}/{len(storyboard.frames)}]")
                    return i, processed_frame
            
            # Create all tasks and execute in parallel
            tasks = [process_frame_with_semaphore(i, frame) for i, frame in enumerate(storyboard.frames)]
            results = await asyncio.gather(*tasks)
            
            # Update frames in order and calculate total duration
            for idx, processed_frame in sorted(results, key=lambda x: x[0]):
                storyboard.frames[idx] = processed_frame
            storyboard.total_duration = sum(
                frame.duration for frame in storyboard.frames
            )
            
            logger.info(f"✅ All frames processed in parallel (total duration: {storyboard.total_duration:.2f}s)")
        else:
            logger.info("Using serial frame processing")
            
            for i, frame in enumerate(storyboard.frames):
                base_progress = asset_base_progress
                frame_range = asset_progress_range
                per_frame_progress = frame_range / len(storyboard.frames)
                
                # Create frame-specific progress callback
                def frame_progress_callback(event: ProgressEvent):
                    overall_progress = base_progress + (per_frame_progress * i) + (per_frame_progress * event.progress)
                    if ctx.progress_callback:
                        adjusted_event = ProgressEvent(
                            event_type=event.event_type,
                            progress=overall_progress,
                            frame_current=event.frame_current,
                            frame_total=event.frame_total,
                            step=event.step,
                            action=event.action
                        )
                        ctx.progress_callback(adjusted_event)
                
                # Report frame start
                self._report_progress(
                    ctx.progress_callback,
                    "processing_frame",
                    base_progress + (per_frame_progress * i),
                    frame_current=i+1,
                    frame_total=len(storyboard.frames)
                )
                
                processed_frame = await self.core.frame_processor(
                    frame=frame,
                    storyboard=storyboard,
                    config=config,
                    total_frames=len(storyboard.frames),
                    progress_callback=frame_progress_callback
                )
                storyboard.frames[i] = processed_frame
                storyboard.total_duration = sum(
                    item.duration for item in storyboard.frames[: i + 1]
                )
                await self.core.persistence.save_storyboard(ctx.task_id, storyboard)
                logger.info(f"✅ Frame {i+1} completed ({processed_frame.duration:.2f}s)")

    async def post_production(self, ctx: PipelineContext):
        """Step 7: Concatenate videos and add BGM."""
        used_native_fallback = False
        if ctx.config.render_engine == "hyperframes":
            try:
                await self._render_hyperframes(ctx)
                await self._finish_final_output(ctx, ctx.final_video_path)
                return
            except asyncio.CancelledError:
                raise
            except Exception as error:
                settings = dict(ctx.params.get("hyperframes") or {})
                if not bool(settings.get("fallback_to_native", True)):
                    raise
                await self._fallback_hyperframes_to_native(ctx, error)
                used_native_fallback = True
        self._report_progress(
            ctx.progress_callback,
            "concatenating",
            0.94 if used_native_fallback else 0.85,
        )
        
        storyboard = ctx.storyboard
        segment_paths = [frame.video_segment_path for frame in storyboard.frames]
        
        video_service = VideoService()
        scene_transitions = [
            frame.transition or ctx.config.transition for frame in storyboard.frames[1:]
        ]
        scene_transition_durations = [
            (
                frame.transition_duration
                if frame.transition_duration is not None
                else ctx.config.transition_duration
            )
            for frame in storyboard.frames[1:]
        ]
        
        final_video_path = video_service.concat_videos(
            videos=segment_paths,
            output=ctx.final_video_path,
            bgm_path=ctx.params.get("bgm_path"),
            bgm_volume=ctx.params.get("bgm_volume", 0.2),
            bgm_mode=ctx.params.get("bgm_mode", "loop"),
            transition=scene_transitions or ctx.config.transition,
            transition_duration=scene_transition_durations
            or ctx.config.transition_duration,
        )
        
        storyboard.final_video_path = final_video_path
        storyboard.completed_at = datetime.now()

        await self._finish_final_output(ctx, final_video_path)
        
        logger.success(f"🎬 Video generation completed: {ctx.final_video_path}")

    async def _finish_final_output(
        self,
        ctx: PipelineContext,
        rendered_path: str,
    ) -> None:
        """Persist and prepend the task cover, then publish the selected output path."""
        from pixelle_video.services.video_cover import (
            COVER_DURATION,
            VideoCoverService,
            apply_text_watermark,
        )

        self._report_progress(
            ctx.progress_callback,
            "designing_video_cover",
            0.985,
            extra_info="正在生成并写入视频首帧封面",
        )
        cover_service = VideoCoverService()
        covered = cover_service.ensure(
            video_path=rendered_path,
            task_dir=ctx.task_dir,
            title=ctx.storyboard.title,
            media_paths=cover_service.storyboard_media_paths(ctx.storyboard),
            duration=COVER_DURATION,
            cover_prompt=ctx.params.get("cover_prompt"),
        )
        final_path = apply_text_watermark(
            covered.video_path,
            dict(ctx.params.get("watermark") or {}),
        )
        ctx.final_video_path = final_path
        ctx.storyboard.final_video_path = final_path
        ctx.storyboard.cover_image_path = covered.cover_path
        ctx.storyboard.cover_duration = COVER_DURATION
        ctx.storyboard.total_duration = covered.duration
        ctx.storyboard.completed_at = datetime.now()

        user_specified_output = ctx.params.get("output_path")
        if user_specified_output:
            published = Path(user_specified_output).expanduser().resolve()
            source = Path(final_path).resolve()
            if published != source:
                published.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(source, published)
                logger.info(f"📹 Final video copied to: {published}")
            ctx.final_video_path = str(published)
            ctx.storyboard.final_video_path = str(published)

        await self.core.persistence.save_storyboard(ctx.task_id, ctx.storyboard)
        if covered.reused_output:
            logger.info(f"♻️ Reused covered final video: {covered.video_path}")
        elif covered.reused_cover:
            logger.info(f"♻️ Reused designed cover image: {covered.cover_path}")

    async def _fallback_hyperframes_to_native(
        self,
        ctx: PipelineContext,
        error: Exception,
    ) -> None:
        """Finish with the native renderer while reusing HyperFrames scene assets."""
        reason = f"{type(error).__name__}: {error}"[:2000]
        logger.warning(
            "HyperFrames failed; continuing with native image + HTML renderer: {}",
            reason,
        )
        ctx.params["render_fallback"] = {
            "from": "hyperframes",
            "to": "native_image_html",
            "reason": reason,
        }
        ctx.config.render_engine = "native_image_html"
        ctx.config.renderer_version = "native-image-html-v2"
        ctx.config.render_fallback_reason = reason
        from pixelle_video.rendering.subtitle_effects import resolve_native_subtitle_effect

        native_subtitle = resolve_native_subtitle_effect(ctx.config.subtitle_effect)
        ctx.config.subtitle_effect_applied = native_subtitle.applied
        ctx.config.subtitle_effect_fallback_reason = native_subtitle.fallback_reason
        if native_subtitle.fallback_reason:
            logger.warning(native_subtitle.fallback_reason)
        ctx.storyboard.final_video_path = None
        ctx.storyboard.completed_at = None

        total = len(ctx.storyboard.frames)
        for index, frame in enumerate(ctx.storyboard.frames):
            self._report_progress(
                ctx.progress_callback,
                "hyperframes_native_fallback",
                0.85 + (index / max(total, 1)) * 0.08,
                frame_current=index + 1,
                frame_total=total,
                extra_info="复用图片与配音，改用原生合成",
            )
            processed = await self.core.frame_processor(
                frame=frame,
                storyboard=ctx.storyboard,
                config=ctx.config,
                total_frames=total,
            )
            ctx.storyboard.frames[index] = processed
            ctx.storyboard.total_duration = sum(
                item.duration for item in ctx.storyboard.frames
            )
            await self.core.persistence.save_storyboard(
                ctx.task_id, ctx.storyboard
            )

        self._report_progress(
            ctx.progress_callback,
            "hyperframes_native_fallback",
            0.93,
            extra_info="原生镜头准备完成",
        )

    async def _render_hyperframes(self, ctx: PipelineContext) -> None:
        """Build and render one frozen HyperFrames project through the Node service."""
        from pixelle_video.services.hyperframes_process import hyperframes_process_manager
        from pixelle_video.services.hyperframes_project import HyperFramesProjectBuilder
        from pixelle_video.services.hyperframes_renderer import HyperFramesRendererAdapter

        existing_final = Path(ctx.final_video_path)
        if existing_final.is_file() and existing_final.stat().st_size > 0:
            duration = VideoService()._get_video_duration(str(existing_final))
            if duration > 0:
                ctx.storyboard.final_video_path = str(existing_final)
                ctx.storyboard.total_duration = duration
                ctx.storyboard.completed_at = datetime.now()
                await self.core.persistence.save_storyboard(ctx.task_id, ctx.storyboard)
                self._report_progress(
                    ctx.progress_callback,
                    "restoring_final_video",
                    0.98,
                    extra_info="已复用完成的成片",
                )
                logger.info(f"♻️ Reused completed HyperFrames video: {existing_final}")
                return

        self._report_progress(ctx.progress_callback, "building_hyperframes_project", 0.82)
        settings = dict(ctx.params.get("hyperframes") or {})
        build = HyperFramesProjectBuilder().build(
            ctx.storyboard,
            ctx.task_dir,
            bgm_path=ctx.params.get("bgm_path"),
            bgm_volume=ctx.params.get("bgm_volume", 0.2),
            template_id=str(settings.get("template_id") or "knowledge-card"),
            template_version=int(settings.get("template_version") or 1),
            template_variables=dict(settings.get("variables") or {}),
        )
        ctx.config.hyperframes_project_path = build.project_dir
        ctx.config.hyperframes_manifest_path = build.manifest_path
        ctx.config.hyperframes_template_id = build.template_id
        ctx.config.hyperframes_template_version = build.template_version
        ctx.config.hyperframes_template_fingerprint = build.template_fingerprint
        ctx.config.hyperframes_template_variables = build.template_variables
        await self.core.persistence.save_storyboard(ctx.task_id, ctx.storyboard)

        adapter = HyperFramesRendererAdapter(
            base_url=settings.get("renderer_url"),
            render_timeout=float(settings.get("render_timeout", 1800)),
        )
        try:
            await adapter.ready()
        except Exception:
            if settings.get("renderer_url"):
                raise
            await hyperframes_process_manager.ensure_started()
            await adapter.ready()
        submitted = await adapter.submit(
            build.project_dir,
            output_path=ctx.final_video_path,
            fps=ctx.config.video_fps,
            quality=str(settings.get("quality") or "standard"),
            strictness=str(settings.get("strictness") or "strict"),
            workers=settings.get("workers"),
            use_gpu=bool(settings.get("use_gpu", True)),
        )
        render_id = str(submitted["id"])
        ctx.config.hyperframes_render_id = render_id
        await self.core.persistence.save_storyboard(ctx.task_id, ctx.storyboard)

        def report_renderer(progress: float, stage: str, message: str) -> None:
            overall = 0.84 + min(max(progress, 0), 100) / 100 * 0.14
            self._report_progress(
                ctx.progress_callback,
                f"hyperframes_{stage}",
                overall,
                extra_info=message,
            )

        try:
            result = await adapter.wait(render_id, report_renderer)
        except asyncio.CancelledError:
            await adapter.cancel(render_id)
            raise
        check_report = (
            Path(result.check_report_path)
            if result.check_report_path
            else Path(build.project_dir) / "check-report.json"
        )
        if check_report.is_file():
            ctx.config.hyperframes_check_report_path = str(check_report)
        if not Path(result.output_path).is_file() or result.size_bytes <= 0:
            raise RuntimeError("HyperFrames renderer completed without a non-empty video")
        ctx.final_video_path = result.output_path
        ctx.storyboard.final_video_path = result.output_path
        ctx.storyboard.total_duration = result.duration or build.duration
        ctx.storyboard.completed_at = datetime.now()
        await self.core.persistence.save_storyboard(ctx.task_id, ctx.storyboard)
        logger.success(f"🎬 HyperFrames video generation completed: {result.output_path}")

    async def finalize(self, ctx: PipelineContext) -> VideoGenerationResult:
        """Step 8: Create result object and persist metadata."""
        self._report_progress(ctx.progress_callback, "completed", 1.0)
        
        video_path_obj = Path(ctx.final_video_path)
        file_size = video_path_obj.stat().st_size
        
        result = VideoGenerationResult(
            video_path=ctx.final_video_path,
            storyboard=ctx.storyboard,
            duration=ctx.storyboard.total_duration,
            file_size=file_size
        )
        
        ctx.result = result
        
        logger.info(f"✅ Generated video: {ctx.final_video_path}")
        logger.info(f"   Duration: {ctx.storyboard.total_duration:.2f}s")
        logger.info(f"   Size: {file_size / (1024*1024):.2f} MB")
        logger.info(f"   Frames: {len(ctx.storyboard.frames)}")
        
        # Persist metadata
        await self._persist_task_data(ctx)
        
        return result

    async def _persist_task_data(self, ctx: PipelineContext):
        """
        Persist task metadata and storyboard to filesystem
        """
        try:
            storyboard = ctx.storyboard
            result = ctx.result
            task_id = storyboard.config.task_id
            
            if not task_id:
                logger.warning("No task_id in storyboard, skipping persistence")
                return
            
            # Build metadata
            input_with_title = ctx.params.copy()
            input_with_title["text"] = ctx.input_text # Ensure text is included
            if not input_with_title.get("title"):
                input_with_title["title"] = storyboard.title
            
            metadata = {
                "task_id": task_id,
                "created_at": storyboard.created_at.isoformat() if storyboard.created_at else None,
                "completed_at": storyboard.completed_at.isoformat() if storyboard.completed_at else None,
                "status": "completed",
                
                "input": input_with_title,
                
                "result": {
                    "video_path": result.video_path,
                    "cover_image_path": storyboard.cover_image_path,
                    "cover_duration": storyboard.cover_duration,
                    "duration": result.duration,
                    "file_size": result.file_size,
                    "n_frames": len(storyboard.frames)
                },
                
                "config": {
                    "llm_model": self.core.config.get("llm", {}).get("model", "unknown"),
                    "llm_base_url": self.core.config.get("llm", {}).get("base_url", "unknown"),
                    "media_workflow": ctx.params.get("media_workflow"),
                    "render_engine": storyboard.config.render_engine,
                    "renderer_version": storyboard.config.renderer_version,
                    "template_sha256": storyboard.config.template_sha256,
                    "template_snapshot_path": storyboard.config.template_snapshot_path,
                    "image_motion": storyboard.config.image_motion,
                    "transition": storyboard.config.transition,
                    "transition_duration": storyboard.config.transition_duration,
                    "subtitle_effect": storyboard.config.subtitle_effect,
                    "subtitle_effect_applied": storyboard.config.subtitle_effect_applied,
                    "subtitle_effect_fallback_reason": storyboard.config.subtitle_effect_fallback_reason,
                    "hyperframes_template_id": storyboard.config.hyperframes_template_id,
                    "hyperframes_template_version": storyboard.config.hyperframes_template_version,
                    "hyperframes_template_fingerprint": storyboard.config.hyperframes_template_fingerprint,
                    "hyperframes_template_variables": storyboard.config.hyperframes_template_variables,
                    "render_fallback_reason": storyboard.config.render_fallback_reason,
                    "tts_provider": self.core.config.get("tts", {}).get("provider", "edge"),
                }
            }
            
            # Save metadata
            await self.core.persistence.save_task_metadata(task_id, metadata)
            logger.info(f"💾 Saved task metadata: {task_id}")
            
            # Save storyboard
            await self.core.persistence.save_storyboard(task_id, storyboard)
            logger.info(f"💾 Saved storyboard: {task_id}")
            
        except Exception as e:
            logger.error(f"Failed to persist task data: {e}")
            # Don't raise - persistence failure shouldn't break video generation
