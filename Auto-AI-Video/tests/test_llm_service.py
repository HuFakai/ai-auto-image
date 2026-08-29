import asyncio
from types import SimpleNamespace

import pytest

from pixelle_video.services import llm_service
from pixelle_video.services.llm_service import EmptyLLMResponseError, LLMService
from pixelle_video.services.model_routing import ModelRouteExhaustedError


@pytest.mark.asyncio
async def test_llm_client_uses_explicit_proxy_policy_and_closes(monkeypatch):
    http_options = {}
    openai_options = {}
    clients = []

    class FakeHTTPClient:
        pass

    def fake_http_client(**kwargs):
        http_options.update(kwargs)
        return FakeHTTPClient()

    class FakeCompletions:
        async def create(self, **_kwargs):
            message = SimpleNamespace(content="ok")
            return SimpleNamespace(choices=[SimpleNamespace(message=message)])

    class FakeOpenAI:
        def __init__(self, **kwargs):
            openai_options.update(kwargs)
            self.base_url = kwargs.get("base_url")
            self.chat = SimpleNamespace(completions=FakeCompletions())
            self.closed = False
            clients.append(self)

        async def close(self):
            self.closed = True

    monkeypatch.setattr(llm_service.httpx, "AsyncClient", fake_http_client)
    monkeypatch.setattr(llm_service, "AsyncOpenAI", FakeOpenAI)

    service = LLMService({})
    values = {
        "api_key": "test-key",
        "base_url": "https://llm.example.com/v1",
        "model": "test-model",
        "use_proxy": False,
        "local_proxy": "socks5://should-not-be-used:1080",
        "user_agent": "python-httpx/0.28.1",
    }
    monkeypatch.setattr(service, "_get_config_value", lambda key, default=None: values.get(key, default))

    # Force the isolated client path so a developer's local configured model
    # routes cannot change what this unit test exercises.
    assert await service("hello", model="test-model") == "ok"
    assert http_options["proxy"] is None
    assert http_options["trust_env"] is False
    assert http_options["timeout"].read == 300.0
    assert http_options["timeout"].connect == 30.0
    assert isinstance(openai_options["http_client"], FakeHTTPClient)
    assert openai_options["timeout"] == http_options["timeout"]
    assert openai_options["default_headers"] == {"User-Agent": "python-httpx/0.28.1"}
    assert clients[0].closed is True


@pytest.mark.asyncio
async def test_configured_route_applies_channel_request_timeout():
    service = LLMService({})
    client = service._create_configured_client(
        {
            "channel_id": "primary",
            "model": "writer-a",
            "base_url": "https://llm.example.com/v1",
            "api_key": "test-key",
            "request_timeout": 123,
            "use_proxy": False,
        }
    )
    try:
        assert client._client.timeout.read == 123.0
        assert client._client.timeout.write == 123.0
        assert client._client.timeout.connect == 30.0
        assert client._client.timeout.pool == 30.0
        assert client.timeout.read == 123.0
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_configured_route_enforces_wall_clock_timeout_and_uses_fallback(monkeypatch):
    from pixelle_video.config import config_manager

    monkeypatch.setattr(
        config_manager,
        "resolve_model_routes",
        lambda capability: [
            {
                "channel_id": "primary",
                "model": "writer-a",
                "request_timeout": 300,
                "retry_count": 3,
                "reasoning_effort": "high",
            },
            {
                "channel_id": "secondary",
                "model": "writer-b",
                "request_timeout": 300,
                "retry_count": 3,
                "reasoning_effort": "none",
            },
            {
                "channel_id": "tertiary",
                "model": "writer-c",
                "request_timeout": 300,
                "retry_count": 3,
                "reasoning_effort": "none",
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
            await asyncio.sleep(0.05)
        return "fallback answer"

    service = LLMService({})
    monkeypatch.setattr(service, "_create_configured_client", lambda _route: FakeClient())
    monkeypatch.setattr(service, "_invoke", fake_invoke)

    result = await service(
        "prompt",
        _request_timeout=0.01,
        _route_retry_count=0,
        _route_limit=2,
    )

    assert result == "fallback answer"
    assert calls == ["writer-a", "writer-b"]


@pytest.mark.asyncio
async def test_configured_route_reports_wall_clock_timeout(monkeypatch):
    from pixelle_video.config import config_manager

    monkeypatch.setattr(
        config_manager,
        "resolve_model_routes",
        lambda capability: [
            {
                "channel_id": "primary",
                "model": "writer-a",
                "request_timeout": 300,
                "retry_count": 3,
                "reasoning_effort": "none",
            }
        ],
    )

    class FakeClient:
        async def close(self):
            return None

    async def slow_invoke(*_args, **_kwargs):
        await asyncio.sleep(0.05)

    service = LLMService({})
    monkeypatch.setattr(service, "_create_configured_client", lambda _route: FakeClient())
    monkeypatch.setattr(service, "_invoke", slow_invoke)

    with pytest.raises(ModelRouteExhaustedError, match="timed out after 0.01s"):
        await service("prompt", _request_timeout=0.01, _route_retry_count=0)


@pytest.mark.asyncio
async def test_deepseek_reasoning_can_be_disabled_without_conflicting_route_default(monkeypatch):
    from pixelle_video.config import config_manager

    monkeypatch.setattr(
        config_manager,
        "resolve_model_routes",
        lambda capability: [
            {
                "channel_id": "primary",
                "model": "deepseek-v4-flash",
                "request_timeout": 300,
                "retry_count": 3,
                "reasoning_effort": "high",
            }
        ],
    )

    class FakeClient:
        async def close(self):
            return None

    captured: dict[str, object] = {}

    async def fake_invoke(_client, _model, _prompt, *_args, **kwargs):
        captured.update(kwargs)
        return "answer"

    service = LLMService({})
    monkeypatch.setattr(service, "_create_configured_client", lambda _route: FakeClient())
    monkeypatch.setattr(service, "_invoke", fake_invoke)

    result = await service(
        "prompt",
        reasoning_effort="none",
        _disable_provider_reasoning=True,
        _route_retry_count=0,
        _route_limit=1,
    )

    assert result == "answer"
    assert captured["extra_body"] == {"thinking": {"type": "disabled"}}
    assert "reasoning_effort" not in captured


@pytest.mark.asyncio
async def test_llm_retries_reasoning_only_response_with_larger_budget(monkeypatch):
    calls = []

    class FakeCompletions:
        async def create(self, **kwargs):
            calls.append(kwargs)
            if len(calls) == 1:
                message = SimpleNamespace(content=None, reasoning_content="thinking" * 20)
                return SimpleNamespace(
                    choices=[SimpleNamespace(message=message, finish_reason="length")]
                )
            message = SimpleNamespace(content="final answer", reasoning_content="")
            return SimpleNamespace(
                choices=[SimpleNamespace(message=message, finish_reason="stop")]
            )

    class FakeClient:
        base_url = "https://llm.example.com/v1"
        chat = SimpleNamespace(completions=FakeCompletions())

        async def close(self):
            return None

    service = LLMService({})
    monkeypatch.setattr(service, "_create_client", lambda **_kwargs: FakeClient())
    monkeypatch.setattr(service, "_get_config_value", lambda key, default=None: "reasoner" if key == "model" else default)

    assert await service("hello", max_tokens=1000) == "final answer"
    assert [call["max_tokens"] for call in calls] == [1000, 4096]


@pytest.mark.asyncio
async def test_llm_can_skip_empty_response_retry(monkeypatch):
    calls = 0

    class FakeCompletions:
        async def create(self, **_kwargs):
            nonlocal calls
            calls += 1
            message = SimpleNamespace(content=None, reasoning_content="thinking")
            return SimpleNamespace(
                choices=[SimpleNamespace(message=message, finish_reason="length")]
            )

    class FakeClient:
        base_url = "https://llm.example.com/v1"
        chat = SimpleNamespace(completions=FakeCompletions())

        async def close(self):
            return None

    service = LLMService({})
    monkeypatch.setattr(service, "_create_client", lambda **_kwargs: FakeClient())
    monkeypatch.setattr(
        service,
        "_get_config_value",
        lambda key, default=None: "reasoner" if key == "model" else default,
    )

    with pytest.raises(EmptyLLMResponseError, match="after 1 attempt"):
        await service("hello", max_tokens=1000, _empty_response_retries=0)
    assert calls == 1


def test_llm_normalizes_multipart_text_without_using_reasoning_content():
    content = [
        {"type": "text", "text": "first "},
        SimpleNamespace(text={"value": "second"}),
    ]
    message = SimpleNamespace(content=content, reasoning_content="private reasoning")

    assert LLMService._extract_message_text(message.content) == "first second"
    assert LLMService._reasoning_content_length(message) == len("private reasoning")
