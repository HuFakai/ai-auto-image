from unittest.mock import AsyncMock

import pytest

from pixelle_video.config import config_manager
from pixelle_video.config.schema import PixelleVideoConfig
from pixelle_video.service import PixelleVideoCore
from pixelle_video.services.api_media import APIProviderMediaService
from pixelle_video.services.tts_service import TTSService


def test_legacy_sections_are_ignored_instead_of_migrated():
    config = PixelleVideoConfig.model_validate(
        {
            "comfyui": {
                "tts": {
                    "inference_mode": "local",
                    "local": {"voice": "zh-CN-XiaoxiaoNeural", "speed": 1.1},
                },
                "image": {
                    "default_workflow": "api/grok/grok-imagine-image-quality",
                    "prompt_prefix": "clean illustration",
                },
                "video": {
                    "default_workflow": "api/grok/grok-imagine-video",
                    "prompt_prefix": "gentle motion",
                },
            }
        }
    )

    assert config.tts.voice == "zh-CN-YunjianNeural"
    assert config.model_settings.channels == {}
    assert "comfyui" not in config.model_dump()


@pytest.mark.asyncio
async def test_api_media_uses_active_image_route(monkeypatch):
    config = PixelleVideoConfig.model_validate(
        {
            "model_settings": {
                "channels": {
                    "grok": {
                        "name": "Grok",
                        "api_format": "grok2api",
                        "base_url": "https://models.example.com/v1",
                        "models": {"image": ["image-quality"]},
                    }
                },
                "routing": {"image": {"channel_id": "grok", "model": "image-quality"}},
            }
        }
    )
    monkeypatch.setattr(config_manager, "config", config)
    service = APIProviderMediaService({})
    service._generate_image = AsyncMock(return_value="image-result")

    result = await service(prompt="a stick figure", media_type="image")

    assert result == "image-result"
    service._generate_image.assert_awaited_once()
    assert service._generate_image.await_args.kwargs["route"]["channel_id"] == "grok"
    assert service._generate_image.await_args.kwargs["route"]["model"] == "image-quality"


def test_tts_service_is_edge_only():
    service = TTSService({"tts": {"provider": "edge", "voice": "test", "speed": 1.0}})

    assert service.provider == "edge"
    assert not hasattr(service, "_call_comfyui_workflow")
    assert not hasattr(service, "list_workflows")


def test_core_has_no_comfy_runtime():
    core = PixelleVideoCore()

    assert not hasattr(core, "_comfykit")
    assert not hasattr(core, "_get_or_create_comfykit")
