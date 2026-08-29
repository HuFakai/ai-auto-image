"""Configuration models for the continuous production runner."""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any, Literal

import yaml
from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    field_validator,
)

from pixelle_video.rendering.subtitle_effects import normalize_subtitle_effect
from pixelle_video.rendering_versions import (
    HYPERFRAMES_RENDERER_VERSION,
    NATIVE_RENDERER_VERSION,
    WHITEBOARD_RENDERER_VERSION,
)
from pixelle_video.services.template_packs import TemplatePackRegistry
from pixelle_video.utils.scene_direction import (
    IMAGE_MOTIONS,
    SCENE_TRANSITIONS,
    normalize_motion_pool,
    normalize_transition_pool,
)
from pixelle_video.whiteboard.templates import WhiteboardTemplateRegistry

from .validation import validate_watermark
from .visual_memory import VisualMemory

RENDER_ENGINES = {"native_image_html", "hyperframes", "whiteboard_cv"}
PRODUCTION_MODES = {
    "direct_video",
    "hyperframes",
    "whiteboard_animation",
}


def normalize_video_rendering(value: dict[str, Any]) -> dict[str, Any]:
    """Normalize channel rendering settings while preserving media options."""
    normalized = dict(value)
    try:
        image_generation_concurrency = int(
            normalized.get("image_generation_concurrency") or 4
        )
    except (TypeError, ValueError) as exc:
        raise ValueError("video.image_generation_concurrency must be an integer") from exc
    if not 1 <= image_generation_concurrency <= 32:
        raise ValueError(
            "video.image_generation_concurrency must be between 1 and 32"
        )
    normalized["image_generation_concurrency"] = image_generation_concurrency

    # Keep the channel voice preset and the flattened task parameter in sync.
    # The UI stores the value in ``video.voice_preset`` while the generation
    # pipeline consumes the flattened request, so normalize both forms here.
    raw_voice_preset = normalized.get("voice_preset")
    if raw_voice_preset is None:
        voice_preset: dict[str, Any] = {}
    elif isinstance(raw_voice_preset, dict):
        voice_preset = dict(raw_voice_preset)
    else:
        raise ValueError("video.voice_preset must be an object")
    raw_voice_volume = (
        voice_preset.get("voice_volume")
        if voice_preset.get("voice_volume") is not None
        else normalized.get("voice_volume", 1.0)
    )
    try:
        voice_volume = float(raw_voice_volume)
    except (TypeError, ValueError) as exc:
        raise ValueError("video.voice_volume must be a number") from exc
    if not 0 <= voice_volume <= 1.5:
        raise ValueError("video.voice_volume must be between 0 and 1.5")
    voice_preset["voice_volume"] = voice_volume
    normalized["voice_preset"] = voice_preset
    normalized["voice_volume"] = voice_volume

    workflow = str(normalized.get("media_workflow") or "")
    inferred_mode = (
        "hyperframes"
        if normalized.get("render_engine") == "hyperframes"
        else "whiteboard_animation"
        if normalized.get("render_engine") == "whiteboard_cv"
        else "direct_video"
        if workflow == "api/default/video" or "video" in workflow.rsplit("/", 1)[-1].lower()
        else "hyperframes"
    )
    raw_production_mode = normalized.get("production_mode")
    production_mode = str(raw_production_mode or inferred_mode)
    # Native image + HTML used to be a channel-level production mode. Migrate
    # those saved channel/recipe values to HyperFrames while retaining the
    # native renderer for direct-video overlays and runtime fallback paths.
    if production_mode == "native_image_html":
        production_mode = "hyperframes"
    if production_mode not in PRODUCTION_MODES:
        raise ValueError(
            "video.production_mode must be direct_video, hyperframes, or whiteboard_animation"
        )
    engine = {
        "hyperframes": "hyperframes",
        "whiteboard_animation": "whiteboard_cv",
    }.get(production_mode, "native_image_html")
    requested_engine = normalized.get("render_engine")
    if requested_engine and requested_engine not in RENDER_ENGINES:
        raise ValueError("video.render_engine is unsupported")
    migrating_native_image_mode = (
        requested_engine == "native_image_html"
        and production_mode == "hyperframes"
        and raw_production_mode in {None, "native_image_html"}
        and workflow != "api/default/video"
        and "video" not in workflow.rsplit("/", 1)[-1].lower()
    )
    if requested_engine and requested_engine != engine and not migrating_native_image_mode:
        raise ValueError("video.production_mode conflicts with video.render_engine")
    if production_mode == "direct_video" and workflow == "api/default/image":
        raise ValueError("direct_video production requires the default video model")
    if production_mode != "direct_video" and workflow == "api/default/video":
        raise ValueError(f"{production_mode} production requires an image model")
    if engine not in RENDER_ENGINES:
        raise ValueError("video.render_engine is unsupported")

    native = dict(normalized.get("native") or {})
    image_motion = str(native.get("image_motion") or normalized.get("image_motion") or "none")
    transition = str(native.get("transition") or normalized.get("transition") or "none")
    if image_motion == "slow_pan":
        image_motion = "pan_right"
    if image_motion not in IMAGE_MOTIONS:
        raise ValueError(f"video.native.image_motion must be one of {IMAGE_MOTIONS}")
    if transition not in SCENE_TRANSITIONS:
        raise ValueError(f"video.native.transition must be one of {SCENE_TRANSITIONS}")
    transition_duration = float(
        native.get("transition_duration")
        if native.get("transition_duration") is not None
        else normalized.get("transition_duration", 0.35)
    )
    if not 0.05 <= transition_duration <= 2:
        raise ValueError("video.native.transition_duration must be between 0.05 and 2")
    native.update(
        image_motion=image_motion,
        transition=transition,
        transition_duration=transition_duration,
        scene_direction=str(native.get("scene_direction") or "auto"),
        motion_pool=normalize_motion_pool(native.get("motion_pool")),
        transition_pool=normalize_transition_pool(native.get("transition_pool")),
    )
    if native["scene_direction"] not in {"auto", "fixed"}:
        raise ValueError("video.native.scene_direction must be auto or fixed")

    subtitle_effect = normalize_subtitle_effect(normalized.get("subtitle_effect"))
    limit_scenes = normalized.get("limit_scenes", True)
    if not isinstance(limit_scenes, bool):
        raise ValueError("video.limit_scenes must be boolean")
    normalized["limit_scenes"] = limit_scenes
    if normalized["limit_scenes"]:
        normalized.setdefault("n_scenes", 5)
    normalized["watermark"] = validate_watermark(normalized.get("watermark"))

    hyperframes = dict(normalized.get("hyperframes") or {})
    hyperframes["template_id"] = str(hyperframes.get("template_id") or "knowledge-card").strip()
    try:
        hyperframes["template_version"] = int(hyperframes.get("template_version") or 1)
    except (TypeError, ValueError) as exc:
        raise ValueError("video.hyperframes.template_version must be an integer") from exc
    variables = hyperframes.get("variables") or {}
    if not isinstance(variables, dict):
        raise ValueError("video.hyperframes.variables must be an object")
    template_pack = TemplatePackRegistry().load(
        hyperframes["template_id"],
        hyperframes["template_version"],
    )
    legacy_template_params = normalized.get("template_params") or {}
    if not isinstance(legacy_template_params, dict):
        legacy_template_params = {}
    inherited_variables = {
        key: value
        for key, value in legacy_template_params.items()
        if key in template_pack.variables
    }
    hyperframes["variables"] = template_pack.resolve_variables(
        {**inherited_variables, **variables}
    )
    hyperframes.setdefault("quality", "standard")
    hyperframes.setdefault("strictness", "strict")
    hyperframes.setdefault("use_gpu", True)
    hyperframes.setdefault("fallback_to_native", True)
    whiteboard = WhiteboardTemplateRegistry().resolve(normalized.get("whiteboard"))
    if engine == "whiteboard_cv":
        normalized["frame_template"] = None
    elif engine == "hyperframes":
        # HyperFrames template packs own their backing HTML.  Old channel-level
        # image templates are migrated here instead of leaking into new tasks.
        normalized["frame_template"] = template_pack.native_template
        normalized["template_params"] = dict(hyperframes["variables"])
    elif not normalized.get("frame_template"):
        normalized["frame_template"] = "1080x1920/video_default.html"

    normalized.update(
        production_mode=production_mode,
        render_engine=engine,
        renderer_version=(
            HYPERFRAMES_RENDERER_VERSION
            if engine == "hyperframes"
            else WHITEBOARD_RENDERER_VERSION
            if engine == "whiteboard_cv"
            else NATIVE_RENDERER_VERSION
        ),
        native=native,
        hyperframes=hyperframes,
        whiteboard=whiteboard,
        subtitle_effect=subtitle_effect,
    )
    return normalized


class TopicConfig(BaseModel):
    """How a channel chooses its next production topic."""

    model_config = ConfigDict(extra="forbid")

    strategy: Literal["seed", "llm"] = "seed"
    seeds: list[str] = Field(default_factory=list)
    prompt: str = ""
    history_window: int = Field(default=50, ge=0, le=1000)
    fallback_to_seeds: bool = True

    @field_validator("seeds")
    @classmethod
    def clean_seeds(cls, values: list[str]) -> list[str]:
        return [value.strip() for value in values if value and value.strip()]


class InventoryConfig(BaseModel):
    """Production watermarks and retry policy for one channel."""

    model_config = ConfigDict(extra="forbid")

    ready_target: int = Field(default=3, ge=0, le=10000)
    daily_target: int = Field(default=1, ge=0, le=10000)
    max_in_flight: int = Field(default=1, ge=1, le=1000)
    refill_batch: int = Field(default=1, ge=1, le=1000)
    max_task_retries: int = Field(default=2, ge=0, le=20)
    circuit_breaker_failures: int = Field(default=3, ge=1, le=100)
    failure_cooldown_seconds: int = Field(default=1800, ge=1, le=604800)


class PlanningConfig(BaseModel):
    """Storyboard planning and content-gate policy for a channel."""

    model_config = ConfigDict(extra="forbid")

    enabled: bool = False
    approval: Literal["auto", "manual"] = "auto"
    content_policy: Literal["general", "science", "psychology"] = "general"
    llm_review: bool = True


class QualityConfig(BaseModel):
    """Automatic repair policy after the technical quality gate."""

    model_config = ConfigDict(extra="forbid")

    auto_repair: bool = False


class NotificationConfig(BaseModel):
    """Optional generic webhook delivery for durable production events."""

    model_config = ConfigDict(extra="forbid")

    enabled: bool = False
    webhook_url: str = ""
    events: list[Literal["job_ready", "job_failed", "channel_circuit_open", "runner_error"]] = (
        Field(
            default_factory=lambda: [
                "job_ready",
                "job_failed",
                "channel_circuit_open",
                "runner_error",
            ]
        )
    )
    timeout_seconds: float = Field(default=10, ge=1, le=60)

    @field_validator("webhook_url")
    @classmethod
    def validate_webhook_url(cls, value: str) -> str:
        cleaned = value.strip()
        if cleaned and not cleaned.startswith(("https://", "http://")):
            raise ValueError("notifications.webhook_url must be HTTP(S)")
        return cleaned


class OperationsConfig(BaseModel):
    """Local readiness and backup policy."""

    model_config = ConfigDict(extra="forbid")

    backups_dir: str = "data/backups"
    minimum_free_gb: float = Field(default=5, ge=0.1, le=10000)
    backup_warning_hours: int = Field(default=26, ge=1, le=8760)


class ChannelConfig(BaseModel):
    """One independently replenished short-video channel."""

    model_config = ConfigDict(extra="forbid")

    id: str = Field(pattern=r"^[a-z0-9][a-z0-9_-]{1,63}$")
    name: str
    enabled: bool = True
    # Added with defaults so existing YAML recipes remain valid and retain their
    # original fixed scene-count behavior.
    config_source: Literal["manual", "api", "copy", "ai"] = "manual"
    generation_reason: str = Field(default="", max_length=2000)
    topic: TopicConfig
    inventory: InventoryConfig = Field(default_factory=InventoryConfig)
    planning: PlanningConfig = Field(default_factory=PlanningConfig)
    quality: QualityConfig = Field(default_factory=QualityConfig)
    visual_memory: VisualMemory = Field(default_factory=VisualMemory)
    # Read-and-discard compatibility for old YAML; standalone presets are retired.
    brand_kit_version_id: str | None = Field(default=None, exclude=True)
    recipe_version_id: str | None = Field(default=None, exclude=True)
    video: dict[str, Any]

    @field_validator("video")
    @classmethod
    def validate_video(cls, value: dict[str, Any]) -> dict[str, Any]:
        if not value.get("media_workflow"):
            raise ValueError("video.media_workflow is required")
        normalized = normalize_video_rendering(value)
        if normalized["render_engine"] != "whiteboard_cv" and not normalized.get(
            "frame_template"
        ):
            raise ValueError("video.frame_template is required")
        return normalized


class RunnerConfig(BaseModel):
    """Process-level settings for the durable runner."""

    model_config = ConfigDict(extra="forbid")

    api_base_url: str = "http://127.0.0.1:18123"
    database_path: str = "data/production.db"
    channels_dir: str = "production/channels"
    poll_interval_seconds: float = Field(default=30, ge=1, le=3600)
    lease_seconds: int = Field(default=120, ge=10, le=86400)
    request_timeout_seconds: float = Field(default=30, ge=1, le=600)
    timezone: str = "Asia/Shanghai"
    notifications: NotificationConfig = Field(default_factory=NotificationConfig)
    operations: OperationsConfig = Field(default_factory=OperationsConfig)
    channels: list[ChannelConfig] = Field(default_factory=list)


def load_runner_config(path: str | Path) -> RunnerConfig:
    """Load runner settings and all channel YAML files deterministically."""
    config_path = Path(path).expanduser().resolve()
    raw = yaml.safe_load(config_path.read_text(encoding="utf-8")) or {}
    environment_overrides = {
        "api_base_url": os.getenv("PIXELLE_PRODUCTION_API_BASE_URL"),
        "database_path": os.getenv("PIXELLE_PRODUCTION_DATABASE_PATH"),
        "channels_dir": os.getenv("PIXELLE_PRODUCTION_CHANNELS_DIR"),
    }
    raw.update({key: value for key, value in environment_overrides.items() if value})
    config = RunnerConfig.model_validate(raw)
    project_root = config_path.parent.parent

    database_path = Path(config.database_path).expanduser()
    if not database_path.is_absolute():
        database_path = (project_root / database_path).resolve()
    config.database_path = str(database_path)

    channels_dir = Path(config.channels_dir).expanduser()
    if not channels_dir.is_absolute():
        channels_dir = (project_root / channels_dir).resolve()
    if not channels_dir.exists():
        raise FileNotFoundError(f"Channels directory not found: {channels_dir}")

    channels = load_channel_configs(channels_dir)
    config.channels_dir = str(channels_dir)
    backups_dir = Path(config.operations.backups_dir).expanduser()
    if not backups_dir.is_absolute():
        backups_dir = (project_root / backups_dir).resolve()
    config.operations.backups_dir = str(backups_dir)
    config.channels = channels
    return config


def load_channel_configs(channels_dir: str | Path) -> list[ChannelConfig]:
    """Load validated channel files for API editing and runner hot reload."""
    directory = Path(channels_dir).expanduser().resolve()
    channels: list[ChannelConfig] = []
    seen: set[str] = set()
    for channel_path in sorted(directory.glob("*.y*ml")):
        channel_raw = yaml.safe_load(channel_path.read_text(encoding="utf-8")) or {}
        channel = ChannelConfig.model_validate(channel_raw)
        if channel.id in seen:
            raise ValueError(f"Duplicate channel id: {channel.id}")
        seen.add(channel.id)
        channels.append(channel)

    if not channels:
        raise ValueError(f"No channel YAML files found in {directory}")
    return channels
