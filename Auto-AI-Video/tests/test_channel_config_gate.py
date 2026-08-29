from pixelle_video.production.models import ChannelConfig
from pixelle_video.production.validation import channel_semantic_gate


def _channel(**video):
    return ChannelConfig.model_validate({
        "id": "science_channel",
        "name": "一分钟科普",
        "topic": {
            "strategy": "seed",
            "prompt": "讲清日常科学原理",
            "seeds": ["为什么天空是蓝色的"],
        },
        "planning": {"content_policy": "science"},
        "video": {
            "frame_template": "1080x1920/video_default.html",
            "media_workflow": "api/grok/grok-imagine-video",
            **video,
        },
    })


def test_channel_gate_does_not_restrict_visual_style_and_keeps_defaults():
    channel = _channel(
        prompt_prefix="古风水墨山水画，孤舟渔火， classical poetry atmosphere",
        watermark={"enabled": True, "text": "Pixelle", "motion": "moving", "opacity": 0.5},
    )
    result = channel_semantic_gate(channel)
    assert result["blocking"] is False
    assert result["issues"] == []
    assert channel.config_source == "manual"
    assert channel.video["limit_scenes"] is True
    assert channel.video["watermark"]["position"] == "bottom_right"


def test_unlimited_scene_channel_request_omits_n_scenes():
    channel = _channel(limit_scenes=False, n_scenes=9)
    assert channel.video["n_scenes"] == 9
    from pixelle_video.production.presets import resolve_channel_request

    request = resolve_channel_request(None, channel, "天空为什么是蓝色的")
    assert request["limit_scenes"] is False
    assert "n_scenes" not in request


def test_economics_whiteboard_checks_active_recipe_not_fallback_prompt():
    channel = ChannelConfig.model_validate({
        "id": "economics_knowledge",
        "name": "60秒经济学",
        "topic": {
            "strategy": "seed",
            "prompt": "用生活案例讲清机会成本、供需关系和边际效用。",
            "seeds": ["为什么奶茶第二杯半价？", "为什么机票价格一直变化？"],
        },
        "planning": {"content_policy": "general"},
        "video": {
            "production_mode": "whiteboard_animation",
            "render_engine": "whiteboard_cv",
            "frame_template": None,
            "media_workflow": "api/grok/grok-imagine-image",
            "prompt_prefix": "Clear animated science explainer with infographic shapes",
            "whiteboard": {
                "template_id": "black-gold-tech",
                "template_version": 1,
                "prompt_recipe": "深黑与炭灰背景，金色数据结构与高级商业发布会构图。",
            },
        },
    })

    result = channel_semantic_gate(channel)

    assert result["allowed"] is True
    assert result["issues"] == []
