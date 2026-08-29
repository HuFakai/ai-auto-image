"""Deterministic validation for channel identity and visual configuration."""

from __future__ import annotations

import re
from typing import Any

_PROFILE_TERMS: dict[str, tuple[str, ...]] = {
    "science": (
        "科学", "科普", "物理", "化学", "生物", "天文", "宇宙", "实验", "原理",
        "science", "physics", "chemistry", "biology", "astronomy", "science explainer",
    ),
    "psychology": (
        "心理", "情绪", "沟通", "关系", "内耗", "边界", "自尊", "焦虑", "习惯",
        "psychology", "mental health", "emotion", "relationship",
    ),
    "lifestyle": (
        "生活", "技巧", "家居", "收纳", "清洁", "厨房", "穿搭", "育儿", "省钱",
        "lifestyle", "life tips", "home tips", "diy",
    ),
    "geography": (
        "地理", "地图", "国家", "城市", "旅行", "山水", "河流", "气候", " geography",
        "geography", "travel", "landscape",
    ),
    "poetry": (
        "诗", "词", "古风", "水墨", "国画", "书法", "禅", "诗意", "poetry", "ink wash",
    ),
    "economics": (
        "经济", "财经", "金融", "股票", "投资", "商业", "公司", "机会成本", "边际",
        "供需", "沉没成本", "价格歧视", "激励", "economics", "finance",
    ),
    "history": (
        "历史", "朝代", "战争", "文明", "文物", "history", "civilization",
    ),
}

_POSITION_VALUES = {
    "top_left", "top_center", "top_right",
    "center_left", "center", "center_right",
    "bottom_left", "bottom_center", "bottom_right",
}
_WATERMARK_KEYS = {"enabled", "text", "motion", "opacity", "position"}


def _fold(value: object) -> str:
    return re.sub(r"\s+", " ", str(value or "").casefold()).strip()


def _profiles(value: object) -> set[str]:
    text = _fold(value)
    return {
        profile
        for profile, terms in _PROFILE_TERMS.items()
        if any(term.casefold() in text for term in terms)
    }


def _issue(
    code: str,
    field: str,
    message: str,
    *,
    related_fields: list[str],
    evidence: dict[str, Any],
) -> dict[str, Any]:
    return {
        "code": code,
        "field": field,
        "related_fields": related_fields,
        "message": message,
        "evidence": evidence,
    }


def validate_watermark(value: object) -> dict[str, Any]:
    """Normalize and validate the safe watermark contract."""
    if value is not None and not isinstance(value, dict):
        raise ValueError("video.watermark must be an object")
    raw = dict(value or {})
    unknown = sorted(set(raw) - _WATERMARK_KEYS)
    if unknown:
        raise ValueError(f"video.watermark contains unsupported keys: {', '.join(unknown)}")
    enabled = raw.get("enabled", False)
    if not isinstance(enabled, bool):
        raise ValueError("video.watermark.enabled must be boolean")
    text = str(raw.get("text") or "").strip()
    if len(text) > 120:
        raise ValueError("video.watermark.text must be at most 120 characters")
    if enabled and not text:
        raise ValueError("video.watermark.text is required when watermark is enabled")
    motion = str(raw.get("motion") or "fixed")
    if motion not in {"fixed", "moving"}:
        raise ValueError("video.watermark.motion must be fixed or moving")
    try:
        opacity = float(raw.get("opacity", 0.35))
    except (TypeError, ValueError) as exc:
        raise ValueError("video.watermark.opacity must be a number") from exc
    if not 0 <= opacity <= 1:
        raise ValueError("video.watermark.opacity must be between 0 and 1")
    position = str(raw.get("position") or "bottom_right")
    if position not in _POSITION_VALUES:
        raise ValueError(
            "video.watermark.position must be one of "
            + ", ".join(sorted(_POSITION_VALUES))
        )
    return {
        "enabled": enabled,
        "text": text,
        "motion": motion,
        "opacity": opacity,
        "position": position,
    }


def channel_semantic_gate(channel: Any) -> dict[str, Any]:
    """Return structured, deterministic blockers for obvious channel mismatches.

    This deliberately checks only high-confidence profile conflicts. It is a safety
    gate for copied/AI-generated configuration, not a fuzzy quality score.
    """
    name = str(getattr(channel, "name", "") or "")
    topic = getattr(channel, "topic", None)
    prompt = str(getattr(topic, "prompt", "") or "")
    seeds = list(getattr(topic, "seeds", []) or [])
    planning = getattr(channel, "planning", None)
    policy = str(getattr(planning, "content_policy", "general") or "general")
    name_profiles = _profiles(name)
    topic_profiles = _profiles(" ".join([prompt, *seeds]))
    seed_profiles = {profile for seed in seeds for profile in _profiles(seed)}
    identity_profiles = name_profiles | topic_profiles | seed_profiles
    issues: list[dict[str, Any]] = []

    if name_profiles and topic_profiles and name_profiles.isdisjoint(topic_profiles):
        issues.append(_issue(
            "name_topic_mismatch",
            "name",
            "频道名称与 topic.prompt/seeds 的主题明显不一致",
            related_fields=["topic.prompt", "topic.seeds"],
            evidence={"name_profiles": sorted(name_profiles), "topic_profiles": sorted(topic_profiles)},
        ))

    topic_identity_profiles = name_profiles | topic_profiles
    foreign_seed_profiles = seed_profiles - topic_identity_profiles
    if foreign_seed_profiles and topic_identity_profiles:
        issues.append(_issue(
            "seeds_mismatch",
            "topic.seeds",
            "备用选题与频道名称及主题提示明显不一致",
            related_fields=["name", "topic.prompt"],
            evidence={"identity_profiles": sorted(topic_identity_profiles), "seed_profiles": sorted(seed_profiles), "foreign_profiles": sorted(foreign_seed_profiles)},
        ))

    if policy in {"science", "psychology"}:
        if identity_profiles and policy not in identity_profiles:
            issues.append(_issue(
                "content_policy_mismatch",
                "planning.content_policy",
                "内容策略与频道名称、主题或种子明显不一致",
                related_fields=["name", "topic.prompt", "topic.seeds"],
                evidence={"content_policy": policy, "identity_profiles": sorted(identity_profiles)},
            ))

    return {
        "allowed": not issues,
        "blocking": bool(issues),
        "code": "channel_config_semantic_mismatch" if issues else "channel_config_semantic_ok",
        "message": "频道配置存在明显语义错配" if issues else "频道配置语义检查通过",
        "issues": issues,
    }


def validate_channel_semantics(channel: Any) -> None:
    result = channel_semantic_gate(channel)
    if result["blocking"]:
        raise ValueError(result)
