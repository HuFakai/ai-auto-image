"""Settings API schemas."""

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from pixelle_video.config.schema import ModelCatalogConfig, ModelRoutingConfig


class ModelChannelWrite(BaseModel):
    """Editable model channel; omitted keys preserve the stored secret."""

    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1, max_length=80)
    api_format: Literal["openai", "grok2api"] = "openai"
    base_url: str = Field(min_length=1, max_length=500)
    api_key: str | None = Field(default=None, max_length=2000)
    clear_api_key: bool = False
    enabled: bool = True
    use_proxy: bool = False
    user_agent: str = Field(default="", max_length=300)
    models: ModelCatalogConfig = Field(default_factory=ModelCatalogConfig)
    request_timeout: float = Field(default=300, ge=1, le=3600)
    poll_interval: float = Field(default=5, ge=0, le=300)
    poll_timeout: float = Field(default=1800, ge=1, le=86400)
    retry_count: int = Field(default=3, ge=1, le=10)
    job_store_dir: str = Field(default="data/model_jobs", min_length=1, max_length=500)


class RuntimeSettingsWrite(BaseModel):
    model_config = ConfigDict(extra="forbid")

    local_proxy: str = Field(default="", max_length=500)
    print_model_input: bool = False
    tts_voice: str = Field(default="zh-CN-YunjianNeural", min_length=1, max_length=100)
    tts_speed: float = Field(default=1.2, ge=0.5, le=2)
    default_template: str = Field(min_length=1, max_length=500)
    image_prompt_prefix: str = Field(default="", max_length=5000)
    video_prompt_prefix: str = Field(default="", max_length=5000)


class SettingsWriteRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    channels: dict[str, ModelChannelWrite]
    routing: ModelRoutingConfig
    runtime: RuntimeSettingsWrite


class ModelChannelTestRequest(ModelChannelWrite):
    channel_id: str | None = Field(default=None, max_length=64)
