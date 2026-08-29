"""Safe model-channel and runtime settings endpoints."""

from __future__ import annotations

from threading import RLock

from fastapi import APIRouter, HTTPException
from pydantic import ValidationError

from api.schemas.settings import ModelChannelTestRequest, SettingsWriteRequest
from pixelle_video.config import config_manager
from pixelle_video.config.schema import ModelSettingsConfig, PixelleVideoConfig
from pixelle_video.utils.llm_util import fetch_available_models

router = APIRouter(prefix="/settings", tags=["Settings"])
_settings_lock = RLock()


@router.get("")
def get_settings():
    """Return editable settings with every credential masked."""
    return _public_settings()


@router.put("")
def save_settings(body: SettingsWriteRequest):
    """Atomically validate and persist the complete settings document."""
    with _settings_lock:
        current = config_manager.config.model_dump()
        existing = config_manager.config.model_settings.channels
        channels = {}
        for channel_id, incoming in body.channels.items():
            value = incoming.model_dump()
            value.pop("clear_api_key", None)
            if incoming.clear_api_key:
                value["api_key"] = ""
            elif incoming.api_key is None:
                value["api_key"] = (
                    existing.get(channel_id).api_key if channel_id in existing else ""
                )
            channels[channel_id] = value
        try:
            model_settings = ModelSettingsConfig.model_validate(
                {"channels": channels, "routing": body.routing.model_dump()}
            )
            current["model_settings"] = model_settings.model_dump()
            current["tts"] = {
                "provider": "edge",
                "voice": body.runtime.tts_voice,
                "speed": body.runtime.tts_speed,
            }
            current["template"]["default_template"] = body.runtime.default_template
            current["media"]["image"]["prompt_prefix"] = body.runtime.image_prompt_prefix
            current["media"]["video"]["prompt_prefix"] = body.runtime.video_prompt_prefix
            current["runtime"].update(
                local_proxy=body.runtime.local_proxy,
                print_model_input=body.runtime.print_model_input,
            )
            validated = PixelleVideoConfig.model_validate(current)
        except (ValidationError, ValueError) as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        previous = config_manager.config
        config_manager.config = validated
        try:
            config_manager.save()
        except Exception:
            config_manager.config = previous
            raise
        return _public_settings(message="设置已保存并热加载，新任务立即使用新的模型路由")


@router.post("/models/test")
def test_model_channel(body: ModelChannelTestRequest):
    """Verify credentials through the non-generating OpenAI-compatible models endpoint."""
    api_key = body.api_key
    if body.clear_api_key:
        api_key = ""
    elif api_key is None and body.channel_id:
        existing = config_manager.config.model_settings.channels.get(body.channel_id)
        api_key = existing.api_key if existing else ""
    try:
        models = fetch_available_models(
            api_key or "local-channel",
            body.base_url,
            timeout=min(body.request_timeout, 30),
            proxy=(
                config_manager.config.runtime.local_proxy if body.use_proxy else None
            ),
            user_agent=body.user_agent or None,
        )
    except Exception as exc:
        raise HTTPException(status_code=502, detail=_connection_error(exc)) from exc
    return {
        "ok": True,
        "message": f"连接成功，发现 {len(models)} 个模型",
        "models": models,
    }


def _public_settings(message: str | None = None) -> dict:
    config = config_manager.config
    channels = {}
    for channel_id, channel in config.model_settings.channels.items():
        value = channel.model_dump(exclude={"api_key"})
        value["api_key_configured"] = bool(channel.api_key)
        value["api_key_hint"] = _secret_hint(channel.api_key)
        channels[channel_id] = value
    result = {
        "channels": channels,
        "routing": config.model_settings.routing.model_dump(),
        "runtime": {
            "local_proxy": config.runtime.local_proxy,
            "print_model_input": config.runtime.print_model_input,
            "tts_voice": config.tts.voice,
            "tts_speed": config.tts.speed,
            "default_template": config.template.default_template,
            "image_prompt_prefix": config.media.image.prompt_prefix,
            "video_prompt_prefix": config.media.video.prompt_prefix,
        },
        "config_file": str(config_manager.config_path),
    }
    if message:
        result["message"] = message
    return result


def _secret_hint(secret: str) -> str:
    return "••••••••" if secret else ""


def _connection_error(exc: Exception) -> str:
    text = str(exc)
    if "401" in text:
        return "鉴权失败，请检查 API Key"
    if "403" in text:
        return "当前 API Key 没有读取模型列表的权限"
    if "404" in text:
        return "没有找到 /models 接口，请检查 Base URL 是否指向 API 根路径"
    return f"连接失败：{text[:400]}"
