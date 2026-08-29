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
Configuration schema with Pydantic models

Single source of truth for all configuration defaults and validation.
"""

import re
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


class ModelCatalogConfig(BaseModel):
    """Models exposed by one OpenAI-compatible channel, grouped by capability."""

    model_config = ConfigDict(extra="forbid")

    text: list[str] = Field(default_factory=list)
    image: list[str] = Field(default_factory=list)
    video: list[str] = Field(default_factory=list)

    @field_validator("text", "image", "video")
    @classmethod
    def clean_models(cls, values: list[str]) -> list[str]:
        return list(dict.fromkeys(value.strip() for value in values if value.strip()))


class ModelChannelConfig(BaseModel):
    """One credential boundary that can serve text, image, or video models."""

    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1, max_length=80)
    api_format: Literal["openai", "grok2api"] = "openai"
    base_url: str = Field(min_length=1, max_length=500)
    api_key: str = Field(default="", max_length=2000)
    enabled: bool = True
    use_proxy: bool = False
    user_agent: str = Field(default="", max_length=300)
    models: ModelCatalogConfig = Field(default_factory=ModelCatalogConfig)
    request_timeout: float = Field(default=300.0, ge=1, le=3600)
    poll_interval: float = Field(default=5.0, ge=0, le=300)
    poll_timeout: float = Field(default=1800.0, ge=1, le=86400)
    retry_count: int = Field(default=3, ge=1, le=10)
    job_store_dir: str = Field(default="data/model_jobs", min_length=1, max_length=500)

    @field_validator("base_url")
    @classmethod
    def normalize_base_url(cls, value: str) -> str:
        from pixelle_video.utils.llm_util import normalize_openai_base_url

        normalized = normalize_openai_base_url(value)
        if not normalized.startswith(("http://", "https://")):
            raise ValueError("base_url must start with http:// or https://")
        return normalized


class ModelSelectionConfig(BaseModel):
    """The independently selected channel and model for one capability."""

    model_config = ConfigDict(extra="forbid")

    channel_id: str = ""
    model: str = ""
    reasoning_effort: Literal["none", "low", "medium", "high"] = "none"
    fallbacks: list["ModelSelectionConfig"] = Field(default_factory=list)

    @field_validator("fallbacks")
    @classmethod
    def validate_fallbacks(
        cls,
        values: list["ModelSelectionConfig"],
    ) -> list["ModelSelectionConfig"]:
        return [value.model_copy(deep=True) for value in values]


class ModelRoutingConfig(BaseModel):
    """Active text, image, and video model routes."""

    model_config = ConfigDict(extra="forbid")

    text: ModelSelectionConfig = Field(default_factory=ModelSelectionConfig)
    image: ModelSelectionConfig = Field(default_factory=ModelSelectionConfig)
    video: ModelSelectionConfig = Field(default_factory=ModelSelectionConfig)

    @model_validator(mode="after")
    def clean_fallback_duplicates(self):
        """Keep route order stable while removing exact duplicates."""
        primary_key = (self.text.channel_id, self.text.model)
        text_routes: list[ModelSelectionConfig] = []
        seen = {primary_key} if primary_key != ("", "") else set()
        for route in self.text.fallbacks:
            key = (route.channel_id, route.model)
            if key in seen or key == ("", ""):
                continue
            seen.add(key)
            route.fallbacks = []
            text_routes.append(route)
        self.text.fallbacks = text_routes

        for capability in ("image", "video"):
            selection = getattr(self, capability)
            primary_key = (selection.channel_id, selection.model)
            routes: list[ModelSelectionConfig] = []
            seen = {primary_key} if primary_key != ("", "") else set()
            for route in selection.fallbacks:
                key = (route.channel_id, route.model)
                if key in seen or key == ("", ""):
                    continue
                seen.add(key)
                route.fallbacks = []
                routes.append(route)
            selection.fallbacks = routes
        return self


class ModelSettingsConfig(BaseModel):
    """Unified multi-channel model registry."""

    model_config = ConfigDict(extra="forbid")

    channels: dict[str, ModelChannelConfig] = Field(default_factory=dict)
    routing: ModelRoutingConfig = Field(default_factory=ModelRoutingConfig)

    @field_validator("channels")
    @classmethod
    def validate_channel_ids(
        cls, value: dict[str, ModelChannelConfig]
    ) -> dict[str, ModelChannelConfig]:
        invalid = [key for key in value if not re.fullmatch(r"[a-z0-9][a-z0-9_-]{1,63}", key)]
        if invalid:
            raise ValueError(f"Invalid model channel ids: {invalid}")
        return value

    @model_validator(mode="after")
    def validate_routing(self):
        for capability in ("text", "image", "video"):
            selection = getattr(self.routing, capability)
            self._validate_selection(capability, selection)
        return self

    def _validate_selection(
        self,
        capability: str,
        selection: ModelSelectionConfig,
    ) -> None:
        if not selection.channel_id and not selection.model:
            for fallback in selection.fallbacks:
                self._validate_selection(capability, fallback)
            return
        channel = self.channels.get(selection.channel_id)
        if channel is None:
            raise ValueError(f"Unknown {capability} model channel: {selection.channel_id}")
        if not channel.enabled:
            raise ValueError(
                f"The selected {capability} model channel is disabled: {selection.channel_id}"
            )
        if selection.model not in getattr(channel.models, capability):
            raise ValueError(
                f"Model {selection.model!r} is not registered for {capability} "
                f"on channel {selection.channel_id!r}"
            )
        for fallback in selection.fallbacks:
            self._validate_selection(capability, fallback)


class RuntimeConfig(BaseModel):
    """Shared non-secret runtime behavior."""

    model_config = ConfigDict(extra="forbid")

    print_model_input: bool = False
    local_proxy: str = ""


class TTSConfig(BaseModel):
    """Edge TTS configuration."""

    provider: Literal["edge"] = Field(default="edge", description="TTS provider")
    voice: str = Field(default="zh-CN-YunjianNeural", description="Edge TTS voice ID")
    speed: float = Field(
        default=1.2, ge=0.5, le=2.0, description="Speech speed multiplier (0.5-2.0)"
    )


class MediaTypeConfig(BaseModel):
    """Prompt defaults for one media type; model selection lives in routing."""

    model_config = ConfigDict(extra="ignore")

    prompt_prefix: str = Field(
        default="Minimalist black-and-white matchstick figure style illustration, clean lines, simple sketch style",
        description="Prompt prefix for media generation",
    )


class MediaConfig(BaseModel):
    """Media prompt defaults."""

    image: MediaTypeConfig = Field(default_factory=MediaTypeConfig)
    video: MediaTypeConfig = Field(default_factory=MediaTypeConfig)


class TemplateConfig(BaseModel):
    """Template configuration"""

    default_template: str = Field(
        default="1080x1920/default.html", description="Default frame template path"
    )


class PixelleVideoConfig(BaseModel):
    """Pixelle-Video main configuration"""

    project_name: str = Field(default="Pixelle-Video", description="Project name")
    model_settings: ModelSettingsConfig = Field(default_factory=ModelSettingsConfig)
    runtime: RuntimeConfig = Field(default_factory=RuntimeConfig)
    tts: TTSConfig = Field(default_factory=TTSConfig)
    media: MediaConfig = Field(default_factory=MediaConfig)
    template: TemplateConfig = Field(default_factory=TemplateConfig)

    def is_llm_configured(self) -> bool:
        """Check whether the unified text route resolves to an enabled channel."""
        selection = self.model_settings.routing.text
        channel = self.model_settings.channels.get(selection.channel_id)
        return bool(channel and channel.enabled and selection.model and channel.api_key)

    def validate_required(self) -> bool:
        """Validate required configuration"""
        return self.is_llm_configured()

    def to_dict(self) -> dict:
        """Convert to a plain serializable dictionary."""
        return self.model_dump()
