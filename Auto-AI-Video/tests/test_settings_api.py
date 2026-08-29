import json
import os
import stat
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from api.app import app
from api.schemas.video import VideoGenerateRequest
from pixelle_video.config import config_manager
from pixelle_video.config.schema import PixelleVideoConfig
from pixelle_video.production.models import ChannelConfig
from pixelle_video.production.presets import resolve_channel_request
from pixelle_video.utils.template_util import resolve_template_fingerprint


def _configured_app(tmp_path: Path, monkeypatch):
    monkeypatch.setattr(config_manager, "config_path", tmp_path / "config.yaml")
    monkeypatch.setattr(
        config_manager,
        "config",
        PixelleVideoConfig.model_validate(
            {
                "model_settings": {
                    "channels": {
                        "primary": {
                            "name": "Primary",
                            "api_format": "grok2api",
                            "base_url": "https://models.example.com/v1",
                            "api_key": "server-only-secret",
                            "models": {
                                "text": ["reasoner"],
                                "image": ["image-gen"],
                                "video": ["video-gen"],
                            },
                        }
                    },
                    "routing": {
                        capability: {"channel_id": "primary", "model": model}
                        for capability, model in {
                            "text": "reasoner",
                            "image": "image-gen",
                            "video": "video-gen",
                        }.items()
                    },
                }
            },
        ),
    )
    return TestClient(app)


def _write_body(public: dict) -> dict:
    return {
        "channels": {
            channel_id: _channel_write(channel)
            for channel_id, channel in public["channels"].items()
        },
        "routing": public["routing"],
        "runtime": public["runtime"],
    }


def _channel_write(channel: dict) -> dict:
    return {
        key: value
        for key, value in channel.items()
        if key not in {"api_key_configured", "api_key_hint"}
    }


def test_settings_get_masks_credentials(tmp_path: Path, monkeypatch):
    client = _configured_app(tmp_path, monkeypatch)

    response = client.get("/api/settings")

    assert response.status_code == 200
    payload = response.json()
    assert payload["channels"]["primary"]["api_key_configured"] is True
    assert "api_key" not in payload["channels"]["primary"]
    assert "server-only-secret" not in json.dumps(payload)


def test_settings_save_preserves_secret_and_updates_independent_routes(tmp_path: Path, monkeypatch):
    client = _configured_app(tmp_path, monkeypatch)
    body = _write_body(client.get("/api/settings").json())
    body["channels"]["secondary"] = {
        "name": "Secondary",
        "api_format": "openai",
        "base_url": "https://openai.example.com/v1",
        "api_key": "second-secret",
        "models": {"text": ["writer"], "image": [], "video": []},
    }
    body["routing"]["text"] = {"channel_id": "secondary", "model": "writer"}
    body["routing"]["text"]["reasoning_effort"] = "high"
    body["runtime"]["tts_voice"] = "zh-CN-YunxiNeural"

    response = client.put("/api/settings", json=body)

    assert response.status_code == 200
    assert config_manager.resolve_model("text")["channel_id"] == "secondary"
    assert config_manager.resolve_model("text")["reasoning_effort"] == "high"
    assert config_manager.resolve_model("video")["channel_id"] == "primary"
    assert config_manager.config.model_settings.channels["primary"].api_key == (
        "server-only-secret"
    )
    assert "server-only-secret" in config_manager.config_path.read_text(encoding="utf-8")
    if os.name != "nt":
        assert stat.S_IMODE(config_manager.config_path.stat().st_mode) == 0o600
    assert "server-only-secret" not in response.text


def test_settings_rejects_route_to_disabled_channel(tmp_path: Path, monkeypatch):
    client = _configured_app(tmp_path, monkeypatch)
    body = _write_body(client.get("/api/settings").json())
    body["channels"]["primary"]["enabled"] = False

    response = client.put("/api/settings", json=body)

    assert response.status_code == 422
    assert "disabled" in response.json()["detail"]


def test_settings_can_explicitly_clear_a_stored_secret(tmp_path: Path, monkeypatch):
    client = _configured_app(tmp_path, monkeypatch)
    body = _write_body(client.get("/api/settings").json())
    body["channels"]["primary"]["clear_api_key"] = True

    response = client.put("/api/settings", json=body)

    assert response.status_code == 200
    assert config_manager.config.model_settings.channels["primary"].api_key == ""
    assert response.json()["channels"]["primary"]["api_key_configured"] is False


def test_unconfigured_routes_persist_without_legacy_sections(tmp_path: Path, monkeypatch):
    client = _configured_app(tmp_path, monkeypatch)
    body = _write_body(client.get("/api/settings").json())
    body["routing"] = {
        capability: {"channel_id": "", "model": ""} for capability in ("text", "image", "video")
    }

    response = client.put("/api/settings", json=body)

    assert response.status_code == 200
    assert config_manager.config.model_settings.routing.text.model == ""
    saved = config_manager.config_path.read_text(encoding="utf-8")
    assert "llm:" not in saved
    assert "api_providers:" not in saved
    assert "default_workflow:" not in saved


def test_model_channel_connection_test_reuses_stored_secret(tmp_path: Path, monkeypatch):
    client = _configured_app(tmp_path, monkeypatch)
    seen = {}

    def fake_fetch(api_key, base_url, **options):
        seen.update(api_key=api_key, base_url=base_url, options=options)
        return ["reasoner", "video-gen"]

    monkeypatch.setattr("api.routers.settings.fetch_available_models", fake_fetch)
    channel = _channel_write(client.get("/api/settings").json()["channels"]["primary"])

    response = client.post(
        "/api/settings/models/test",
        json={**channel, "channel_id": "primary"},
    )

    assert response.status_code == 200
    assert response.json()["models"] == ["reasoner", "video-gen"]
    assert seen["api_key"] == "server-only-secret"


def test_legacy_config_is_not_promoted_to_model_settings():
    config = PixelleVideoConfig.model_validate(
        {
            "llm": {
                "api_key": "secret",
                "base_url": "https://models.example.com/v1",
                "model": "reasoner",
            },
            "api_providers": {
                "grok": {
                    "api_key": "secret",
                    "base_url": "https://models.example.com/v1",
                }
            },
            "media": {
                "image": {
                    "default_workflow": "api/grok/image-gen",
                    "prompt_prefix": "",
                },
                "video": {
                    "default_workflow": "api/grok/video-gen",
                    "prompt_prefix": "",
                },
            },
        }
    )

    assert config.model_settings.channels == {}
    assert config.model_settings.routing.text.model == ""


def test_follow_default_video_route_is_frozen_when_job_is_created(tmp_path: Path, monkeypatch):
    _configured_app(tmp_path, monkeypatch)
    channel = ChannelConfig.model_validate(
        {
            "id": "science",
            "name": "Science",
            "topic": {"strategy": "seed", "seeds": ["space"]},
            "video": {
                "frame_template": "1080x1920/video_default.html",
                "media_workflow": "api/default/video",
            },
        }
    )

    request = resolve_channel_request(None, channel, "space")

    assert request["media_workflow"] == "api/primary/video-gen"


def test_image_channel_defaults_to_hyperframes_and_freezes_native_fallback_settings(tmp_path: Path, monkeypatch):
    _configured_app(tmp_path, monkeypatch)
    channel = ChannelConfig.model_validate(
        {
            "id": "morning_radio",
            "name": "Morning Radio",
            "topic": {"strategy": "seed", "seeds": ["good morning"]},
            "video": {
                "frame_template": "1080x1920/image_default.html",
                "media_workflow": "api/default/image",
                "subtitle_effect": "typewriter",
                "native": {
                    "image_motion": "ken_burns",
                    "transition": "crossfade",
                    "transition_duration": 0.6,
                    "scene_direction": "auto",
                    "motion_pool": [
                        "ken_burns",
                        "push_in",
                        "pull_out",
                        "pan_left",
                        "pan_right",
                        "pan_up",
                    ],
                    "transition_pool": [
                        "crossfade",
                        "dissolve",
                        "slide_left",
                        "circle_open",
                        "zoom_in",
                        "blur",
                    ],
                },
            },
        }
    )

    request = resolve_channel_request(None, channel, "good morning")
    _, template_sha256 = resolve_template_fingerprint(
        "1080x1920/f2_knowledge_card_v1.html"
    )

    assert request["media_workflow"] == "api/primary/image-gen"
    assert request["render_engine"] == "hyperframes"
    assert request["production_mode"] == "hyperframes"
    assert request["renderer_version"] == "0.8.4"
    assert request["template_sha256"] == template_sha256
    assert request["image_motion"] == "ken_burns"
    assert request["transition"] == "crossfade"
    assert request["transition_duration"] == 0.6
    assert request["subtitle_effect"] == "typewriter"
    assert request["_production"]["rendering"] == {
        "mode": "hyperframes",
        "engine": "hyperframes",
        "renderer_version": "0.8.4",
        "image_generation_concurrency": 4,
        "subtitle_effect": "typewriter",
        "template": {
            "path": "1080x1920/f2_knowledge_card_v1.html",
            "sha256": template_sha256,
        },
        "native": {
            "image_motion": "ken_burns",
            "transition": "crossfade",
            "transition_duration": 0.6,
            "scene_direction": "auto",
            "motion_pool": [
                "ken_burns",
                "push_in",
                "pull_out",
                "pan_left",
                "pan_right",
                "pan_up",
            ],
            "transition_pool": [
                "crossfade",
                "dissolve",
                "slide_left",
                "circle_open",
                "zoom_in",
                "blur",
            ],
        },
        "hyperframes": {
            "template_id": "knowledge-card",
            "template_version": 1,
            "variables": {
                "accent_color": "#BFFF3C",
                "surface_color": "#0B0F0D",
                "text_color": "#F4F5EF",
                "brand_label": "Morning Radio",
                "eyebrow_label": "",
                "card_opacity": 0.88,
            },
            "quality": "standard",
            "strictness": "strict",
            "use_gpu": True,
            "fallback_to_native": True,
        },
    }


def test_enabled_hyperframes_channel_is_normalized_and_open_for_production():
    base = {
        "id": "hyperframes_lab",
        "name": "HyperFrames Lab",
        "topic": {"strategy": "seed", "seeds": ["test"]},
        "video": {
            "frame_template": "1080x1920/image_default.html",
            "media_workflow": "api/default/image",
            "render_engine": "hyperframes",
        },
    }

    channel = ChannelConfig.model_validate(base)
    assert channel.video["production_mode"] == "hyperframes"
    assert channel.video["renderer_version"] == "0.8.4"
    assert channel.video["hyperframes"]["fallback_to_native"] is True
    request = resolve_channel_request(None, channel, "test")
    assert request["production_mode"] == "hyperframes"
    assert request["render_engine"] == "hyperframes"
    assert request["renderer_version"] == "0.8.4"


def test_hyperframes_uses_channel_name_and_empty_scene_label_by_default():
    channel = ChannelConfig.model_validate({
        "id": "knowledge_cards",
        "name": "一分钟知识卡",
        "topic": {"strategy": "seed", "seeds": ["test"]},
        "video": {
            "frame_template": "1080x1920/image_default.html",
            "media_workflow": "api/default/image",
            "render_engine": "hyperframes",
            "hyperframes": {
                "template_id": "morning-radio",
                "template_version": 1,
            },
        },
    })

    request = resolve_channel_request(None, channel, "test")

    assert request["hyperframes"]["variables"]["brand_label"] == "一分钟知识卡"
    assert request["hyperframes"]["variables"]["eyebrow_label"] == ""
    assert request["template_params"] == request["hyperframes"]["variables"]


def test_hyperframes_preserves_explicit_custom_labels():
    channel = ChannelConfig.model_validate({
        "id": "knowledge_cards",
        "name": "一分钟知识卡",
        "topic": {"strategy": "seed", "seeds": ["test"]},
        "video": {
            "frame_template": "1080x1920/image_default.html",
            "media_workflow": "api/default/image",
            "render_engine": "hyperframes",
            "hyperframes": {
                "template_id": "morning-radio",
                "template_version": 1,
                "variables": {
                    "brand_label": "特别栏目",
                    "eyebrow_label": "EPISODE 07",
                },
            },
        },
    })

    request = resolve_channel_request(None, channel, "test")

    assert request["hyperframes"]["variables"]["brand_label"] == "特别栏目"
    assert request["hyperframes"]["variables"]["eyebrow_label"] == "EPISODE 07"


def test_whiteboard_channel_freezes_visual_recipe_without_html_template(
    tmp_path: Path,
    monkeypatch,
):
    _configured_app(tmp_path, monkeypatch)
    channel = ChannelConfig.model_validate(
        {
            "id": "whiteboard_science",
            "name": "Whiteboard Science",
            "topic": {"strategy": "seed", "seeds": ["潮汐"]},
            "video": {
                "production_mode": "whiteboard_animation",
                "render_engine": "whiteboard_cv",
                "media_workflow": "api/default/image",
                "whiteboard": {
                    "template_id": "business-doodle",
                    "template_version": 1,
                    "hand_enabled": True,
                    "fallback_policy": "grid",
                },
            },
        }
    )

    request = resolve_channel_request(None, channel, "潮汐")

    assert request["production_mode"] == "whiteboard_animation"
    assert request["render_engine"] == "whiteboard_cv"
    assert request["renderer_version"] == "whiteboard-cv-v1"
    assert request["frame_template"] is None
    assert request["template_sha256"] is None
    assert request["media_workflow"] == "api/primary/image-gen"
    assert request["whiteboard"]["template_id"] == "business-doodle"
    assert request["whiteboard"]["template_fingerprint"]
    assert "冷白至极浅灰背景" in request["prompt_prefix"]
    assert request["_production"]["rendering"]["whiteboard"] == request["whiteboard"]


def test_direct_api_rejects_an_unfrozen_renderer_version():
    with pytest.raises(ValueError, match="renderer_version"):
        VideoGenerateRequest.model_validate(
            {
                "text": "test",
                "renderer_version": "native-image-html-latest",
            }
        )


def test_direct_api_keeps_v1_available_for_task_recovery():
    request = VideoGenerateRequest.model_validate(
        {
            "text": "recover",
            "production_mode": "direct_video",
            "render_engine": "native_image_html",
            "renderer_version": "native-image-html-v1",
            "media_workflow": "api/default/video",
        }
    )
    assert request.renderer_version == "native-image-html-v1"


def test_direct_api_rejects_removed_native_image_production_mode():
    with pytest.raises(ValueError, match="production_mode"):
        VideoGenerateRequest.model_validate(
            {
                "text": "new image task",
                "production_mode": "native_image_html",
                "render_engine": "native_image_html",
                "renderer_version": "native-image-html-v2",
                "media_workflow": "api/default/image",
            }
        )


def test_direct_api_keeps_hyperframes_083_available_for_task_recovery():
    request = VideoGenerateRequest.model_validate(
        {
            "text": "recover",
            "production_mode": "hyperframes",
            "render_engine": "hyperframes",
            "renderer_version": "0.8.3",
            "media_workflow": "api/default/image",
        }
    )
    assert request.renderer_version == "0.8.3"
