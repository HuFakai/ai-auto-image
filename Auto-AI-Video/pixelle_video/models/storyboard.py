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
Storyboard data models for video generation
"""

from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Dict, List, Optional


@dataclass
class StoryboardConfig:
    """Storyboard configuration parameters"""
    
    # Required parameters (must come first in dataclass)
    media_width: int                           # Media width (image or video, required)
    media_height: int                          # Media height (image or video, required)
    
    # Task isolation
    task_id: Optional[str] = None              # Task ID for file isolation (auto-generated if None)
    
    n_storyboard: int = 5                      # Number of storyboard frames
    min_narration_words: int = 5               # Min narration word count
    max_narration_words: int = 20              # Max narration word count
    min_image_prompt_words: int = 30           # Min image prompt word count
    max_image_prompt_words: int = 60           # Max image prompt word count
    
    # Video parameters (fps only, size is determined by frame template)
    video_fps: int = 30                        # Frame rate
    render_engine: str = "hyperframes"  # Frozen renderer selection
    renderer_version: str = "0.8.4"  # Frozen renderer version
    image_motion: str = "none"                # Global fallback motion preset
    transition: str = "none"                  # Global fallback transition preset
    transition_duration: float = 0.35          # Transition duration in seconds
    subtitle_effect: str = "static"           # Frozen requested subtitle animation
    subtitle_effect_applied: str = "static"   # Actual renderer behavior
    subtitle_effect_fallback_reason: Optional[str] = None
    
    # Audio parameters
    voice_id: Optional[str] = None             # Edge TTS voice ID
    tts_speed: Optional[float] = None          # TTS speed multiplier (0.5-2.0, 1.0 = normal)
    
    # Media workflow
    media_workflow: Optional[str] = None       # Media workflow filename (image or video, None = use default)
    api_video_params: Optional[Dict[str, Any]] = None  # Extra direct API video generation parameters
    
    # Frame template (includes size information in path)
    frame_template: Optional[str] = "1080x1920/default.html"  # None for standalone renderers
    template_sha256: Optional[str] = None          # Frozen template content fingerprint
    template_snapshot_path: Optional[str] = None   # Task-owned immutable HTML copy
    template_params: Optional[Dict[str, Any]] = None  # Custom template parameters (e.g., {"accent_color": "#ff0000"})

    # HyperFrames task artifacts
    hyperframes_project_path: Optional[str] = None
    hyperframes_manifest_path: Optional[str] = None
    hyperframes_check_report_path: Optional[str] = None
    hyperframes_render_id: Optional[str] = None
    hyperframes_template_id: Optional[str] = None
    hyperframes_template_version: Optional[int] = None
    hyperframes_template_fingerprint: Optional[str] = None
    hyperframes_template_variables: Optional[Dict[str, Any]] = None
    whiteboard: Optional[Dict[str, Any]] = None
    render_fallback_reason: Optional[str] = None
    voice_volume: float = 1.0                  # TTS volume multiplier (0.0-1.5, 1.0 = original)


@dataclass
class StoryboardFrame:
    """Single storyboard frame"""
    index: int                                 # Frame index (0-based)
    narration: str                             # Narration text
    image_prompt: str                          # Image generation prompt (can be None for text-only or video)
    
    # Generated resource paths
    audio_path: Optional[str] = None           # Audio file path (narration)
    media_type: Optional[str] = None           # Media type: "image" or "video" (None if no media)
    image_path: Optional[str] = None           # Original image path (for image type)
    video_path: Optional[str] = None           # Original video path (for video type, before composition)
    composed_image_path: Optional[str] = None  # Composed image path (with subtitles, for image type)
    overlay_image_path: Optional[str] = None   # Transparent HTML text/decor layer
    subtitle_overlay_path: Optional[str] = None  # Transparent subtitle-only animation layer
    whiteboard_silent_path: Optional[str] = None
    whiteboard_analysis_path: Optional[str] = None
    video_segment_path: Optional[str] = None   # Final video segment path
    
    # Metadata
    duration: float = 0.0                      # Frame duration (seconds, from audio or video)
    image_motion: Optional[str] = None         # Frozen scene-level camera move
    transition: Optional[str] = None           # Transition entering this scene
    transition_duration: Optional[float] = None
    direction_reason: Optional[str] = None
    subtitle_effect: Optional[str] = None        # Scene override; None inherits config
    subtitle_effect_applied: Optional[str] = None
    subtitle_effect_fallback_reason: Optional[str] = None
    subtitle_keywords: List[str] = field(default_factory=list)
    subtitle_start_offset: float = 0.0           # Seconds after scene start
    subtitle_end_offset: float = 0.0             # Seconds before scene end
    focus_x: Optional[float] = None             # Normalized subject anchor (0..1)
    focus_y: Optional[float] = None
    focus_confidence: Optional[float] = None
    focus_source: Optional[str] = None          # detector/version or explicit user input
    created_at: Optional[datetime] = None
    
    def __post_init__(self):
        if self.created_at is None:
            self.created_at = datetime.now()


@dataclass
class ContentMetadata:
    """Content metadata for visual display and narration generation"""
    title: str                                 # Content title
    author: Optional[str] = None               # Author/creator
    subtitle: Optional[str] = None             # Subtitle
    genre: Optional[str] = None                # Genre/category
    summary: Optional[str] = None              # Content summary
    publication_year: Optional[str] = None     # Publication year
    cover_url: Optional[str] = None            # Cover/thumbnail image URL


@dataclass
class Storyboard:
    """Complete storyboard"""
    title: str                                 # Video title
    config: StoryboardConfig                   # Configuration
    frames: List[StoryboardFrame] = field(default_factory=list)
    
    # Content metadata (optional)
    content_metadata: Optional[ContentMetadata] = None
    
    # Final output
    final_video_path: Optional[str] = None
    cover_image_path: Optional[str] = None
    cover_duration: float = 0.0
    total_duration: float = 0.0
    
    # Metadata
    created_at: Optional[datetime] = None
    completed_at: Optional[datetime] = None
    
    def __post_init__(self):
        if self.created_at is None:
            self.created_at = datetime.now()
    
    @property
    def is_completed(self) -> bool:
        """Check if all frames are processed"""
        return all(
            frame.video_segment_path is not None
            for frame in self.frames
        )
    
    @property
    def progress(self) -> float:
        """Return processing progress (0.0-1.0)"""
        if not self.frames:
            return 0.0
        completed = sum(
            1 for frame in self.frames
            if frame.video_segment_path is not None
        )
        return completed / len(self.frames)


@dataclass
class VideoGenerationResult:
    """Video generation result"""
    video_path: str                            # Final video path
    storyboard: Storyboard                     # Complete storyboard
    duration: float                            # Total duration
    file_size: int                             # File size (bytes)
    created_at: datetime = field(default_factory=datetime.now)
