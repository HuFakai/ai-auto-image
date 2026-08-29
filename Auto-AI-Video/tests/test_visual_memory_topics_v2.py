from pixelle_video.production.models import ChannelConfig
from pixelle_video.production.presets import resolve_channel_request
from pixelle_video.production.topics import score_topic
from pixelle_video.production.visual_memory import build_visual_memory_prompt


def _channel() -> ChannelConfig:
    return ChannelConfig.model_validate(
        {
            "id": "science_v2",
            "name": "日常科学",
            "topic": {
                "prompt": "解释日常科学原理",
                "seeds": ["为什么天空是蓝色的"],
            },
            "planning": {"content_policy": "science"},
            "visual_memory": {
                "characters": ["friendly illustrated scientist"],
                "palette": ["navy and lime"],
                "composition": ["clear central subject"],
                "forbidden_elements": ["photorealism", "unreadable text"],
                "exemplars": ["clean editorial explainer"],
            },
            "video": {
                "frame_template": "1080x1920/video_default.html",
                "media_workflow": "api/grok/grok-imagine-video",
                "prompt_prefix": "editorial science illustration",
            },
        }
    )


def test_visual_memory_is_backward_compatible_and_injected_into_request():
    channel = _channel()
    prompt = build_visual_memory_prompt(channel.visual_memory)
    request = resolve_channel_request(None, channel, "为什么天空是蓝色的")

    assert "friendly illustrated scientist" in prompt
    assert "photorealism" in prompt
    assert "friendly illustrated scientist" in request["prompt_prefix"]
    assert request["visual_memory"]["palette"] == ["navy and lime"]
    assert request["cover_prompt"] == request["visual_memory_prompt"] or "VISUAL MEMORY" in request["cover_prompt"]


def test_topic_similarity_is_layered_and_allows_a_new_angle_case():
    channel = _channel()
    terms = ["天空", "蓝色", "瑞利散射", "光波长"]
    reference = score_topic(
        channel,
        "天空为什么是蓝色",
        "用瑞利散射解释短波光更容易被散射。",
        [],
        terms,
    )
    repeated = score_topic(
        channel,
        "天空为何呈蓝色",
        "从瑞利散射说明短波光散射更强。",
        [{"id": "old", "topic": "用瑞利散射解释短波光更容易被散射。", "semantic_terms": terms, "semantic_vector": reference["semantic_vector"]}],
        terms,
    )
    new_angle = score_topic(
        channel,
        "雨后天空为什么更通透",
        "从空气颗粒物和观察场景的对比，解释雨后天空显得更蓝。",
        [{"id": "old", "topic": "用瑞利散射解释短波光更容易被散射。", "semantic_terms": terms, "semantic_vector": reference["semantic_vector"]}],
        ["天空", "蓝色", "空气颗粒物", "雨后场景"],
    )

    assert set(repeated["scores"]["similarity_layers"]) == {
        "core_conclusion", "narrative_angle", "case",
    }
    assert repeated["duplicate_of"] == "old"
    assert repeated["reasons"]["most_similar_history"]["id"] == "old"
    assert new_angle["duplicate_of"] is None
