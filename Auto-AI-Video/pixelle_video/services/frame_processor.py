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
Frame processor - Process single frame through complete pipeline

Orchestrates: TTS → Image Generation → Frame Composition → Video Segment

Key Feature:
- TTS-driven video duration: Audio duration from TTS is passed to video generation workflows
  to ensure perfect sync between audio and video (no padding, no trimming needed)
"""

from pathlib import Path
from typing import Callable, Optional

import httpx
from loguru import logger

from pixelle_video.models.progress import ProgressEvent
from pixelle_video.models.storyboard import Storyboard, StoryboardConfig, StoryboardFrame


class FrameProcessor:
    """Frame processor"""

    def __init__(self, pixelle_video_core):
        """
        Initialize

        Args:
            pixelle_video_core: PixelleVideoCore instance
        """
        self.core = pixelle_video_core

    async def __call__(
        self,
        frame: StoryboardFrame,
        storyboard: "Storyboard",
        config: StoryboardConfig,
        total_frames: int = 1,
        progress_callback: Optional[Callable[[ProgressEvent], None]] = None,
    ) -> StoryboardFrame:
        """
        Process single frame through complete pipeline

        Steps:
        1. Generate audio (TTS)
        2. Generate image or video through a direct model API
        3. Compose frame (add subtitle)
        4. Create video segment (image + audio)

        Args:
            frame: Storyboard frame to process
            storyboard: Storyboard instance
            config: Storyboard configuration
            total_frames: Total number of frames in storyboard
            progress_callback: Optional callback for progress updates (receives ProgressEvent)

        Returns:
            Processed frame with all paths filled
        """
        logger.info(f"Processing frame {frame.index}...")

        frame_num = frame.index + 1

        if (
            config.render_engine != "hyperframes"
            and frame.video_segment_path
            and Path(frame.video_segment_path).is_file()
            and Path(frame.video_segment_path).stat().st_size > 0
        ):
            logger.info(f"✅ Frame {frame.index} restored from completed segment")
            return frame

        # Determine if this frame needs image generation
        # If image_path or video_path is already set (e.g. asset-based pipeline), we consider it "has existing media" but skip generation
        has_existing_media = frame.image_path is not None or frame.video_path is not None
        needs_generation = frame.image_prompt is not None and not has_existing_media

        try:
            # Step 1: Generate audio (TTS)
            if not frame.audio_path:
                if progress_callback:
                    progress_callback(
                        ProgressEvent(
                            event_type="frame_step",
                            progress=0.0,
                            frame_current=frame_num,
                            frame_total=total_frames,
                            step=1,
                            action="audio",
                        )
                    )
                await self._step_generate_audio(frame, config)
            else:
                logger.debug(f"  1/4: Using existing audio: {frame.audio_path}")

            # Step 2: Generate media (image or video, conditional)
            if needs_generation:
                if progress_callback:
                    progress_callback(
                        ProgressEvent(
                            event_type="frame_step",
                            progress=0.25,
                            frame_current=frame_num,
                            frame_total=total_frames,
                            step=2,
                            action="media",
                        )
                    )
                await self._step_generate_media(frame, config)
            elif has_existing_media:
                # Log appropriate message based on media type
                if frame.video_path:
                    logger.debug(f"  2/4: Using existing video: {frame.video_path}")
                else:
                    logger.debug(f"  2/4: Using existing image: {frame.image_path}")
            else:
                frame.image_path = None
                frame.media_type = None
                logger.debug("  2/4: Skipped media generation (not required by template)")

            self._freeze_focus_anchor(frame)

            if config.render_engine == "hyperframes":
                if progress_callback:
                    progress_callback(
                        ProgressEvent(
                            event_type="frame_step",
                            progress=1.0,
                            frame_current=frame_num,
                            frame_total=total_frames,
                            step=3,
                            action="hyperframes_assets",
                        )
                    )
                logger.info(f"✅ Frame {frame.index} assets prepared for HyperFrames")
                return frame

            # Step 3: Compose frame (add subtitle)
            if progress_callback:
                progress_callback(
                    ProgressEvent(
                        event_type="frame_step",
                        progress=0.50 if (needs_generation or has_existing_media) else 0.33,
                        frame_current=frame_num,
                        frame_total=total_frames,
                        step=3,
                        action="compose",
                    )
                )
            await self._step_compose_frame(frame, storyboard, config)

            # Step 4: Create video segment
            if progress_callback:
                progress_callback(
                    ProgressEvent(
                        event_type="frame_step",
                        progress=0.75 if (needs_generation or has_existing_media) else 0.67,
                        frame_current=frame_num,
                        frame_total=total_frames,
                        step=4,
                        action="video",
                    )
                )

            await self._step_create_video_segment(frame, config)

            logger.info(f"✅ Frame {frame.index} completed")
            return frame

        except Exception as e:
            logger.error(f"❌ Failed to process frame {frame.index}: {e}")
            raise

    async def _step_generate_audio(self, frame: StoryboardFrame, config: StoryboardConfig):
        """Step 1: Generate audio using TTS"""
        logger.debug(f"  1/4: Generating audio for frame {frame.index}...")

        # Generate output path using task_id
        from pixelle_video.utils.os_util import get_task_frame_path

        output_path = get_task_frame_path(config.task_id, frame.index, "audio")

        tts_params = {
            "text": frame.narration,
            "output_path": output_path,
            "index": frame.index + 1,  # 1-based index for workflow
        }

        if config.voice_id:
            tts_params["voice"] = config.voice_id
        if config.tts_speed is not None:
            tts_params["speed"] = config.tts_speed
        tts_params["voice_volume"] = config.voice_volume

        audio_path = await self.core.tts(**tts_params)

        frame.audio_path = audio_path

        # Get audio duration
        frame.duration = await self._get_audio_duration(audio_path)

        logger.debug(f"  ✓ Audio generated: {audio_path} ({frame.duration:.2f}s)")

    async def _step_generate_media(self, frame: StoryboardFrame, config: StoryboardConfig):
        """Step 2: Generate media through a direct provider API."""
        logger.debug(f"  2/4: Generating media for frame {frame.index}...")

        # The configured model owns the media capability. Templates only define
        # presentation and must never turn an image model result into an .mp4.
        workflow_name = config.media_workflow or ""
        media_type = self.core.media.resolve_media_type(config.media_workflow, fallback="image")
        is_video_workflow = media_type == "video"

        logger.debug(f"  → Media type: {media_type} (workflow: {workflow_name})")

        # Build media generation parameters
        from pixelle_video.utils.os_util import get_task_frame_path

        output_path = get_task_frame_path(config.task_id, frame.index, media_type)

        api_video_params = dict(config.api_video_params or {}) if media_type == "video" else {}
        if media_type == "video" and workflow_name.startswith("api/"):
            await self._prepare_api_video_inputs(frame, config, api_video_params)

        media_params = {
            "prompt": frame.image_prompt,
            "workflow": config.media_workflow,  # Pass workflow from config (None = use default)
            "media_type": media_type,
            "width": config.media_width,
            "height": config.media_height,
            "output_path": output_path,
            "image_path": frame.image_path,
            "index": frame.index + 1,  # 1-based index for workflow
        }
        media_params.update(api_video_params)

        # For video workflows: pass audio duration as target video duration
        # This ensures video length matches audio length from the source
        if is_video_workflow and frame.duration:
            media_params["duration"] = frame.duration
            logger.info(
                f"  → Generating video with target duration: {frame.duration:.2f}s (from TTS audio)"
            )

        async def generate_and_download():
            generated = await self.core.media(**media_params)
            if generated.is_image:
                local = await self._download_media(
                    generated.url,
                    frame.index,
                    config.task_id,
                    media_type="image",
                )
            elif generated.is_video:
                local = await self._download_media(
                    generated.url,
                    frame.index,
                    config.task_id,
                    media_type="video",
                )
            else:
                raise ValueError(f"Unknown media type: {generated.media_type}")
            return generated, local

        media_result, local_path = await generate_and_download()

        # Store media type
        frame.media_type = media_result.media_type

        if media_result.is_image:
            frame.image_path = local_path
            logger.debug(f"  ✓ Image generated: {local_path}")

        elif media_result.is_video:
            frame.video_path = local_path

            # Update duration from video if available
            if media_result.duration:
                frame.duration = media_result.duration
                logger.debug(f"  ✓ Video generated: {local_path} (duration: {frame.duration:.2f}s)")
            else:
                # Get video duration from file
                frame.duration = await self._get_video_duration(local_path)
                logger.debug(f"  ✓ Video generated: {local_path} (duration: {frame.duration:.2f}s)")

    async def _prepare_api_video_inputs(
        self,
        frame: StoryboardFrame,
        config: StoryboardConfig,
        api_video_params: dict,
    ) -> None:
        """Prepare provider-specific inputs for API video models."""
        from pixelle_video.utils.os_util import get_task_frame_path

        if api_video_params.pop("use_narration_audio_as_driving_audio", False):
            api_video_params["audio_path"] = frame.audio_path

        if (
            frame.image_path
            or api_video_params.get("first_clip_path")
            or api_video_params.get("first_video_path")
        ):
            return

        first_frame_workflow = api_video_params.pop("first_frame_workflow", None)
        if not first_frame_workflow:
            return

        first_frame_path = get_task_frame_path(config.task_id, frame.index, "image")
        logger.info(f"  → Generating API video first frame via {first_frame_workflow}")
        image_result = await self.core.media(
            prompt=frame.image_prompt,
            workflow=first_frame_workflow,
            media_type="image",
            width=config.media_width,
            height=config.media_height,
            output_path=first_frame_path,
            index=frame.index + 1,
        )
        frame.image_path = await self._download_media(
            image_result.url,
            frame.index,
            config.task_id,
            media_type="image",
        )

    async def _step_compose_frame(
        self, frame: StoryboardFrame, storyboard: "Storyboard", config: StoryboardConfig
    ):
        """Step 3: Compose frame with subtitle using HTML template"""
        logger.debug(f"  3/4: Composing frame {frame.index}...")

        from pixelle_video.rendering.subtitle_effects import (
            normalize_subtitle_effect,
            normalize_subtitle_timing,
            resolve_native_subtitle_effect,
        )

        requested_effect = normalize_subtitle_effect(
            frame.subtitle_effect or config.subtitle_effect
        )
        native_effect = resolve_native_subtitle_effect(requested_effect)
        frame.subtitle_effect = frame.subtitle_effect or None
        frame.subtitle_effect_applied = native_effect.applied
        frame.subtitle_effect_fallback_reason = native_effect.fallback_reason
        frame.subtitle_start_offset, frame.subtitle_end_offset = normalize_subtitle_timing(
            frame.duration,
            frame.subtitle_start_offset,
            frame.subtitle_end_offset,
        )

        # Generate output path using task_id
        from pixelle_video.utils.os_util import get_task_frame_path

        output_path = get_task_frame_path(config.task_id, frame.index, "composed")

        if config.render_engine == "whiteboard_cv":
            from pixelle_video.whiteboard.subtitle import (
                render_transparent_canvas,
                render_whiteboard_subtitle,
            )

            frame.composed_image_path = render_transparent_canvas(
                output_path,
                width=config.media_width,
                height=config.media_height,
            )
            frame.subtitle_overlay_path = render_whiteboard_subtitle(
                frame.narration,
                frame.subtitle_keywords,
                get_task_frame_path(config.task_id, frame.index, "subtitle"),
                width=config.media_width,
                height=config.media_height,
            )
            logger.debug("  ✓ Standalone whiteboard subtitle layer created")
            return

        # For video type: render HTML as transparent overlay image
        # For image type: render HTML with image background
        # In both cases, we need the composed image
        composed_path = await self._compose_frame_html(
            frame,
            storyboard,
            config,
            output_path,
            transparent_background=frame.media_type == "video",
        )

        frame.composed_image_path = composed_path

        effective_motion = frame.image_motion or config.image_motion
        needs_animated_subtitle_layer = (
            frame.subtitle_effect_applied == "fade_up"
            or frame.subtitle_start_offset > 0
            or frame.subtitle_end_offset > 0
        )
        from pixelle_video.services.frame_html import HTMLFrameGenerator
        from pixelle_video.utils.template_util import (
            resolve_template_path,
            template_media_layer_mode,
            template_supports_layered_background,
        )

        active_template = config.template_snapshot_path or resolve_template_path(
            config.frame_template
        )
        supports_subtitle_layer = HTMLFrameGenerator(
            active_template,
            expected_sha256=config.template_sha256,
        ).has_safe_layer("subtitle")
        media_layer_mode = template_media_layer_mode(active_template)
        image_can_use_layers = (
            frame.media_type == "image"
            and bool(frame.image_path)
        )
        video_can_use_layers = (
            frame.media_type == "video" and media_layer_mode == "full-canvas"
        )
        can_split_subtitle = (
            config.renderer_version == "native-image-html-v2"
            and supports_subtitle_layer
            and (image_can_use_layers or video_can_use_layers)
        )

        if needs_animated_subtitle_layer and can_split_subtitle:
            if frame.media_type == "image" and media_layer_mode != "full-canvas":
                # Inset/framed media cannot be reconstructed by putting the source image
                # behind a transparent full-canvas overlay. Freeze media + chrome into an
                # opaque base and isolate only the subtitle above it.
                frame.composed_image_path = await self._compose_frame_html(
                    frame,
                    storyboard,
                    config,
                    output_path,
                    transparent_background=False,
                    layer_mode="chrome",
                )
                frame.overlay_image_path = None
            else:
                overlay_path = get_task_frame_path(config.task_id, frame.index, "overlay")
                frame.overlay_image_path = await self._compose_frame_html(
                    frame,
                    storyboard,
                    config,
                    overlay_path,
                    transparent_background=True,
                    layer_mode="chrome",
                )
            subtitle_path = get_task_frame_path(config.task_id, frame.index, "subtitle")
            frame.subtitle_overlay_path = await self._compose_frame_html(
                frame,
                storyboard,
                config,
                subtitle_path,
                transparent_background=True,
                layer_mode="subtitle",
            )
        elif needs_animated_subtitle_layer:
            previous_reason = frame.subtitle_effect_fallback_reason
            frame.subtitle_effect_applied = "static"
            frame.subtitle_effect_fallback_reason = (
                "当前原生模板或渲染版本无法把 [data-pixelle-safe=\"subtitle\"] "
                "拆成独立图层，逐镜字幕动效与时间微调已降级为静态全时段。"
            )
            if previous_reason:
                frame.subtitle_effect_fallback_reason = (
                    f"{previous_reason} {frame.subtitle_effect_fallback_reason}"
                )
            logger.warning(frame.subtitle_effect_fallback_reason)

        if (
            frame.media_type == "image"
            and frame.image_path
            and effective_motion != "none"
            and not frame.overlay_image_path
            and config.renderer_version == "native-image-html-v2"
        ):
            if template_supports_layered_background(active_template):
                overlay_path = get_task_frame_path(config.task_id, frame.index, "overlay")
                frame.overlay_image_path = await self._compose_frame_html(
                    frame,
                    storyboard,
                    config,
                    overlay_path,
                    transparent_background=True,
                )
            else:
                logger.warning(
                    "Template {} does not declare a full-canvas media layer; "
                    "falling back to whole-frame motion",
                    config.frame_template,
                )

        logger.debug(f"  ✓ Frame composed: {composed_path}")

    async def _compose_frame_html(
        self,
        frame: StoryboardFrame,
        storyboard: "Storyboard",
        config: StoryboardConfig,
        output_path: str,
        transparent_background: bool = False,
        layer_mode: str = "full",
    ) -> str:
        """Compose frame using HTML template"""
        from pixelle_video.services.frame_html import HTMLFrameGenerator
        from pixelle_video.utils.template_util import resolve_template_path

        # Resolve template path (handles various input formats)
        template_path = config.template_snapshot_path or resolve_template_path(
            config.frame_template
        )

        # Build ext data
        ext = {
            "index": frame.index + 1,
        }

        # Add custom template parameters
        if config.template_params:
            ext.update(config.template_params)
        ext["scene_count"] = len(storyboard.frames)
        ext["progress_percent"] = round(
            (frame.index + 1) / max(len(storyboard.frames), 1) * 100,
            3,
        )
        ext["focus_x"] = round((frame.focus_x if frame.focus_x is not None else 0.5) * 100, 3)
        ext["focus_y"] = round((frame.focus_y if frame.focus_y is not None else 0.5) * 100, 3)

        # Generate frame using HTML (size is auto-parsed from template path)
        from pixelle_video.services.frame_html import TrustedHTML

        generator = HTMLFrameGenerator(
            template_path,
            expected_sha256=config.template_sha256,
        )

        # Use video_path for video media, image_path for images
        media_path = frame.video_path if frame.media_type == "video" else frame.image_path
        logger.debug(f"Generating frame with media: '{media_path}' (type: {frame.media_type})")

        from pixelle_video.rendering.subtitle_effects import highlight_subtitle_text

        composed_path = await generator.generate_frame(
            title=storyboard.title,
            text=TrustedHTML(
                highlight_subtitle_text(frame.narration, frame.subtitle_keywords)
            ),
            image=media_path,  # HTMLFrameGenerator handles both image and video paths
            ext=ext,
            output_path=output_path,
            transparent_background=transparent_background,
            layer_mode=layer_mode,
        )

        return composed_path

    async def _step_create_video_segment(self, frame: StoryboardFrame, config: StoryboardConfig):
        """Step 4: Create video segment from media + audio"""
        logger.debug(f"  4/4: Creating video segment for frame {frame.index}...")

        # Generate output path using task_id
        from pixelle_video.utils.os_util import get_task_frame_path

        output_path = get_task_frame_path(config.task_id, frame.index, "segment")

        from pixelle_video.services.video import VideoService

        video_service = VideoService()

        if config.render_engine == "whiteboard_cv":
            import asyncio

            from pixelle_video.utils.os_util import get_task_path
            from pixelle_video.whiteboard.renderer import WhiteboardRenderer

            if not frame.image_path:
                raise ValueError("Whiteboard animation requires a generated source image")
            frame_number = frame.index + 1
            silent_path = get_task_path(
                config.task_id, "frames", f"{frame_number:02d}_whiteboard.mp4"
            )
            analysis_path = get_task_path(
                config.task_id, "frames", f"{frame_number:02d}_whiteboard.analysis.json"
            )
            if not Path(silent_path).is_file() or Path(silent_path).stat().st_size <= 0:
                renderer = WhiteboardRenderer()
                _, analysis = await asyncio.to_thread(
                    renderer.render,
                    image_path=frame.image_path,
                    output_path=silent_path,
                    duration=frame.duration,
                    width=config.media_width,
                    height=config.media_height,
                    fps=config.video_fps,
                    settings=dict(config.whiteboard or {}),
                    analysis_path=analysis_path,
                )
                if analysis.fallback_reason:
                    logger.warning(analysis.fallback_reason)
            frame.whiteboard_silent_path = silent_path
            frame.whiteboard_analysis_path = analysis_path
            overlaid_path = get_task_path(
                config.task_id, "frames", f"{frame_number:02d}_whiteboard_overlay.mp4"
            )
            video_service.overlay_image_on_video(
                video=silent_path,
                overlay_image=frame.composed_image_path,
                subtitle_overlay=frame.subtitle_overlay_path,
                output=overlaid_path,
                scale_mode="stretch",
                subtitle_effect=frame.subtitle_effect_applied or "static",
                subtitle_start_offset=frame.subtitle_start_offset,
                subtitle_end_offset=frame.subtitle_end_offset,
                subtitle_duration=frame.duration,
            )
            segment_path = video_service.merge_audio_video(
                video=overlaid_path,
                audio=frame.audio_path,
                output=output_path,
                replace_audio=True,
                audio_volume=1.0,
            )
            Path(overlaid_path).unlink(missing_ok=True)
            frame.video_segment_path = segment_path
            logger.debug(f"  ✓ Whiteboard segment created: {segment_path}")
            return

        # Branch based on media type
        if frame.media_type == "video":
            # Video workflow: overlay HTML template on video, then add audio
            logger.debug("  → Using video-based composition with HTML overlay")

            # Step 1: Overlay transparent HTML image on video
            # The composed_image_path contains the rendered HTML with transparent background
            temp_video_with_overlay = (
                get_task_frame_path(config.task_id, frame.index, "video") + "_overlay.mp4"
            )

            video_service.overlay_image_on_video(
                video=frame.video_path,
                overlay_image=frame.overlay_image_path or frame.composed_image_path,
                subtitle_overlay=frame.subtitle_overlay_path,
                output=temp_video_with_overlay,
                scale_mode="contain",  # Scale video to fit template size (contain mode)
                subtitle_effect=frame.subtitle_effect_applied or "static",
                subtitle_start_offset=frame.subtitle_start_offset,
                subtitle_end_offset=frame.subtitle_end_offset,
                subtitle_duration=frame.duration,
            )

            # Step 2: Add narration audio to the overlaid video
            # Note: The video might have audio (replaced) or be silent (audio added)
            segment_path = video_service.merge_audio_video(
                video=temp_video_with_overlay,
                audio=frame.audio_path,
                output=output_path,
                replace_audio=True,  # Replace video audio with narration
                audio_volume=1.0,
            )

            # Clean up temp file
            import os

            if os.path.exists(temp_video_with_overlay):
                os.unlink(temp_video_with_overlay)

        elif frame.media_type == "image" or frame.media_type is None:
            # Image workflow: Use composed image directly
            # The asset_default.html template includes the image in the composition
            logger.debug("  → Using image-based composition")

            segment_path = video_service.create_video_from_image(
                image=(frame.image_path if frame.overlay_image_path else frame.composed_image_path),
                audio=frame.audio_path,
                output=output_path,
                fps=config.video_fps,
                motion=frame.image_motion or config.image_motion,
                overlay=frame.overlay_image_path,
                subtitle_overlay=frame.subtitle_overlay_path,
                focus_x=frame.focus_x,
                focus_y=frame.focus_y,
                subtitle_effect=frame.subtitle_effect_applied or "static",
                subtitle_start_offset=frame.subtitle_start_offset,
                subtitle_end_offset=frame.subtitle_end_offset,
            )

        else:
            raise ValueError(f"Unknown media type: {frame.media_type}")

        frame.video_segment_path = segment_path

        logger.debug(f"  ✓ Video segment created: {segment_path}")

    @staticmethod
    def _freeze_focus_anchor(frame: StoryboardFrame) -> None:
        """Detect a focus point once, then reuse it for every renderer/retry."""

        if frame.media_type != "image" or not frame.image_path:
            return
        if frame.focus_x is not None and frame.focus_y is not None:
            return
        from pixelle_video.services.focal_point import detect_focal_point

        try:
            focus = detect_focal_point(frame.image_path)
        except Exception as exc:
            logger.warning("Could not detect focus for {}: {}; using centre", frame.image_path, exc)
            frame.focus_x = frame.focus_y = 0.5
            frame.focus_confidence = 0.0
            frame.focus_source = "center_fallback"
            return
        frame.focus_x = focus.x
        frame.focus_y = focus.y
        frame.focus_confidence = focus.confidence
        frame.focus_source = focus.source
        logger.info(
            "  → Frozen image focus: ({:.3f}, {:.3f}), confidence={:.3f}, source={}",
            focus.x,
            focus.y,
            focus.confidence,
            focus.source,
        )

    async def _get_audio_duration(self, audio_path: str) -> float:
        """Get audio duration in seconds"""
        try:
            # Try using ffmpeg-python
            import ffmpeg

            probe = ffmpeg.probe(audio_path)
            duration = float(probe["format"]["duration"])
            return duration
        except Exception as e:
            logger.warning(f"Failed to get audio duration: {e}, using estimate")
            # Fallback: estimate based on file size (very rough)
            import os

            file_size = os.path.getsize(audio_path)
            # Assume ~16kbps for MP3, so 2KB per second
            estimated_duration = file_size / 2000
            return max(1.0, estimated_duration)  # At least 1 second

    async def _download_media(
        self, url: str, frame_index: int, task_id: str, media_type: str
    ) -> str:
        """Download media (image or video) from URL to local file"""
        import os

        from pixelle_video.utils.os_util import get_task_frame_path

        output_path = get_task_frame_path(task_id, frame_index, media_type)

        if url.startswith("file://"):
            local_path = url[7:]
            self._require_local_media(local_path, media_type)
            return local_path

        if os.path.exists(url):
            self._require_local_media(url, media_type)
            return url

        timeout = httpx.Timeout(connect=10.0, read=60, write=60, pool=60)
        async with httpx.AsyncClient(timeout=timeout) as client:
            response = await client.get(url)
            response.raise_for_status()

            with open(output_path, "wb") as f:
                f.write(response.content)

        self._require_local_media(output_path, media_type)
        return output_path

    @staticmethod
    def _require_local_media(path: str, media_type: str) -> None:
        from pathlib import Path

        target = Path(path).expanduser()
        if not target.is_file() or target.stat().st_size <= 0:
            raise FileNotFoundError(f"Generated media file not found or empty: {target}")
        expected = ".png" if media_type == "image" else ".mp4"
        if target.suffix.lower() != expected:
            raise ValueError(
                f"Generated {media_type} file has an invalid extension: "
                f"{target.name} (expected {expected})"
            )

    async def _get_video_duration(self, video_path: str) -> float:
        """Get video duration in seconds"""
        try:
            import ffmpeg

            probe = ffmpeg.probe(video_path)
            duration = float(probe["format"]["duration"])
            return duration
        except Exception as e:
            logger.warning(f"Failed to get video duration: {e}, using audio duration")
            # Fallback: use audio duration if available
            return 1.0  # Default to 1 second if unable to determine
