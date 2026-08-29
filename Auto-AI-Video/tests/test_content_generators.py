import json

import pytest

from pixelle_video.utils.content_generators import (
    _parse_json,
    generate_narrations_from_topic,
)


@pytest.mark.asyncio
async def test_narration_generation_retries_invalid_json_with_large_budget():
    calls = []
    responses = iter(
        [
            "reasoning without a final JSON answer",
            json.dumps({"narrations": ["第一镜", "第二镜", "第三镜"]}),
        ]
    )

    async def llm_service(**kwargs):
        calls.append(kwargs)
        return next(responses)

    result = await generate_narrations_from_topic(
        llm_service,
        topic="测试主题",
        n_scenes=3,
    )

    assert result == ["第一镜", "第二镜", "第三镜"]
    assert len(calls) == 2
    assert all(call["max_tokens"] == 8192 for call in calls)


@pytest.mark.asyncio
async def test_narration_generation_stops_after_configured_retries():
    calls = 0

    async def llm_service(**_kwargs):
        nonlocal calls
        calls += 1
        return "not json"

    with pytest.raises(json.JSONDecodeError, match="No valid JSON"):
        await generate_narrations_from_topic(
            llm_service,
            topic="测试主题",
            n_scenes=2,
            max_retries=2,
        )

    assert calls == 2


def test_parse_json_extracts_video_prompts_from_surrounding_text():
    result = _parse_json('结果如下：{"video_prompts":["one","two"]} 完成')

    assert result == {"video_prompts": ["one", "two"]}
