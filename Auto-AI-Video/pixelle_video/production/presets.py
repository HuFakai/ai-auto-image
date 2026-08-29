"""Resolve channel-owned settings into reproducible production requests."""

from __future__ import annotations

from copy import deepcopy
from typing import Any

from pixelle_video.config import config_manager
from pixelle_video.services.template_packs import TemplatePackRegistry
from pixelle_video.utils.template_util import resolve_template_fingerprint

from .models import ChannelConfig, normalize_video_rendering
from .store import ProductionStore
from .visual_memory import build_visual_memory_prompt, merge_visual_prompt


def resolve_channel_request(
    store: ProductionStore,
    channel: ChannelConfig,
    topic: str,
    title: str | None = None,
    *,
    video_overrides: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Build one reproducible request from the channel's single source of truth."""
    video = deepcopy(channel.video)
    production: dict[str, Any] = {"channel_id": channel.id}

    if video_overrides:
        video = _deep_merge(video, deepcopy(video_overrides))

    video = normalize_video_rendering(video)
    _apply_channel_template_defaults(video, channel.name)
    visual_memory = channel.visual_memory
    visual_memory_prompt = build_visual_memory_prompt(visual_memory)
    video["visual_memory"] = visual_memory.model_dump()
    video["visual_memory_prompt"] = visual_memory_prompt
    video["prompt_prefix"] = merge_visual_prompt(
        video.get("prompt_prefix"), visual_memory_prompt
    )
    video["cover_prompt"] = merge_visual_prompt(
        "Cover art should preserve the channel's visual identity.",
        visual_memory_prompt,
    )
    if not video["limit_scenes"]:
        # The channel still stores its last n_scenes value for reversible UI
        # edits, but an unconstrained production request must not carry it.
        video.pop("n_scenes", None)
    default_capability = {
        "api/default/image": "image",
        "api/default/video": "video",
    }.get(video.get("media_workflow"))
    if default_capability:
        selection = config_manager.resolve_model(default_capability)
        video["media_workflow"] = f"api/{selection['channel_id']}/{selection['model']}"

    expected_capability = (
        "video" if video["production_mode"] == "direct_video" else "image"
    )
    selector_parts = str(video.get("media_workflow") or "").split("/", 2)
    if len(selector_parts) != 3 or selector_parts[0] != "api":
        raise ValueError("video.media_workflow must use api/<channel>/<model>")
    channel_id, model = selector_parts[1:]
    model_channel = config_manager.get_model_channel(channel_id)
    registered = (
        (model_channel.get("models") or {}).get(expected_capability, [])
        if model_channel
        else []
    )
    if model not in registered:
        raise ValueError(
            f"{video['production_mode']} requires a registered {expected_capability} model; "
            f"{video['media_workflow']} does not match"
        )

    native = video["native"]
    template_sha256 = None
    if video["production_mode"] == "whiteboard_animation":
        video["frame_template"] = None
        video["template_sha256"] = None
        recipe = str(video["whiteboard"]["prompt_recipe"])
        existing_prefix = str(video.get("prompt_prefix") or "").strip()
        video["prompt_prefix"] = " ".join(
            value
            for value in (
                recipe,
                "竖屏 9:16 构图，无文字、无 Logo、无水印，底部保留字幕安全区。",
                existing_prefix,
            )
            if value
        )
    else:
        _, template_sha256 = resolve_template_fingerprint(video["frame_template"])
        video["template_sha256"] = template_sha256
    video["image_motion"] = native["image_motion"]
    video["transition"] = native["transition"]
    video["transition_duration"] = native["transition_duration"]
    video["scene_direction"] = native["scene_direction"]
    video["motion_pool"] = deepcopy(native["motion_pool"])
    video["transition_pool"] = deepcopy(native["transition_pool"])
    production["rendering"] = {
        "mode": video["production_mode"],
        "engine": video["render_engine"],
        "renderer_version": video["renderer_version"],
        "image_generation_concurrency": video["image_generation_concurrency"],
        "subtitle_effect": video["subtitle_effect"],
        "template": {
            "path": video["frame_template"],
            "sha256": template_sha256,
        },
        "native": deepcopy(native),
        "hyperframes": deepcopy(video["hyperframes"]),
    }
    if video["production_mode"] == "whiteboard_animation":
        production["rendering"]["whiteboard"] = deepcopy(video["whiteboard"])

    planning, quality, topic_prompt = resolve_channel_policies(store, channel)
    production["planning"] = planning
    production["visual_memory"] = visual_memory.model_dump()
    production["visual_memory_prompt"] = visual_memory_prompt
    production["quality"] = quality
    production["topic_prompt"] = topic_prompt

    request = {**video, "text": topic, "_production": production}
    if title:
        request["title"] = title
    return request


def resolve_channel_policies(
    store: ProductionStore,
    channel: ChannelConfig,
) -> tuple[dict[str, Any], dict[str, Any], str]:
    """Return channel-owned planning, quality, and topic settings."""
    planning = channel.planning.model_dump()
    quality = channel.quality.model_dump()
    topic_prompt = channel.topic.prompt
    return planning, quality, topic_prompt


def validate_channel_bindings(store: ProductionStore, channel: ChannelConfig) -> None:
    """Compatibility no-op after standalone presets were retired."""


def _apply_channel_template_defaults(video: dict[str, Any], channel_name: str) -> None:
    """Replace untouched template labels with channel-aware production defaults."""
    if video.get("production_mode") != "hyperframes":
        return
    hyperframes = video.get("hyperframes") or {}
    pack = TemplatePackRegistry().load(
        str(hyperframes.get("template_id") or "knowledge-card"),
        int(hyperframes.get("template_version") or 1),
    )
    variables = dict(hyperframes.get("variables") or {})
    brand_definition = pack.variables.get("brand_label")
    eyebrow_definition = pack.variables.get("eyebrow_label")
    if brand_definition and variables.get("brand_label") in {None, "", brand_definition.default}:
        variables["brand_label"] = channel_name.strip() or str(brand_definition.default or "")
    if eyebrow_definition and variables.get("eyebrow_label") in {None, "", eyebrow_definition.default}:
        variables["eyebrow_label"] = ""
    hyperframes["variables"] = pack.resolve_variables(variables)
    video["hyperframes"] = hyperframes
    video["template_params"] = dict(hyperframes["variables"])


def _deep_merge(base: dict[str, Any], updates: dict[str, Any]) -> dict[str, Any]:
    merged = deepcopy(base)
    for key, value in updates.items():
        if isinstance(value, dict) and isinstance(merged.get(key), dict):
            merged[key] = _deep_merge(merged[key], value)
        else:
            merged[key] = deepcopy(value)
    return merged
