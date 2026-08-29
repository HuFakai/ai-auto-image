"""Schemas for editable video projects, revisions, and scenes."""

from typing import Literal

from pydantic import BaseModel, Field, field_validator, model_validator

from api.schemas.video import ImageMotion, SceneTransition
from pixelle_video.rendering.subtitle_effects import SUBTITLE_EFFECTS, normalize_subtitle_keywords

SubtitleEffect = Literal["static", "fade_up", "typewriter", "word_pop"]


class RevisionCreateRequest(BaseModel):
    note: str | None = Field(default=None, max_length=2000)


class RevisionVariantRequest(BaseModel):
    engine: Literal["hyperframes", "whiteboard_cv"]


class SceneUpdateRequest(BaseModel):
    narration: str | None = Field(default=None, min_length=1, max_length=10000)
    visual_prompt: str | None = Field(default=None, min_length=1, max_length=30000)
    locked: bool | None = None
    duration: float | None = Field(default=None, ge=0, le=3600)
    focus_x: float | None = Field(default=None, ge=0, le=1)
    focus_y: float | None = Field(default=None, ge=0, le=1)
    focus_confidence: float | None = Field(default=None, ge=0, le=1)
    focus_source: str | None = Field(default=None, max_length=100)
    image_motion: ImageMotion | None = None
    transition: SceneTransition | None = None
    transition_duration: float | None = Field(default=None, ge=0, le=2)
    direction_reason: str | None = Field(default=None, max_length=500)
    subtitle_effect: SubtitleEffect | None = None
    subtitle_keywords: list[str] | None = Field(default=None, max_length=12)
    subtitle_start_offset: float | None = Field(default=None, ge=0, le=3600)
    subtitle_end_offset: float | None = Field(default=None, ge=0, le=3600)

    @field_validator("subtitle_keywords")
    @classmethod
    def normalize_keywords(cls, value):
        if value is None:
            return value
        return normalize_subtitle_keywords(value)

    @model_validator(mode="after")
    def require_update(self):
        if not self.model_fields_set:
            raise ValueError("At least one scene field is required")
        if (
            self.transition_duration is not None
            and self.transition_duration < 0.05
            and self.transition != "none"
        ):
            raise ValueError(
                "transition_duration must be at least 0.05 unless transition is none"
            )
        if self.subtitle_effect is not None and self.subtitle_effect not in SUBTITLE_EFFECTS:
            raise ValueError(f"subtitle_effect must be one of {SUBTITLE_EFFECTS}")
        return self


class SceneOrderRequest(BaseModel):
    scene_ids: list[str] = Field(min_length=1, max_length=1000)


class SceneSplitRequest(BaseModel):
    narration: str = Field(min_length=1, max_length=10000)
    visual_prompt: str = Field(min_length=1, max_length=30000)


class SceneMergeRequest(BaseModel):
    next_scene_id: str


class SceneRegenerateRequest(BaseModel):
    scope: Literal["full", "visual", "voice", "composition"] = "full"
    preserve_style: bool = True
