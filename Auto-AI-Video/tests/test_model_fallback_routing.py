from typing import Any

import pytest
from pydantic import ValidationError

from pixelle_video.config import config_manager
from pixelle_video.config.schema import ModelSettingsConfig, PixelleVideoConfig
from pixelle_video.models.media import MediaResult
from pixelle_video.services.api_media import APIProviderMediaService
from pixelle_video.services.llm_service import LLMService
from pixelle_video.services.model_routing import ModelRouteExhaustedError
from tests.test_settings_api import _configured_app, _write_body


def _channels() -> dict[str, Any]:
    return {
        "primary": {
            "name": "Primary",
            "base_url": "https://primary.example.com/v1",
            "api_key": "primary-key",
            "retry_count": 2,
            "models": {
                "text": ["writer-a"],
                "image": ["image-a"],
                "video": ["video-a"],
            },
        },
        "secondary": {
            "name": "Secondary",
            "base_url": "https://secondary.example.com/v1",
            "api_key": "secondary-key",
            "retry_count": 1,
            "models": {
                "text": ["writer-b"],
                "image": ["image-b"],
                "video": ["video-b"],
            },
        },
    }


def test_ordered_fallback_routes_are_validated_and_deduplicated():
    settings = ModelSettingsConfig.model_validate(
        {
            "channels": _channels(),
            "routing": {
                "text": {
                    "channel_id": "primary",
                    "model": "writer-a",
                    "fallbacks": [
                        {"channel_id": "secondary", "model": "writer-b"},
                        {"channel_id": "secondary", "model": "writer-b"},
                    ],
                }
            },
        }
    )

    assert [
        (route.channel_id, route.model) for route in settings.routing.text.fallbacks
    ] == [("secondary", "writer-b")]

    with pytest.raises(ValidationError, match="Unknown text model channel"):
        ModelSettingsConfig.model_validate(
            {
                "channels": _channels(),
                "routing": {
                    "text": {
                        "channel_id": "primary",
                        "model": "writer-a",
                        "fallbacks": [{"channel_id": "missing", "model": "writer-b"}],
                    }
                },
            }
        )


def test_settings_api_persists_ordered_fallback_routes(tmp_path, monkeypatch):
    client = _configured_app(tmp_path, monkeypatch)
    body = _write_body(client.get("/api/settings").json())
    body["channels"]["secondary"] = {
        "name": "Secondary",
        "api_format": "openai",
        "base_url": "https://secondary.example.com/v1",
        "api_key": "second-secret",
        "retry_count": 1,
        "models": {"text": ["writer-b"], "image": ["image-b"], "video": []},
    }
    body["routing"]["text"]["fallbacks"] = [
        {"channel_id": "secondary", "model": "writer-b", "reasoning_effort": "none"}
    ]

    response = client.put("/api/settings", json=body)

    assert response.status_code == 200
    routes = config_manager.resolve_model_routes("text")
    assert [(route["channel_id"], route["model"]) for route in routes] == [
        ("primary", "reasoner"),
        ("secondary", "writer-b"),
    ]
    assert [route["retry_count"] for route in routes] == [3, 1]
    saved = config_manager.config_path.read_text(encoding="utf-8")
    assert "fallbacks:" in saved


async def test_text_routes_exhaust_preferred_retries_before_fallback(monkeypatch):
    monkeypatch.setattr(
        config_manager,
        "resolve_model_routes",
        lambda capability: [
            {
                "channel_id": "primary",
                "model": "writer-a",
                "reasoning_effort": "none",
                "retry_count": 1,
            },
            {
                "channel_id": "secondary",
                "model": "writer-b",
                "reasoning_effort": "none",
                "retry_count": 0,
            },
        ],
    )

    class FakeClient:
        async def close(self):
            return None

    calls: list[str] = []

    async def fake_invoke(_client, model, _prompt, *_args, **_kwargs):
        calls.append(model)
        if model == "writer-a":
            raise RuntimeError("preferred unavailable")
        return "ok"

    service = LLMService({})
    monkeypatch.setattr(service, "_create_configured_client", lambda route: FakeClient())
    monkeypatch.setattr(service, "_invoke", fake_invoke)

    assert await service("prompt") == "ok"
    assert calls == ["writer-a", "writer-a", "writer-b"]


async def test_media_routes_switch_after_the_preferred_route_fails(monkeypatch):
    service = APIProviderMediaService({})
    routes = [
        {"channel_id": "primary", "model": "image-a", "retry_count": 1},
        {"channel_id": "secondary", "model": "image-b", "retry_count": 0},
    ]
    monkeypatch.setattr(service, "resolve_workflow", lambda selector: {"media_type": "image"})
    monkeypatch.setattr(service, "_routes_for_request", lambda selector, media_type: routes)
    calls: list[tuple[str, str, list[str] | None]] = []

    async def fake_generate_image(route, **kwargs):
        call = (route["channel_id"], route["model"], kwargs.get("image_paths"))
        calls.append(call)
        if route["channel_id"] == "primary":
            raise RuntimeError("first route failed")
        return MediaResult(media_type="image", url="/tmp/fallback.png")

    monkeypatch.setattr(service, "_generate_image", fake_generate_image)

    result = await service(
        "prompt",
        workflow="api/primary/image-a",
        image_paths=["reference.png"],
    )

    assert result.url == "/tmp/fallback.png"
    assert calls == [
        ("primary", "image-a", ["reference.png"]),
        ("secondary", "image-b", ["reference.png"]),
    ]


async def test_media_failure_records_every_attempted_route(monkeypatch):
    service = APIProviderMediaService({})
    routes = [
        {"channel_id": "primary", "model": "image-a", "retry_count": 1},
        {"channel_id": "secondary", "model": "image-b", "retry_count": 0},
    ]
    monkeypatch.setattr(service, "resolve_workflow", lambda selector: {"media_type": "image"})
    monkeypatch.setattr(service, "_routes_for_request", lambda selector, media_type: routes)

    async def always_fail(route, **_kwargs):
        raise RuntimeError(route["model"])

    monkeypatch.setattr(service, "_generate_image", always_fail)

    with pytest.raises(ModelRouteExhaustedError) as captured:
        await service("prompt", workflow="api/primary/image-a")

    assert [(item["channel_id"], item["model"]) for item in captured.value.attempts] == [
        ("primary", "image-a"),
        ("secondary", "image-b"),
    ]


def test_media_route_helper_merges_configured_fallbacks(monkeypatch):
    config = PixelleVideoConfig.model_validate(
        {
            "model_settings": {
                "channels": _channels(),
                "routing": {
                    "image": {
                        "channel_id": "primary",
                        "model": "image-a",
                        "fallbacks": [
                            {"channel_id": "primary", "model": "image-a"},
                            {"channel_id": "secondary", "model": "image-b"},
                        ],
                    }
                },
            }
        }
    )
    monkeypatch.setattr(config_manager, "config", config)
    service = APIProviderMediaService({})

    routes = service._routes_for_request("api/primary/image-a", "image")

    assert [(route["channel_id"], route["model"]) for route in routes] == [
        ("primary", "image-a"),
        ("secondary", "image-b"),
    ]
