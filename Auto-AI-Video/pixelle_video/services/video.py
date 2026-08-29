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
Video Processing Service

High-performance video composition service built on ffmpeg-python.

Features:
- Video concatenation
- Audio/video merging
- Background music addition
- Image to video conversion

Note: Requires FFmpeg to be installed on the system.
"""

import os
import re
import shutil
import subprocess
import tempfile
import uuid
from pathlib import Path
from typing import List, Literal, Optional

import ffmpeg
from loguru import logger

from pixelle_video.utils.os_util import (
    get_output_path,
    get_resource_path,
    get_temp_path,
    list_resource_files,
    resource_exists,
    which_ffmpeg,
)

_COMPOSITOR_TEMP_FILE = re.compile(
    r"^(?:trimmed|padded|black_pad)_[0-9a-f]{8}_.+"
)


def check_ffmpeg() -> None:
    """
    Check if FFmpeg is installed on the system
    
    Raises:
        RuntimeError: If FFmpeg is not found
    """
    if not which_ffmpeg():
        raise RuntimeError(
            "FFmpeg not found. Please install it:\n"
            "  macOS: brew install ffmpeg\n"
            "  Ubuntu/Debian: apt-get install ffmpeg\n"
            "  Windows: 双击 Windows一键启动.bat 安装项目内 FFmpeg，或把 ffmpeg 加入 PATH"
        )


def prune_stale_video_temp_media() -> dict[str, object]:
    """Remove compositor-owned temp leftovers after a clean process restart."""
    temp_root = Path(get_temp_path()).resolve()
    removed_files = 0
    removed_directories = 0
    removed_bytes = 0
    skipped: list[dict[str, str]] = []

    for child in temp_root.iterdir():
        if child.is_symlink():
            skipped.append({"path": str(child), "reason": "symbolic link"})
            continue
        if child.is_file():
            if not _COMPOSITOR_TEMP_FILE.fullmatch(child.name):
                continue
            try:
                removed_bytes += child.stat().st_size
                child.unlink()
                removed_files += 1
            except OSError as exc:
                skipped.append({"path": str(child), "reason": str(exc)})
            continue
        if not child.is_dir() or not re.fullmatch(r"[a-zA-Z0-9_-]+", child.name):
            continue

        entries = list(child.rglob("*"))
        owned_files = [item for item in entries if item.is_file()]
        if any(item.is_symlink() for item in entries) or any(
            not _COMPOSITOR_TEMP_FILE.fullmatch(item.name) for item in owned_files
        ):
            skipped.append({"path": str(child), "reason": "contains unmanaged files"})
            continue
        try:
            removed_bytes += sum(item.stat().st_size for item in owned_files)
            removed_files += len(owned_files)
            shutil.rmtree(child)
            removed_directories += 1
        except OSError as exc:
            skipped.append({"path": str(child), "reason": str(exc)})

    return {
        "files": removed_files,
        "directories": removed_directories,
        "bytes": removed_bytes,
        "skipped": skipped,
    }


class VideoService:
    """
    Video compositor for common video processing tasks

    Uses ffmpeg-python for high-performance video processing.
    All operations preserve video quality when possible (stream copy).

    Examples:
        >>> compositor = VideoCompositor()
        >>>
        >>> # Concatenate videos
        >>> compositor.concat_videos(
        ...     ["intro.mp4", "main.mp4", "outro.mp4"],
        ...     "final.mp4"
        ... )
        >>>
        >>> # Add voiceover
        >>> compositor.merge_audio_video(
        ...     "visual.mp4",
        ...     "voiceover.mp3",
        ...     "final.mp4"
        ... )
        >>>
        >>> # Add background music
        >>> compositor.add_bgm(
        ...     "video.mp4",
        ...     "music.mp3",
        ...     "final.mp4",
        ...     bgm_volume=0.3
        ... )
        >>>
        >>> # Create video from image + audio
        >>> compositor.create_video_from_image(
        ...     "frame.png",
        ...     "narration.mp3",
        ...     "segment.mp4"
        ... )
    """

    def __init__(self):
        self._ffmpeg_checked = False

    def _ensure_ffmpeg(self):
        """Lazily check FFmpeg availability on first use, not at import time"""
        if not self._ffmpeg_checked:
            check_ffmpeg()
            self._ffmpeg_checked = True

    def concat_videos(
        self,
        videos: List[str],
        output: str,
        method: Literal["demuxer", "filter"] = "demuxer",
        bgm_path: Optional[str] = None,
        bgm_volume: float = 0.2,
        bgm_mode: Literal["once", "loop"] = "loop",
        transition: str | List[str] = "none",
        transition_duration: float | List[float] = 0.35,
    ) -> str:
        """
        Concatenate multiple videos into one

        Args:
            videos: List of video file paths to concatenate
            output: Output video file path
            method: Concatenation method
                - "demuxer": Fast, no re-encoding (requires identical formats)
                - "filter": Slower but handles different formats
            bgm_path: Background music file path (optional)
                - None: No BGM
            transition: Scene transition preset
            transition_duration: Crossfade duration in seconds
        """
        self._ensure_ffmpeg()

        if not videos:
            raise ValueError("Videos list cannot be empty")
        
        from pixelle_video.utils.scene_direction import FFMPEG_TRANSITIONS

        transitions = (
            list(transition)
            if isinstance(transition, list)
            else [transition] * max(len(videos) - 1, 0)
        )
        transition_durations = (
            [float(value) for value in transition_duration]
            if isinstance(transition_duration, list)
            else [float(transition_duration)] * max(len(videos) - 1, 0)
        )
        if len(transitions) != max(len(videos) - 1, 0):
            raise ValueError("Scene transition count must match video boundaries")
        if len(transition_durations) != len(transitions):
            raise ValueError("Scene transition duration count must match transitions")
        unsupported = [
            value for value in transitions if value != "none" and value not in FFMPEG_TRANSITIONS
        ]
        if unsupported:
            raise ValueError(f"Unsupported transitions: {unsupported}")
        if any(
            name != "none" and not 0.05 <= duration <= 2
            for name, duration in zip(transitions, transition_durations)
        ):
            raise ValueError("transition_duration must be between 0.05 and 2")
        logger.info(
            "Concatenating {} videos using {} (transition={})",
            len(videos),
            method,
            transitions,
        )
        concat_output = output if not bgm_path else output.replace(".mp4", "_no_bgm.mp4")
        if len(videos) == 1:
            shutil.copy(videos[0], concat_output)
            concat_result = concat_output
        elif transitions and any(value != "none" for value in transitions):
            concat_result = self._concat_transitions(
                videos,
                concat_output,
                transitions,
                transition_durations,
            )
        elif method == "demuxer":
            concat_result = self._concat_demuxer(videos, concat_output)
        else:
            concat_result = self._concat_filter(videos, concat_output)

        if bgm_path:
            logger.info(f"Adding BGM: {bgm_path} (volume={bgm_volume}, mode={bgm_mode})")
            final_result = self._add_bgm_to_video(
                video=concat_result,
                bgm_path=bgm_path,
                output=output,
                volume=bgm_volume,
                mode=bgm_mode
            )
            
            # Clean up temp file
            if os.path.exists(concat_output):
                os.unlink(concat_output)
            
            return final_result
        return concat_result

    def _concat_transitions(
        self,
        videos: List[str],
        output: str,
        transitions: List[str],
        transition_durations: List[float],
    ) -> str:
        """Apply transitions after each narration boundary without advancing visuals.

        ``xfade`` normally overlaps the tail of the outgoing clip with the start of
        the next clip, which shortens the video timeline while narration remains
        sequential.  That makes every later visual start one transition too early.
        Extend the outgoing still frame instead and start the fade exactly at the
        original boundary, so the next visual and its narration share one timestamp.
        """
        from pixelle_video.utils.scene_direction import FFMPEG_TRANSITIONS

        durations = [self._get_video_duration(video) for video in videos]
        if any(duration <= 0 for duration in durations):
            raise RuntimeError("Could not determine every clip duration for transitions")
        effective_durations = [
            0.001
            if transition == "none"
            else min(
                transition_durations[index],
                durations[index] / 2,
                durations[index + 1] / 2,
            )
            for index, transition in enumerate(transitions)
        ]
        if any(
            value < 0.05 and transitions[index] != "none"
            for index, value in enumerate(effective_durations)
        ):
            raise ValueError("Clips are too short for the selected transitions")

        command = ["ffmpeg", "-y"]
        for video in videos:
            command.extend(["-i", video])

        filters: list[str] = []
        for index in range(len(videos)):
            video_filter = f"[{index}:v]settb=AVTB,setpts=PTS-STARTPTS"
            if index < len(videos) - 1:
                video_filter += (
                    ",tpad=stop_mode=clone:"
                    f"stop_duration={effective_durations[index]:.6f}"
                )
            filters.append(f"{video_filter}[v{index}]")
            filters.append(f"[{index}:a]asetpts=PTS-STARTPTS[a{index}]")

        video_label = "v0"
        timeline_duration = durations[0]
        for index in range(1, len(videos)):
            effective = effective_durations[index - 1]
            next_video = f"vx{index}"
            offset = timeline_duration
            filters.append(
                f"[{video_label}][v{index}]xfade="
                f"transition={FFMPEG_TRANSITIONS.get(transitions[index - 1], 'fade')}:"
                f"duration={effective:.6f}:offset={offset:.6f}[{next_video}]"
            )
            video_label = next_video
            timeline_duration += durations[index]

        filters.append(f"[{video_label}]null[vout]")
        audio_inputs = "".join(f"[a{index}]" for index in range(len(videos)))
        filters.append(
            f"{audio_inputs}concat=n={len(videos)}:v=0:a=1[aout]"
        )

        command.extend(
            [
                "-filter_complex",
                ";".join(filters),
                "-map",
                "[vout]",
                "-map",
                "[aout]",
                "-c:v",
                "libx264",
                "-preset",
                "medium",
                "-crf",
                "23",
                "-pix_fmt",
                "yuv420p",
                "-c:a",
                "aac",
                "-b:a",
                "192k",
                "-movflags",
                "+faststart",
                output,
            ]
        )
        try:
            subprocess.run(command, capture_output=True, text=True, check=True)
        except subprocess.CalledProcessError as exc:
            error = exc.stderr or str(exc)
            raise RuntimeError(f"Failed to transition videos: {error}") from exc
        logger.success(f"Video transitions completed successfully: {output}")
        return output
    
    def _concat_demuxer(self, videos: List[str], output: str) -> str:
        """
        Concatenate using concat demuxer (fast, no re-encoding)
        
        FFmpeg equivalent:
            ffmpeg -f concat -safe 0 -i filelist.txt -c copy output.mp4
        """
        # Create temporary file list
        with tempfile.NamedTemporaryFile(
            mode='w',
            delete=False,
            suffix='.txt',
            encoding='utf-8'
        ) as f:
            for video in videos:
                abs_path = Path(video).absolute()
                escaped_path = str(abs_path).replace("'", "'\\''")
                f.write(f"file '{escaped_path}'\n")
            filelist = f.name
        
        try:
            logger.debug(f"Created filelist: {filelist}")
            (
                ffmpeg
                .input(filelist, format='concat', safe=0)
                .output(output, c='copy')
                .overwrite_output()
                .run(capture_stdout=True, capture_stderr=True)
            )
            logger.success(f"Videos concatenated successfully: {output}")
            return output
        except ffmpeg.Error as e:
            error_msg = e.stderr.decode() if e.stderr else str(e)
            logger.error(f"FFmpeg concat error: {error_msg}")
            raise RuntimeError(f"Failed to concatenate videos: {error_msg}")
        finally:
            if os.path.exists(filelist):
                os.unlink(filelist)
    
    def _concat_filter(self, videos: List[str], output: str) -> str:
        """
        Concatenate using concat filter (slower but handles different formats)
        
        FFmpeg equivalent:
            ffmpeg -i v1.mp4 -i v2.mp4 -filter_complex "[0:v][0:a][1:v][1:a]concat=n=2:v=1:a=1[v][a]"
                   -map "[v]" -map "[a]" output.mp4
        """
        try:
            # Build filter_complex string manually
            n = len(videos)
            
            # Build input stream labels: [0:v][0:a][1:v][1:a]...
            stream_spec = "".join([f"[{i}:v][{i}:a]" for i in range(n)])
            filter_complex = f"{stream_spec}concat=n={n}:v=1:a=1[v][a]"
            
            # Build ffmpeg command
            cmd = ['ffmpeg']
            for video in videos:
                cmd.extend(['-i', video])
            cmd.extend([
                '-filter_complex', filter_complex,
                '-map', '[v]',
                '-map', '[a]',
                '-y',  # Overwrite output
                output
            ])
            
            # Run command
            subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                check=True
            )
            
            logger.success(f"Videos concatenated successfully: {output}")
            return output
        except subprocess.CalledProcessError as e:
            error_msg = e.stderr if e.stderr else str(e)
            logger.error(f"FFmpeg concat filter error: {error_msg}")
            raise RuntimeError(f"Failed to concatenate videos: {error_msg}")
        except Exception as e:
            logger.error(f"Concatenation error: {e}")
            raise RuntimeError(f"Failed to concatenate videos: {e}")
    
    def _get_video_duration(self, video: str) -> float:
        """Get video duration in seconds"""
        try:
            probe = ffmpeg.probe(video)
            duration = float(probe['format']['duration'])
            return duration
        except Exception as e:
            logger.warning(f"Failed to get video duration: {e}")
            return 0.0
    
    def _get_audio_duration(self, audio: str) -> float:
        """Get audio duration in seconds"""
        try:
            probe = ffmpeg.probe(audio)
            duration = float(probe['format']['duration'])
            return duration
        except Exception as e:
            logger.warning(f"Failed to get audio duration: {e}, using estimate")
            # Fallback: estimate based on file size (very rough)
            import os
            file_size = os.path.getsize(audio)
            # Assume ~16kbps for MP3, so 2KB per second
            estimated_duration = file_size / 2000
            return max(1.0, estimated_duration)  # At least 1 second
    
    def has_audio_stream(self, video: str) -> bool:
        """
        Check if video has audio stream
        
        Args:
            video: Video file path
        
        Returns:
            True if video has audio stream, False otherwise
        """
        try:
            probe = ffmpeg.probe(video)
            audio_streams = [s for s in probe.get('streams', []) if s['codec_type'] == 'audio']
            has_audio = len(audio_streams) > 0
            logger.debug(f"Video {video} has_audio={has_audio}")
            return has_audio
        except Exception as e:
            logger.warning(f"Failed to probe video audio streams: {e}, assuming no audio")
            return False
    
    def merge_audio_video(
        self,
        video: str,
        audio: str,
        output: str,
        replace_audio: bool = True,
        audio_volume: float = 1.0,
        video_volume: float = 0.0,
        pad_strategy: str = "freeze",  # "freeze" (freeze last frame) or "black" (black screen)
        auto_adjust_duration: bool = True,  # Automatically adjust video duration to match audio
        duration_tolerance: float = 0.3,  # Tolerance for video being longer than audio (seconds)
    ) -> str:
        """
        Merge audio with video with intelligent duration adjustment
        
        Automatically handles duration mismatches between video and audio:
        - If video < audio: Pad video to match audio (avoid black screen)
        - If video > audio (within tolerance): Keep as-is (acceptable)
        - If video > audio (exceeds tolerance): Trim video to match audio
        
        Automatically handles videos with or without audio streams.
        - If video has no audio: adds the audio track
        - If video has audio and replace_audio=True: replaces with new audio
        - If video has audio and replace_audio=False: mixes both audio tracks
        
        Args:
            video: Video file path
            audio: Audio file path
            output: Output video file path
            replace_audio: If True, replace video's audio; if False, mix with original
            audio_volume: Volume of the new audio (0.0 to 1.0+)
            video_volume: Volume of original video audio (0.0 to 1.0+)
                         Only used when replace_audio=False
            pad_strategy: Strategy to pad video if audio is longer
                         - "freeze": Freeze last frame (default)
                         - "black": Fill with black screen
            auto_adjust_duration: Enable intelligent duration adjustment (default: True)
            duration_tolerance: Tolerance for video being longer than audio in seconds (default: 0.3)
                              Videos within this tolerance won't be trimmed
        
        Returns:
            Path to the output video file
        
        Raises:
            RuntimeError: If FFmpeg execution fails
        
        Note:
            - Uses the longer duration between video and audio
            - When audio is longer, video is padded using pad_strategy
            - When video is longer, audio is looped or extended
            - Automatically detects if video has audio
            - When video is silent, audio is added regardless of replace_audio
            - When replace_audio=True and video has audio, original audio is removed
            - When replace_audio=False and video has audio, original and new audio are mixed
        """
        self._ensure_ffmpeg()
        temporary_video: str | None = None

        # Get durations of video and audio
        video_duration = self._get_video_duration(video)
        audio_duration = self._get_audio_duration(audio)
        
        logger.info(f"Video duration: {video_duration:.2f}s, Audio duration: {audio_duration:.2f}s")
        
        # Intelligent duration adjustment (if enabled)
        if auto_adjust_duration:
            diff = video_duration - audio_duration
            
            if diff < 0:
                # Video shorter than audio → Must pad to avoid black screen
                logger.warning(f"⚠️ Video shorter than audio by {abs(diff):.2f}s, padding required")
                adjusted_video = self._pad_video_to_duration(
                    video, audio_duration, pad_strategy
                )
                if adjusted_video != video:
                    temporary_video = adjusted_video
                video = adjusted_video
                video_duration = audio_duration  # Update duration after padding
                logger.info(f"📌 Padded video to {audio_duration:.2f}s")
            
            elif diff > duration_tolerance:
                # Video significantly longer than audio → Trim
                logger.info(f"⚠️ Video longer than audio by {diff:.2f}s (tolerance: {duration_tolerance}s)")
                adjusted_video = self._trim_video_to_duration(video, audio_duration)
                if adjusted_video != video:
                    temporary_video = adjusted_video
                video = adjusted_video
                video_duration = audio_duration  # Update duration after trimming
                logger.info(f"✂️ Trimmed video to {audio_duration:.2f}s")
            
            else:  # 0 <= diff <= duration_tolerance
                # Video slightly longer but within tolerance → Keep as-is
                logger.info(f"✅ Duration acceptable: video={video_duration:.2f}s, audio={audio_duration:.2f}s (diff={diff:.2f}s)")
        
        # Determine target duration (max of both)
        target_duration = max(video_duration, audio_duration)
        logger.info(f"Target output duration: {target_duration:.2f}s")
        
        # Check if video has audio stream
        video_has_audio = self.has_audio_stream(video)
        
        # Prepare video stream (potentially with padding)
        input_video = ffmpeg.input(video)
        video_stream = input_video.video
        
        # Pad video if audio is longer
        if audio_duration > video_duration:
            pad_duration = audio_duration - video_duration
            logger.info(f"Audio is longer, padding video by {pad_duration:.2f}s using '{pad_strategy}' strategy")
            
            if pad_strategy == "freeze":
                # Freeze last frame: tpad filter
                video_stream = video_stream.filter('tpad', stop_mode='clone', stop_duration=pad_duration)
            else:  # black
                # Generate black frames for padding duration
                # Get video properties
                probe = ffmpeg.probe(video)
                video_info = next(s for s in probe['streams'] if s['codec_type'] == 'video')
                width = int(video_info['width'])
                height = int(video_info['height'])
                fps_str = video_info['r_frame_rate']
                fps_num, fps_den = map(int, fps_str.split('/'))
                fps = fps_num / fps_den if fps_den != 0 else 30
                
                # Create black video for padding
                black_input = ffmpeg.input(
                    f'color=c=black:s={width}x{height}:r={fps}',
                    f='lavfi',
                    t=pad_duration
                )
                
                # Concatenate original video with black padding
                video_stream = ffmpeg.concat(video_stream, black_input.video, v=1, a=0)
        
        # Prepare audio stream (pad if needed to match target duration)
        input_audio = ffmpeg.input(audio)
        audio_stream = input_audio.audio.filter('volume', audio_volume)
        
        # Pad audio with silence if video is longer
        if video_duration > audio_duration:
            pad_duration = video_duration - audio_duration
            logger.info(f"Video is longer, padding audio with {pad_duration:.2f}s silence")
            # Use apad to add silence at the end
            audio_stream = audio_stream.filter('apad', whole_dur=target_duration)
        
        if not video_has_audio:
            logger.info("Video has no audio stream, adding audio track")
            # Video is silent, just add the audio
            try:
                (
                    ffmpeg
                    .output(
                        video_stream,
                        audio_stream,
                        output,
                        vcodec='libx264',  # Re-encode video if padded
                        acodec='aac',
                        audio_bitrate='192k'
                    )
                    .overwrite_output()
                    .run(capture_stdout=True, capture_stderr=True)
                )
                
                logger.success(f"Audio added to silent video: {output}")
                return output
            except ffmpeg.Error as e:
                error_msg = e.stderr.decode() if e.stderr else str(e)
                logger.error(f"FFmpeg error adding audio to silent video: {error_msg}")
                raise RuntimeError(f"Failed to add audio to video: {error_msg}")
            finally:
                self._cleanup_temp_media(temporary_video)
        
        # Video has audio, proceed with merging
        logger.info(f"Merging audio with video (replace={replace_audio})")
        
        try:
            if replace_audio:
                # Replace audio: use only new audio, ignore original
                (
                    ffmpeg
                    .output(
                        video_stream,
                        audio_stream,
                        output,
                        vcodec='libx264',  # Re-encode video if padded
                        acodec='aac',
                        audio_bitrate='192k'
                    )
                    .overwrite_output()
                    .run(capture_stdout=True, capture_stderr=True)
                )
            else:
                # Mix audio: combine original and new audio
                mixed_audio = ffmpeg.filter(
                    [
                        input_video.audio.filter('volume', video_volume),
                        audio_stream
                    ],
                    'amix',
                    inputs=2,
                    duration='longest'  # Use longest audio
                )
                
                (
                    ffmpeg
                    .output(
                        video_stream,
                        mixed_audio,
                        output,
                        vcodec='libx264',  # Re-encode video if padded
                        acodec='aac',
                        audio_bitrate='192k'
                    )
                    .overwrite_output()
                    .run(capture_stdout=True, capture_stderr=True)
                )
            
            logger.success(f"Audio merged successfully: {output}")
            return output
        except ffmpeg.Error as e:
            error_msg = e.stderr.decode() if e.stderr else str(e)
            logger.error(f"FFmpeg merge error: {error_msg}")
            raise RuntimeError(f"Failed to merge audio and video: {error_msg}")
        finally:
            self._cleanup_temp_media(temporary_video)
    
    def overlay_image_on_video(
        self,
        video: str,
        overlay_image: str,
        output: str,
        scale_mode: str = "contain",
        subtitle_effect: str = "static",
        subtitle_overlay: Optional[str] = None,
        subtitle_start_offset: float = 0.0,
        subtitle_end_offset: float = 0.0,
        subtitle_duration: Optional[float] = None,
    ) -> str:
        """
        Overlay a transparent image on top of video
        
        Args:
            video: Base video file path
            overlay_image: Transparent overlay image path (e.g., rendered HTML with transparent background)
            output: Output video file path
            scale_mode: How to scale the base video to fit the overlay size
                - "contain": Scale video to fit within overlay dimensions (letterbox/pillarbox)
                - "cover": Scale video to cover overlay dimensions (may crop)
                - "stretch": Stretch video to exact overlay dimensions
        
        Returns:
            Path to the output video file
        
        Raises:
            RuntimeError: If FFmpeg execution fails
        
        Note:
            - Overlay image should have transparent background
            - Video is scaled to match overlay dimensions based on scale_mode
            - Final video size matches overlay image size
            - Video codec is re-encoded to support overlay
        """
        self._ensure_ffmpeg()
        logger.info(f"Overlaying image on video (scale_mode={scale_mode})")
        
        try:
            # Get overlay image dimensions
            overlay_probe = ffmpeg.probe(overlay_image)
            overlay_stream = next(s for s in overlay_probe['streams'] if s['codec_type'] == 'video')
            overlay_width = int(overlay_stream['width'])
            overlay_height = int(overlay_stream['height'])
            
            logger.debug(f"Overlay dimensions: {overlay_width}x{overlay_height}")
            
            input_video = ffmpeg.input(video)
            input_overlay = ffmpeg.input(overlay_image, loop=1, framerate=30)
            
            # Scale video to fit overlay size using scale_mode
            if scale_mode == "contain":
                # Scale to fit (letterbox/pillarbox if aspect ratio differs)
                # Use scale filter with force_original_aspect_ratio=decrease and pad to center
                scaled_video = (
                    input_video
                    .filter('scale', overlay_width, overlay_height, force_original_aspect_ratio='decrease')
                    .filter('pad', overlay_width, overlay_height, '(ow-iw)/2', '(oh-ih)/2', color='black')
                )
            elif scale_mode == "cover":
                # Scale to cover (crop if aspect ratio differs)
                scaled_video = (
                    input_video
                    .filter('scale', overlay_width, overlay_height, force_original_aspect_ratio='increase')
                    .filter('crop', overlay_width, overlay_height)
                )
            else:  # stretch
                # Stretch to exact dimensions
                scaled_video = input_video.filter('scale', overlay_width, overlay_height)
            
            # Static chrome is composited first and never participates in subtitle motion.
            output_stream = self._overlay_static_layer(
                scaled_video,
                input_overlay,
                shortest=1,
            )
            if subtitle_overlay:
                subtitle_stream = ffmpeg.input(subtitle_overlay, loop=1, framerate=30)
                output_stream = self._overlay_subtitle_layer(
                    output_stream,
                    subtitle_stream,
                    subtitle_effect,
                    shortest=1,
                    start_offset=subtitle_start_offset,
                    end_offset=subtitle_end_offset,
                    duration=subtitle_duration,
                )
            elif subtitle_effect != "static":
                raise ValueError(
                    "Animated native subtitles require a subtitle-only overlay"
                )
            
            (
                ffmpeg
                .output(output_stream, output, 
                        vcodec='libx264',
                        pix_fmt='yuv420p',
                        preset='medium',
                        crf=23)
                .overwrite_output()
                .run(capture_stdout=True, capture_stderr=True)
            )
            
            logger.success(f"Image overlaid on video: {output}")
            return output
        except ffmpeg.Error as e:
            error_msg = e.stderr.decode() if e.stderr else str(e)
            logger.error(f"FFmpeg overlay error: {error_msg}")
            raise RuntimeError(f"Failed to overlay image on video: {error_msg}")
    
    def create_video_from_image(
        self,
        image: str,
        audio: str,
        output: str,
        fps: int = 30,
        motion: str = "none",
        overlay: Optional[str] = None,
        subtitle_overlay: Optional[str] = None,
        focus_x: Optional[float] = None,
        focus_y: Optional[float] = None,
        subtitle_effect: str = "static",
        subtitle_start_offset: float = 0.0,
        subtitle_end_offset: float = 0.0,
    ) -> str:
        """
        Create video from static image and audio
        
        Args:
            image: Image file path
            audio: Audio file path
            output: Output video path
            fps: Frames per second
            motion: Deterministic light-motion preset
            overlay: Optional transparent static chrome layer
            subtitle_overlay: Optional transparent subtitle-only layer
            focus_x: Normalized horizontal subject anchor (0..1)
            focus_y: Normalized vertical subject anchor (0..1)
        
        Returns:
            Path to the output video
        
        Raises:
            RuntimeError: If FFmpeg execution fails
        
        Note:
            - Image is displayed as static frame for the duration of audio
            - Video duration matches audio duration
            - Useful for creating video segments from storyboard frames
        
        Example:
            >>> compositor.create_video_from_image(
            ...     "frame.png",
            ...     "narration.mp3",
            ...     "segment.mp4"
            ... )
        """
        self._ensure_ffmpeg()
        logger.info("Creating video from image and audio")
        
        try:
            # Get audio duration to ensure exact video duration match
            probe = ffmpeg.probe(audio)
            audio_duration = float(probe['format']['duration'])
            logger.debug(f"Audio duration: {audio_duration:.3f}s")
            
            input_image = ffmpeg.input(image, loop=1, framerate=fps)
            input_audio = ffmpeg.input(audio)
            video_stream = input_image
            width = height = None
            from pixelle_video.services.focal_point import clamp_focus, cover_crop

            focal_x = clamp_focus(focus_x)
            focal_y = clamp_focus(focus_y)
            if overlay:
                overlay_probe = ffmpeg.probe(overlay)
                overlay_info = next(
                    stream
                    for stream in overlay_probe["streams"]
                    if stream["codec_type"] == "video"
                )
                width = int(overlay_info["width"])
                height = int(overlay_info["height"])
                image_probe = ffmpeg.probe(image)
                image_info = next(
                    stream
                    for stream in image_probe["streams"]
                    if stream["codec_type"] == "video"
                )
                crop = cover_crop(
                    int(image_info["width"]),
                    int(image_info["height"]),
                    width,
                    height,
                    focal_x,
                    focal_y,
                )
                video_stream = (
                    input_image.filter(
                        "scale",
                        crop.scaled_width,
                        crop.scaled_height,
                    ).filter("crop", width, height, crop.crop_x, crop.crop_y)
                )
                input_image = video_stream
                focal_x = crop.focus_x
                focal_y = crop.focus_y
            if motion != "none":
                if motion == "slow_pan":
                    motion = "pan_right"
                if motion not in {
                    "ken_burns",
                    "push_in",
                    "pull_out",
                    "pan_left",
                    "pan_right",
                    "pan_up",
                    "pan_down",
                }:
                    raise ValueError(f"Unsupported image motion: {motion}")
                if width is None or height is None:
                    image_probe = ffmpeg.probe(image)
                    image_stream = next(
                        stream
                        for stream in image_probe["streams"]
                        if stream["codec_type"] == "video"
                    )
                    width = int(image_stream["width"])
                    height = int(image_stream["height"])
                frame_count = max(round(audio_duration * fps), 1)
                zoom_step = 0.10 / frame_count
                zoom = f"min(zoom+{zoom_step:.10f},1.10)"
                x_base = (
                    f"max(0,min(iw-iw/zoom,iw*{focal_x:.6f}-iw/(2*zoom)))"
                )
                y_base = (
                    f"max(0,min(ih-ih/zoom,ih*{focal_y:.6f}-ih/(2*zoom)))"
                )
                x = x_base
                y = y_base
                divisor = max(frame_count - 1, 1)
                if motion == "pull_out":
                    zoom = f"if(eq(on,0),1.10,max(zoom-{zoom_step:.10f},1.0))"
                elif motion == "pan_left":
                    zoom = "1.10"
                    x = (
                        f"max(0,min(iw-iw/zoom,{x_base}+"
                        f"(iw-iw/zoom)*0.18*(1-2*on/{divisor})))"
                    )
                elif motion == "pan_right":
                    zoom = "1.10"
                    x = (
                        f"max(0,min(iw-iw/zoom,{x_base}-"
                        f"(iw-iw/zoom)*0.18*(1-2*on/{divisor})))"
                    )
                elif motion == "pan_up":
                    zoom = "1.10"
                    y = (
                        f"max(0,min(ih-ih/zoom,{y_base}+"
                        f"(ih-ih/zoom)*0.18*(1-2*on/{divisor})))"
                    )
                elif motion == "pan_down":
                    zoom = "1.10"
                    y = (
                        f"max(0,min(ih-ih/zoom,{y_base}-"
                        f"(ih-ih/zoom)*0.18*(1-2*on/{divisor})))"
                    )
                video_stream = input_image.filter(
                    "zoompan",
                    z=zoom,
                    x=x,
                    y=y,
                    d=frame_count,
                    s=f"{width}x{height}",
                    fps=fps,
                )
            if overlay:
                input_overlay = ffmpeg.input(overlay, loop=1, framerate=fps)
                video_stream = self._overlay_static_layer(
                    video_stream,
                    input_overlay,
                )
            if subtitle_overlay:
                input_subtitle = ffmpeg.input(subtitle_overlay, loop=1, framerate=fps)
                video_stream = self._overlay_subtitle_layer(
                    video_stream,
                    input_subtitle,
                    subtitle_effect,
                    start_offset=subtitle_start_offset,
                    end_offset=subtitle_end_offset,
                    duration=audio_duration,
                )
            elif subtitle_effect != "static":
                raise ValueError(
                    "Animated native subtitles require a subtitle-only overlay"
                )
            
            # Combine image and audio
            # Use -t to explicitly set video duration = audio duration
            (
                ffmpeg
                .output(
                    video_stream,
                    input_audio,
                    output,
                    t=audio_duration,  # Force video duration to match audio exactly
                    vcodec='libx264',
                    acodec='aac',
                    pix_fmt='yuv420p',
                    audio_bitrate='192k',
                    preset='medium',
                    crf=23,
                    **{'b:v': '2M'}  # Video bitrate
                )
                .overwrite_output()
                .run(capture_stdout=True, capture_stderr=True)
            )
            
            logger.success(
                f"Video created from image: {output} "
                f"(duration: {audio_duration:.3f}s, motion={motion})"
            )
            return output
        except ffmpeg.Error as e:
            error_msg = e.stderr.decode() if e.stderr else str(e)
            logger.error(f"FFmpeg error creating video from image: {error_msg}")
            raise RuntimeError(f"Failed to create video from image: {error_msg}")

    @staticmethod
    def _overlay_static_layer(base_stream, overlay_stream, *, shortest: int = 0):
        """Overlay chrome without applying subtitle animation."""

        options = {"eof_action": "repeat"}
        if shortest:
            options["shortest"] = shortest
        return ffmpeg.overlay(base_stream, overlay_stream, **options)

    @staticmethod
    def _overlay_subtitle_layer(
        base_stream,
        overlay_stream,
        subtitle_effect: str,
        *,
        shortest: int = 0,
        start_offset: float = 0.0,
        end_offset: float = 0.0,
        duration: Optional[float] = None,
    ):
        """Overlay a static or seek-deterministic fade-up subtitle layer."""

        if subtitle_effect not in {"static", "fade_up"}:
            raise ValueError(
                "Native subtitle overlay only supports static or fade_up; "
                f"got {subtitle_effect}"
            )
        options = {"eof_action": "repeat"}
        if shortest:
            options["shortest"] = shortest
        start_offset = max(float(start_offset or 0), 0)
        end_offset = max(float(end_offset or 0), 0)
        if start_offset > 0 or end_offset > 0:
            visible_end = max(float(duration or 86400) - end_offset, start_offset + 0.1)
            options["enable"] = f"between(t,{start_offset:.3f},{visible_end:.3f})"
        if subtitle_effect == "fade_up":
            visible_window = max(float(duration or 1) - start_offset - end_offset, 0.1)
            fade_start = start_offset + min(0.08, max(visible_window * 0.3, 0.02))
            fade_duration = min(0.48, max((float(duration or 1) - start_offset - end_offset) / 2, 0.1))
            overlay_stream = (
                overlay_stream.filter("format", "rgba")
                .filter(
                    "fade",
                    type="in",
                    start_time=fade_start,
                    duration=fade_duration,
                    alpha=1,
                )
            )
            options.update(
                y=(
                    "H*0.018*(1-min(max((t-"
                    f"{fade_start:.3f})/{fade_duration:.3f},0),1))"
                ),
                eval="frame",
            )
        return ffmpeg.overlay(base_stream, overlay_stream, **options)
    
    def add_bgm(
        self,
        video: str,
        bgm: str,
        output: str,
        bgm_volume: float = 0.3,
        loop: bool = True,
        fade_in: float = 0.0,
        fade_out: float = 0.0,
    ) -> str:
        """
        Add background music to video
        
        Args:
            video: Video file path
            bgm: Background music file path
            output: Output video file path
            bgm_volume: BGM volume relative to original (0.0 to 1.0+)
            loop: If True, loop BGM to match video duration
            fade_in: BGM fade-in duration in seconds
            fade_out: BGM fade-out duration in seconds (not yet implemented)
        
        Returns:
            Path to the output video file
        
        Raises:
            RuntimeError: If FFmpeg execution fails
        
        Note:
            - BGM is mixed with original video audio
            - If loop=True, BGM repeats until video ends
            - Fade effects are applied to BGM only
        """
        self._ensure_ffmpeg()
        logger.info(f"Adding BGM to video (volume={bgm_volume}, loop={loop})")
        
        try:
            input_video = ffmpeg.input(video)
            
            # Configure BGM input with looping if needed
            bgm_input = ffmpeg.input(
                bgm,
                stream_loop=-1 if loop else 0  # -1 = infinite loop
            )
            
            # Apply volume adjustment to BGM
            bgm_audio = bgm_input.audio.filter('volume', bgm_volume)
            
            # Apply fade effects if specified
            if fade_in > 0:
                bgm_audio = bgm_audio.filter('afade', type='in', duration=fade_in)
            # Note: fade_out at the end requires knowing the duration, which is complex
            # For now, we skip fade_out in this implementation
            # A more advanced implementation would need to:
            # 1. Get video duration
            # 2. Calculate fade_out start time
            # 3. Apply fade filter with specific start_time
            
            # Mix original audio with BGM
            mixed_audio = ffmpeg.filter(
                [input_video.audio, bgm_audio],
                'amix',
                inputs=2,
                duration='first'  # Use video's duration
            )
            
            (
                ffmpeg
                .output(
                    input_video.video,
                    mixed_audio,
                    output,
                    vcodec='copy',
                    acodec='aac',
                    audio_bitrate='192k'
                )
                .overwrite_output()
                .run(capture_stdout=True, capture_stderr=True)
            )
            
            logger.success(f"BGM added successfully: {output}")
            return output
        except ffmpeg.Error as e:
            error_msg = e.stderr.decode() if e.stderr else str(e)
            logger.error(f"FFmpeg BGM error: {error_msg}")
            raise RuntimeError(f"Failed to add BGM: {error_msg}")
    
    def _add_bgm_to_video(
        self,
        video: str,
        bgm_path: str,
        output: str,
        volume: float = 0.2,
        mode: Literal["once", "loop"] = "loop"
    ) -> str:
        """
        Internal helper to add BGM to video with path resolution
        
        Args:
            video: Video file path
            bgm_path: BGM path (can be preset name or custom path)
            output: Output file path
            volume: BGM volume (0.0-1.0)
            mode: "once" or "loop"
        
        Returns:
            Path to output video
        
        Raises:
            FileNotFoundError: If BGM file not found
        """
        # Resolve BGM path (raises FileNotFoundError if not found)
        resolved_bgm = self._resolve_bgm_path(bgm_path)
        
        # Add BGM using existing method
        loop = (mode == "loop")
        return self.add_bgm(
            video=video,
            bgm=resolved_bgm,
            output=output,
            bgm_volume=volume,
            loop=loop,
            fade_in=0.0
        )
    
    def _get_unique_temp_path(self, prefix: str, original_filename: str) -> str:
        """
        Generate unique temporary file path to avoid concurrent conflicts
        
        Args:
            prefix: Prefix for the temp file (e.g., "trimmed", "padded", "black_pad")
            original_filename: Original filename to preserve in temp path
        
        Returns:
            Unique temporary file path with format: temp/{prefix}_{uuid}_{original_filename}
        
        Example:
            >>> self._get_unique_temp_path("trimmed", "video.mp4")
            >>> # Returns: "temp/trimmed_a3f2d8c1_video.mp4"
        """
        temp_root = Path(get_temp_path()).resolve()
        output_root = Path(get_output_path()).resolve()
        original = Path(original_filename).expanduser()
        original = (
            original.resolve()
            if original.is_absolute()
            else (output_root.parent / original).resolve()
        )
        target_dir = temp_root
        if original.is_relative_to(output_root):
            relative = original.relative_to(output_root)
            if len(relative.parts) > 1:
                candidate = (temp_root / relative.parts[0]).resolve()
                if candidate.parent == temp_root:
                    target_dir = candidate
        target_dir.mkdir(parents=True, exist_ok=True)
        unique_id = uuid.uuid4().hex[:8]
        return str(target_dir / f"{prefix}_{unique_id}_{original.name}")

    def _cleanup_temp_media(self, path: str | None) -> None:
        """Remove a compositor-owned temp file and its now-empty task directory."""
        if not path:
            return
        temp_root = Path(get_temp_path()).resolve()
        candidate = Path(path).expanduser().resolve()
        if candidate == temp_root or not candidate.is_relative_to(temp_root):
            logger.warning(f"Refusing to clean unmanaged temporary media: {candidate}")
            return
        try:
            candidate.unlink(missing_ok=True)
            parent = candidate.parent
            while parent != temp_root:
                try:
                    parent.rmdir()
                except OSError:
                    break
                parent = parent.parent
        except OSError as exc:
            logger.warning(f"Failed to clean temporary media {candidate}: {exc}")
    
    def _resolve_bgm_path(self, bgm_path: str) -> str:
        """
        Resolve BGM path (filename or custom path) with custom override support
        
        Search priority:
            1. Direct path (absolute or relative)
            2. data/bgm/{filename} (custom)
            3. bgm/{filename} (default)
        
        Args:
            bgm_path: Can be:
                - Filename with extension (e.g., "default.mp3", "happy.mp3"): auto-resolved from bgm/ or data/bgm/
                - Custom file path (absolute or relative)
        
        Returns:
            Resolved absolute path
        
        Raises:
            FileNotFoundError: If BGM file not found
        """
        # Try direct path first (absolute or relative)
        if os.path.exists(bgm_path):
            return os.path.abspath(bgm_path)
        
        # Try as filename in resource directories (custom > default)
        if resource_exists("bgm", bgm_path):
            return get_resource_path("bgm", bgm_path)
        
        # Not found - provide helpful error message
        tried_paths = [
            os.path.abspath(bgm_path),
            f"data/bgm/{bgm_path} or bgm/{bgm_path}"
        ]
        
        # List available BGM files
        available_bgm = self._list_available_bgm()
        available_msg = f"\n  Available BGM files: {', '.join(available_bgm)}" if available_bgm else ""
        
        raise FileNotFoundError(
            f"BGM file not found: '{bgm_path}'\n"
            f"  Tried paths:\n"
            f"    1. {tried_paths[0]}\n"
            f"    2. {tried_paths[1]}"
            f"{available_msg}"
        )
    
    def _list_available_bgm(self) -> list[str]:
        """
        List available BGM files (merged from bgm/ and data/bgm/)
        
        Returns:
            List of filenames (with extensions), sorted
        """
        try:
            # Use resource API to get merged list
            all_files = list_resource_files("bgm")
            
            # Filter to audio files only
            audio_extensions = ('.mp3', '.wav', '.ogg', '.flac', '.m4a', '.aac')
            return sorted([f for f in all_files if f.lower().endswith(audio_extensions)])
        except Exception as e:
            logger.warning(f"Failed to list BGM files: {e}")
            return []
    
    def _trim_video_to_duration(self, video: str, target_duration: float) -> str:
        """
        Trim video to specified duration
        
        Args:
            video: Input video file path
            target_duration: Target duration in seconds
        
        Returns:
            Path to trimmed video (temp file)
        
        Raises:
            RuntimeError: If FFmpeg execution fails
        """
        output = self._get_unique_temp_path("trimmed", video)
        
        try:
            # Use stream copy when possible for fast trimming
            input_stream = ffmpeg.input(video, t=target_duration)
            output_kwargs = {"vcodec": "copy"}
            if self.has_audio_stream(video):
                output_kwargs["acodec"] = "copy"
            (
                input_stream
                .output(output, **output_kwargs)
                .overwrite_output()
                .run(capture_stdout=True, capture_stderr=True, quiet=True)
            )
            return output
        except ffmpeg.Error as e:
            self._cleanup_temp_media(output)
            error_msg = e.stderr.decode() if e.stderr else str(e)
            logger.error(f"FFmpeg error trimming video: {error_msg}")
            raise RuntimeError(f"Failed to trim video: {error_msg}")
    
    def _pad_video_to_duration(self, video: str, target_duration: float, pad_strategy: str = "freeze") -> str:
        """
        Pad video to specified duration by extending the last frame or adding black frames
        
        Args:
            video: Input video file path
            target_duration: Target duration in seconds
            pad_strategy: Padding strategy - "freeze" (freeze last frame) or "black" (black screen)
        
        Returns:
            Path to padded video (temp file)
        
        Raises:
            RuntimeError: If FFmpeg execution fails
        """
        output = self._get_unique_temp_path("padded", video)
        
        video_duration = self._get_video_duration(video)
        pad_duration = target_duration - video_duration
        
        if pad_duration <= 0:
            # No padding needed, return original
            return video
        
        try:
            input_video = ffmpeg.input(video)
            video_stream = input_video.video
            
            if pad_strategy == "freeze":
                # Freeze last frame using tpad filter
                video_stream = video_stream.filter('tpad', stop_mode='clone', stop_duration=pad_duration)
                
                # Output with re-encoding (tpad requires it)
                (
                    ffmpeg
                    .output(
                        video_stream,
                        output,
                        vcodec='libx264',
                        preset='fast',
                        crf=23
                    )
                    .overwrite_output()
                    .run(capture_stdout=True, capture_stderr=True, quiet=True)
                )
            else:  # black
                # Generate black frames for padding duration
                # Get video properties
                probe = ffmpeg.probe(video)
                video_info = next(s for s in probe['streams'] if s['codec_type'] == 'video')
                width = int(video_info['width'])
                height = int(video_info['height'])
                fps_str = video_info['r_frame_rate']
                fps_num, fps_den = map(int, fps_str.split('/'))
                fps = fps_num / fps_den if fps_den != 0 else 30
                
                # Create black video for padding
                black_input = ffmpeg.input(
                    f'color=c=black:s={width}x{height}:r={fps}',
                    f='lavfi',
                    t=pad_duration
                )
                
                # Concatenate original video with black padding
                video_stream = ffmpeg.concat(video_stream, black_input.video, v=1, a=0)
                
                (
                    ffmpeg
                    .output(
                        video_stream,
                        output,
                        vcodec='libx264',
                        preset='fast',
                        crf=23
                    )
                    .overwrite_output()
                    .run(capture_stdout=True, capture_stderr=True, quiet=True)
                )
            
            return output
        except ffmpeg.Error as e:
            self._cleanup_temp_media(output)
            error_msg = e.stderr.decode() if e.stderr else str(e)
            logger.error(f"FFmpeg error padding video: {error_msg}")
            raise RuntimeError(f"Failed to pad video: {error_msg}")
