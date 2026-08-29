"""Schemas for continuous production control endpoints."""

from typing import Any, Literal

from pydantic import AnyHttpUrl, BaseModel, ConfigDict, Field, field_validator, model_validator

from api.schemas.video import ImageMotion, SceneTransition, SubtitleEffect, VideoGenerateRequest
from pixelle_video.rendering.subtitle_effects import normalize_subtitle_keywords


class PublishRequest(BaseModel):
    count: int = Field(default=1, ge=1, le=1000)


class ReviewRequest(BaseModel):
    note: str | None = Field(default=None, max_length=2000)


class BatchReviewRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    job_ids: list[str] = Field(min_length=1, max_length=100)
    decision: Literal["approved", "rejected"]
    note: str | None = Field(default=None, max_length=2000)

    @model_validator(mode="after")
    def validate_batch(self):
        if len(set(self.job_ids)) != len(self.job_ids):
            raise ValueError("job_ids must be unique")
        if self.decision == "rejected" and not (self.note or "").strip():
            raise ValueError("A rejection note is required")
        return self


class BatchJobRequest(BaseModel):
    """A bounded, duplicate-free production queue selection."""

    model_config = ConfigDict(extra="forbid")

    job_ids: list[str] = Field(min_length=1, max_length=100)

    @model_validator(mode="after")
    def validate_job_ids(self):
        if len(set(self.job_ids)) != len(self.job_ids):
            raise ValueError("job_ids must be unique")
        return self


class BatchJobDeleteRequest(BatchJobRequest):
    """Explicit confirmation for destructive queue operations."""

    confirmation: Literal["DELETE"]
    delete_files: Literal[True] = True


class BatchParameterRequest(BatchJobRequest):
    """Preview or apply safe request-level production parameter changes."""

    updates: dict[str, Any] = Field(min_length=1, max_length=12)

    @field_validator("updates")
    @classmethod
    def validate_updates(cls, value: dict[str, Any]) -> dict[str, Any]:
        allowed = {
            "production_mode",
            "frame_template",
            "voice_id",
            "tts_speed",
            "voice_volume",
            "bgm_path",
            "bgm_volume",
            "subtitle_effect",
            "media_workflow",
        }
        unknown = sorted(set(value) - allowed)
        if unknown:
            raise ValueError(f"unsupported batch parameter fields: {', '.join(unknown)}")
        return value


class RestoreRehearsalRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    backup_path: str = Field(min_length=1, max_length=4000)


class CopyChannelRequest(BaseModel):
    id: str = Field(pattern=r"^[a-z0-9][a-z0-9_-]{1,63}$")
    name: str = Field(min_length=1, max_length=120)


class ChannelTestRequest(BaseModel):
    topic: str | None = Field(default=None, max_length=1000)


class TopicCandidateGenerateRequest(BaseModel):
    channel_id: str = Field(pattern=r"^[a-z0-9][a-z0-9_-]{1,63}$")
    count: int = Field(default=6, ge=1, le=20)
    source_type: Literal["prompt", "markdown", "theme_pool"] = "prompt"
    source_label: str | None = Field(default=None, max_length=200)
    source_text: str = Field(default="", max_length=50000)


class TopicCandidateCreateRequest(BaseModel):
    channel_id: str = Field(pattern=r"^[a-z0-9][a-z0-9_-]{1,63}$")
    title: str = Field(min_length=1, max_length=200)
    topic: str = Field(min_length=1, max_length=2000)
    cover_copy: str = Field(default="", max_length=120)
    platform_description: str = Field(default="", max_length=1000)
    tags: list[str] = Field(default_factory=list, max_length=12)


class TopicCandidateDecisionRequest(BaseModel):
    status: Literal["new", "pinned", "approved", "deferred", "discarded"]
    note: str | None = Field(default=None, max_length=1000)
    deferred_until: str | None = Field(default=None, max_length=64)


class TopicTitleSelectionRequest(BaseModel):
    variant_id: str = Field(min_length=1, max_length=80)


class ContentSourceCreateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    channel_id: str = Field(pattern=r"^[a-z0-9][a-z0-9_-]{1,63}$")
    name: str = Field(min_length=1, max_length=160)
    kind: Literal["url", "rss"]
    url: AnyHttpUrl
    enabled: bool = True
    poll_interval_minutes: int = Field(default=360, ge=5, le=43_200)
    items_per_poll: int = Field(default=5, ge=1, le=30)
    candidates_per_item: int = Field(default=2, ge=1, le=10)


class ContentSourceUpdateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    channel_id: str | None = Field(default=None, pattern=r"^[a-z0-9][a-z0-9_-]{1,63}$")
    name: str | None = Field(default=None, min_length=1, max_length=160)
    kind: Literal["url", "rss"] | None = None
    url: AnyHttpUrl | None = None
    enabled: bool | None = None
    poll_interval_minutes: int | None = Field(default=None, ge=5, le=43_200)
    items_per_poll: int | None = Field(default=None, ge=1, le=30)
    candidates_per_item: int | None = Field(default=None, ge=1, le=10)


class ProducerMessageRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    thread_id: str | None = Field(default=None, max_length=100)
    message: str = Field(min_length=1, max_length=8000)


class ProducerPlanDecisionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    approved: bool
    note: str | None = Field(default=None, max_length=1000)


class DeleteResourceRequest(BaseModel):
    """Explicit confirmation required by every destructive production action."""

    model_config = ConfigDict(extra="forbid")

    confirm_id: str = Field(min_length=1, max_length=300)
    delete_files: Literal[True] = True


class StoryboardPlanningRequest(VideoGenerateRequest):
    content_policy: Literal["general", "science", "psychology"] = "general"
    llm_review: bool = True


class CustomScriptRecommendationRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    channel_id: str = Field(pattern=r"^[a-z0-9][a-z0-9_-]{1,63}$")
    script: str = Field(min_length=20, max_length=50_000)
    title: str | None = Field(default=None, max_length=200)
    rewrite_enabled: bool = False
    review_mode: Literal["manual", "ai_auto"] = "manual"


class CustomScriptRecommendation(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: str = Field(min_length=1, max_length=200)
    script: str = Field(min_length=20, max_length=50_000)
    original_script: str | None = Field(default=None, max_length=50_000)
    production_mode: Literal[
        "direct_video", "hyperframes", "whiteboard_animation"
    ] = "hyperframes"
    subtitle_effect: SubtitleEffect = "fade_up"
    n_scenes: int = Field(default=6, ge=1)
    scene_count_basis: str = Field(default="", max_length=500)
    scene_strategy: Literal["content_auto"] = "content_auto"
    content_policy: Literal["general", "science", "psychology"] = "general"
    image_motion: ImageMotion = "ken_burns"
    transition: SceneTransition = "crossfade"
    rationale: str = Field(default="", max_length=1000)
    review_status: Literal["manual_pending", "pass", "warn"] = "manual_pending"
    review_summary: str = Field(default="", max_length=1000)


class CustomScriptJobRequest(CustomScriptRecommendationRequest):
    model_config = ConfigDict(extra="forbid")

    title: str = Field(min_length=1, max_length=200)
    original_script: str | None = Field(default=None, max_length=50_000)
    production_mode: Literal[
        "direct_video", "hyperframes", "whiteboard_animation"
    ]
    subtitle_effect: SubtitleEffect
    n_scenes: int = Field(ge=1)
    scene_strategy: Literal["content_auto"] = "content_auto"
    content_policy: Literal["general", "science", "psychology"]
    image_motion: ImageMotion
    transition: SceneTransition
    voice_id: str = Field(min_length=1, max_length=200)
    tts_speed: float = Field(default=1.0, ge=0.5, le=2)
    bgm_volume: float = Field(default=0.18, ge=0, le=1)
    image_generation_concurrency: int = Field(default=4, ge=1, le=32)
    whiteboard_template_id: str | None = Field(default=None, max_length=120)


class StoryboardSceneUpdate(BaseModel):
    narration: str = Field(min_length=1, max_length=4000)
    visual_prompt: str = Field(min_length=1, max_length=8000)
    image_motion: ImageMotion = "ken_burns"
    transition: SceneTransition = "crossfade"
    transition_duration: float = Field(default=0.35, ge=0, le=2)
    direction_reason: str = Field(default="人工调整", max_length=500)
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


class StoryboardUpdateRequest(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    scenes: list[StoryboardSceneUpdate] = Field(min_length=1)
    auto_direct: bool = False
    director_note: str | None = Field(default=None, max_length=4000)


class IntelligentStoryboardDirection(BaseModel):
    """LLM response contract for review-aware storyboard redirection."""

    model_config = ConfigDict(extra="forbid")

    title: str = Field(min_length=1, max_length=200)
    scenes: list[StoryboardSceneUpdate] = Field(min_length=1)
    # The model may still return a complete draft for providers that only
    # support fixed structured-output arrays, but the API persists edits only
    # for these explicitly selected zero-based positions.
    changed_scene_positions: list[int] = Field(default_factory=list, max_length=100)
    rationale: str = Field(default="", max_length=2000)


class ReviewStoryboardScenePatch(BaseModel):
    """Compact per-scene response used by the review redirection batches."""

    model_config = ConfigDict(extra="ignore")

    position: int = Field(ge=0)
    narration: str = Field(min_length=1, max_length=4000)
    visual_prompt: str = Field(min_length=1, max_length=8000)
    image_motion: ImageMotion | None = None
    transition: SceneTransition | None = None
    transition_duration: float | None = Field(default=None, ge=0, le=2)
    direction_reason: str | None = Field(default=None, max_length=500)


class ReviewStoryboardDirection(BaseModel):
    """Small structured contract that avoids repeating the full scene schema."""

    model_config = ConfigDict(extra="ignore")

    scenes: list[ReviewStoryboardScenePatch] = Field(min_length=1, max_length=20)
    rationale: str = Field(default="", max_length=600)


class StoryboardApprovalRequest(BaseModel):
    override_content_gate: bool = False
