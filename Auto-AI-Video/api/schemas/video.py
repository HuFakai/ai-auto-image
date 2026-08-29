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
Video generation API schemas
"""

from typing import Any, Dict, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from pixelle_video.rendering.subtitle_effects import (
    SUBTITLE_EFFECTS,
    normalize_subtitle_keywords,
)

ImageMotion = Literal[
    "none",
    "slow_pan",
    "ken_burns",
    "push_in",
    "pull_out",
    "pan_left",
    "pan_right",
    "pan_up",
    "pan_down",
]
SceneTransition = Literal[
    "none",
    "crossfade",
    "dissolve",
    "slide_left",
    "slide_right",
    "wipe_up",
    "wipe_down",
    "circle_open",
    "zoom_in",
    "fade_black",
    "blur",
]
SubtitleEffect = Literal["static", "fade_up", "typewriter", "word_pop"]
WatermarkMotion = Literal["fixed", "moving"]
WatermarkPosition = Literal[
    "top_left", "top_center", "top_right", "center_left", "center",
    "center_right", "bottom_left", "bottom_center", "bottom_right",
]


class WatermarkConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")

    enabled: bool = False
    text: str = Field(default="", max_length=120)
    motion: WatermarkMotion = "fixed"
    opacity: float = Field(default=0.35, ge=0, le=1)
    position: WatermarkPosition = "bottom_right"

    @model_validator(mode="after")
    def require_text_when_enabled(self):
        if self.enabled and not self.text.strip():
            raise ValueError("watermark.text is required when watermark is enabled")
        self.text = self.text.strip()
        return self


class SceneDirectionConfig(BaseModel):
    image_motion: ImageMotion
    transition: SceneTransition
    transition_duration: float = Field(ge=0, le=2)
    direction_reason: str = Field(default="", max_length=500)
    subtitle_effect: SubtitleEffect | None = None
    subtitle_keywords: list[str] = Field(default_factory=list, max_length=12)
    subtitle_start_offset: float = Field(default=0, ge=0, le=3600)
    subtitle_end_offset: float = Field(default=0, ge=0, le=3600)
    focus_x: float | None = Field(default=None, ge=0, le=1)
    focus_y: float | None = Field(default=None, ge=0, le=1)
    focus_confidence: float | None = Field(default=None, ge=0, le=1)
    focus_source: str | None = Field(default=None, max_length=100)

    @field_validator("subtitle_keywords")
    @classmethod
    def normalize_keywords(cls, value):
        return normalize_subtitle_keywords(value)


class VideoGenerateRequest(BaseModel):
    """Video generation request"""

    # === Input ===
    text: str = Field(..., description="Source text for video generation")

    # === Processing Mode ===
    mode: Literal["generate", "fixed"] = Field(
        "generate",
        description="Processing mode: 'generate' (AI generates narrations) or 'fixed' (use text as-is)",
    )
    split_mode: Literal["paragraph", "line", "sentence"] = "paragraph"
    custom_script: bool = False

    # === Optional Title ===
    title: Optional[str] = Field(None, description="Video title (auto-generated if not provided)")

    # === Basic Config ===
    n_scenes: Optional[int] = Field(
        None,
        ge=1,
        le=20,
        description="Number of scenes (only used in 'generate' mode, ignored in 'fixed' mode)",
    )
    limit_scenes: bool = Field(
        True,
        description="When true, enforce n_scenes; when false, let planning choose the scene count",
    )
    narrations: Optional[list[str]] = Field(
        None,
        description="Approved pre-generation narration scenes; skips LLM narration planning",
    )
    image_prompts: Optional[list[str]] = Field(
        None,
        description="Approved visual prompts paired with narrations; skips visual planning",
    )

    # === TTS Parameters ===
    voice_id: Optional[str] = Field(
        None,
        description="Edge TTS voice ID; uses the configured default when omitted",
    )
    tts_speed: Optional[float] = Field(None, ge=0.5, le=2.0, description="Speech speed")
    voice_volume: float = Field(
        1.0,
        ge=0.0,
        le=1.5,
        description="Narration volume multiplier (0.0-1.5; 1.0 is the original level)",
    )

    # === LLM Parameters ===
    min_narration_words: int = Field(5, ge=1, le=100, description="Min narration words")
    max_narration_words: int = Field(20, ge=1, le=200, description="Max narration words")
    min_image_prompt_words: int = Field(30, ge=10, le=100, description="Min image prompt words")
    max_image_prompt_words: int = Field(60, ge=10, le=200, description="Max image prompt words")

    # === Media Parameters ===
    # Note: media_width and media_height are auto-determined from template meta tags
    media_workflow: Optional[str] = Field(
        None, description="Custom media workflow (image or video)"
    )

    # === Video Parameters ===
    video_fps: int = Field(30, ge=15, le=60, description="Video FPS")
    production_mode: Optional[
        Literal["direct_video", "hyperframes", "whiteboard_animation"]
    ] = Field(
        None,
        description="Frozen channel production mode",
    )
    render_engine: Literal["native_image_html", "hyperframes", "whiteboard_cv"] = Field(
        "hyperframes",
        description="Frozen renderer selection for this task",
    )
    renderer_version: Literal[
        "native-image-html-v1",
        "native-image-html-v2",
        "0.8.3",
        "0.8.4",
        "whiteboard-cv-v1",
    ] = Field(
        "0.8.4",
        description="Frozen renderer implementation version",
    )
    image_motion: ImageMotion = Field(
        "none",
        description="Native renderer image motion preset",
    )
    transition: SceneTransition = Field(
        "none",
        description="Native renderer scene transition",
    )
    transition_duration: float = Field(
        0.35,
        ge=0.05,
        le=2,
        description="Scene transition duration in seconds",
    )
    subtitle_effect: SubtitleEffect = Field(
        "static",
        description=f"Frozen subtitle animation preset: {', '.join(SUBTITLE_EFFECTS)}",
    )
    hyperframes: Dict[str, Any] = Field(
        default_factory=dict,
        description="Frozen HyperFrames renderer options",
    )
    whiteboard: Dict[str, Any] = Field(
        default_factory=dict,
        description="Frozen standalone whiteboard visual recipe and local renderer options",
    )
    scene_direction: Literal["auto", "fixed"] = Field(
        "auto",
        description="Select scene-level motion and transitions automatically or use fixed defaults",
    )
    motion_pool: list[ImageMotion] = Field(default_factory=list)
    transition_pool: list[SceneTransition] = Field(default_factory=list)
    scene_directions: Optional[list[SceneDirectionConfig]] = None

    # === Frame Template (determines video size) ===
    frame_template: Optional[str] = Field(
        None,
        description="HTML template path with size (e.g., '1080x1920/default.html'). Video size is auto-determined from template.",
    )
    template_sha256: Optional[str] = Field(
        None,
        pattern=r"^[0-9a-f]{64}$",
        description="Frozen SHA-256 fingerprint of the HTML frame template",
    )

    # === Template Custom Parameters ===
    template_params: Optional[Dict[str, Any]] = Field(
        None,
        description="Custom template parameters (e.g., {'accent_color': '#ff0000', 'background': 'url'}). "
        "Available parameters depend on the template. Use GET /api/templates/{template_path}/params to discover them.",
    )

    # === Image Style ===
    prompt_prefix: Optional[str] = Field(None, description="Image style prefix")
    visual_memory: Dict[str, Any] = Field(default_factory=dict)
    visual_memory_prompt: Optional[str] = None
    cover_prompt: Optional[str] = None
    watermark: WatermarkConfig = Field(default_factory=WatermarkConfig)

    # === BGM ===
    bgm_path: Optional[str] = Field(None, description="Background music path")
    bgm_volume: float = Field(0.3, ge=0.0, le=1.0, description="BGM volume (0.0-1.0)")

    @model_validator(mode="after")
    def validate_preplanned_storyboard(self):
        if self.production_mode is None:
            self.production_mode = (
                "hyperframes"
                if self.render_engine == "hyperframes"
                else "whiteboard_animation"
                if self.render_engine == "whiteboard_cv"
                else "direct_video"
                if self.media_workflow == "api/default/video"
                or "video" in str(self.media_workflow or "").rsplit("/", 1)[-1].lower()
                else "hyperframes"
            )
        expected_engine = {
            "direct_video": "native_image_html",
            "hyperframes": "hyperframes",
            "whiteboard_animation": "whiteboard_cv",
        }[self.production_mode]
        if self.render_engine != expected_engine:
            raise ValueError("production_mode and render_engine must describe the same renderer")
        hyperframes_versions = {"0.8.3", "0.8.4"}
        if (
            self.render_engine == "hyperframes"
            and self.renderer_version not in hyperframes_versions
        ):
            raise ValueError("HyperFrames tasks must freeze a supported renderer_version")
        if (
            self.render_engine == "native_image_html"
            and self.renderer_version in hyperframes_versions
        ):
            raise ValueError("Native tasks cannot use the HyperFrames renderer version")
        if self.render_engine == "whiteboard_cv" and self.renderer_version != "whiteboard-cv-v1":
            raise ValueError("Whiteboard tasks must freeze whiteboard-cv-v1")
        if self.render_engine != "whiteboard_cv" and self.renderer_version == "whiteboard-cv-v1":
            raise ValueError("Only whiteboard tasks can use whiteboard-cv-v1")
        if self.render_engine == "hyperframes" and not self.frame_template:
            self.frame_template = "1080x1920/f2_knowledge_card_v1.html"
        elif self.production_mode == "direct_video" and not self.frame_template:
            self.frame_template = "1080x1920/video_default.html"
        if (self.narrations is None) != (self.image_prompts is None):
            raise ValueError("narrations and image_prompts must be supplied together")
        if self.scene_directions is not None and self.narrations is None:
            raise ValueError("scene_directions require a preplanned storyboard")
        if self.narrations is not None:
            if not self.narrations or len(self.narrations) != len(self.image_prompts or []):
                raise ValueError("preplanned storyboard scene counts must match")
            if any(not item.strip() for item in self.narrations):
                raise ValueError("preplanned narrations cannot be empty")
            if self.scene_directions is not None and len(self.scene_directions) != len(
                self.narrations
            ):
                raise ValueError("scene_directions must match the planned storyboard")
        return self

    model_config = ConfigDict(
        json_schema_extra={
            "example": {
                "text": "Atomic Habits teaches us that small changes compound over time to produce remarkable results.",
                "mode": "generate",
                "n_scenes": 5,
                "frame_template": "1080x1920/image_default.html",
                "template_params": {
                    "accent_color": "#3498db",
                    "background": "https://example.com/custom-bg.jpg",
                },
                "title": "The Power of Atomic Habits",
            }
        }
    )


class VideoGenerateResponse(BaseModel):
    """Video generation response (synchronous)"""

    success: bool = True
    message: str = "Success"
    video_url: str = Field(..., description="URL to access generated video")
    duration: float = Field(..., description="Video duration in seconds")
    file_size: int = Field(..., description="File size in bytes")
    render_engine: Optional[str] = Field(None, description="Renderer that produced the final video")
    render_fallback_reason: Optional[str] = Field(
        None,
        description="Why HyperFrames fell back to the native renderer",
    )


class VideoGenerateAsyncResponse(BaseModel):
    """Video generation async response"""

    success: bool = True
    message: str = "Task created successfully"
    task_id: str = Field(..., description="Task ID for tracking progress")
