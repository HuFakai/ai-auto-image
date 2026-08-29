"""Frozen subtitle-effect contracts shared by renderers and API validation."""

from __future__ import annotations

import html
import re
from dataclasses import dataclass
from typing import Iterable

SUBTITLE_EFFECTS = ("static", "fade_up", "typewriter", "word_pop")


def normalize_subtitle_effect(value: object) -> str:
    """Return a supported effect id or fail before a task is queued."""

    effect = str(value or "static").strip().lower()
    if effect not in SUBTITLE_EFFECTS:
        raise ValueError(f"subtitle_effect must be one of {SUBTITLE_EFFECTS}")
    return effect


def normalize_subtitle_keywords(values: object, *, limit: int = 12) -> list[str]:
    """Normalize user-entered emphasis terms without changing their display text."""

    if values is None:
        return []
    if isinstance(values, str):
        values = re.split(r"[,，\n]", values)
    if not isinstance(values, Iterable):
        raise ValueError("subtitle_keywords must be a list of strings")
    result: list[str] = []
    seen: set[str] = set()
    for raw in values:
        keyword = str(raw).strip()
        key = keyword.casefold()
        if not keyword or key in seen:
            continue
        if len(keyword) > 40:
            raise ValueError("subtitle keyword must not exceed 40 characters")
        seen.add(key)
        result.append(keyword)
        if len(result) > limit:
            raise ValueError(f"subtitle_keywords must not contain more than {limit} items")
    return result


def normalize_subtitle_timing(
    duration: float,
    start_offset: object = 0,
    end_offset: object = 0,
) -> tuple[float, float]:
    """Validate and freeze scene-local subtitle visibility offsets."""

    start = round(max(float(start_offset or 0), 0), 3)
    end = round(max(float(end_offset or 0), 0), 3)
    duration = max(float(duration or 0), 0)
    if duration > 0 and start + end > max(duration - 0.1, 0):
        raise ValueError("subtitle timing must leave at least 0.1 seconds visible")
    return start, end


def highlight_subtitle_text(text: str, keywords: object) -> str:
    """Return escaped HTML with deterministic, inline native keyword emphasis."""

    normalized = normalize_subtitle_keywords(keywords)
    if not normalized:
        return html.escape(text)
    pattern = re.compile(
        "(" + "|".join(re.escape(item) for item in sorted(normalized, key=len, reverse=True)) + ")",
        flags=re.IGNORECASE,
    )
    matches = {item.casefold() for item in normalized}
    parts: list[str] = []
    for part in pattern.split(text):
        escaped = html.escape(part)
        if part.casefold() in matches:
            parts.append(
                '<mark class="pixelle-subtitle-keyword" '
                'style="color:#d7ff55;background:rgba(186,255,42,.16);'
                'padding:0 .12em;border-radius:.16em;font-weight:900">'
                f"{escaped}</mark>"
            )
        else:
            parts.append(escaped)
    return "".join(parts)


@dataclass(frozen=True)
class NativeSubtitleEffect:
    """Truthful native-renderer resolution for a requested effect."""

    requested: str
    applied: str
    fallback_reason: str | None = None


def resolve_native_subtitle_effect(value: object) -> NativeSubtitleEffect:
    """Resolve native support without silently pretending advanced effects exist."""

    requested = normalize_subtitle_effect(value)
    if requested in {"static", "fade_up"}:
        return NativeSubtitleEffect(requested=requested, applied=requested)
    return NativeSubtitleEffect(
        requested=requested,
        applied="fade_up",
        fallback_reason=(
            f"原生图片 + HTML 渲染器暂不支持 {requested} 的逐字时间轴，"
            "已确定性降级为 fade_up；HyperFrames 会保留原效果。"
        ),
    )
