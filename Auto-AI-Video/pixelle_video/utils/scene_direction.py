"""Deterministic scene-level camera and transition direction."""

from __future__ import annotations

import hashlib
from typing import Any, Iterable

IMAGE_MOTIONS = (
    "none",
    "ken_burns",
    "push_in",
    "pull_out",
    "pan_left",
    "pan_right",
    "pan_up",
    "pan_down",
)
SCENE_TRANSITIONS = (
    "none",
    "crossfade",
    "dissolve",
    "slide_left",
    "slide_right",
    "wipe_up",
    "wipe_down",
    "circle_open",
    "zoom_in",
    "fade_black",
    "blur",
)
DEFAULT_MOTION_POOL = (
    "ken_burns",
    "push_in",
    "pull_out",
    "pan_left",
    "pan_right",
    "pan_up",
)
DEFAULT_TRANSITION_POOL = (
    "crossfade",
    "dissolve",
    "slide_left",
    "circle_open",
    "zoom_in",
    "blur",
)
TRANSITION_DURATIONS = {
    "none": 0.0,
    "crossfade": 0.55,
    "dissolve": 0.5,
    "slide_left": 0.38,
    "slide_right": 0.38,
    "wipe_up": 0.4,
    "wipe_down": 0.4,
    "circle_open": 0.5,
    "zoom_in": 0.32,
    "fade_black": 0.6,
    "blur": 0.55,
}
FFMPEG_TRANSITIONS = {
    "crossfade": "fade",
    "dissolve": "dissolve",
    "slide_left": "slideleft",
    "slide_right": "slideright",
    "wipe_up": "wipeup",
    "wipe_down": "wipedown",
    "circle_open": "circleopen",
    "zoom_in": "zoomin",
    "fade_black": "fadeblack",
    "blur": "hblur",
}


def normalize_motion_pool(values: Iterable[str] | None) -> list[str]:
    return _normalize_pool(values, IMAGE_MOTIONS, DEFAULT_MOTION_POOL, exclude="none")


def normalize_transition_pool(values: Iterable[str] | None) -> list[str]:
    return _normalize_pool(
        values,
        SCENE_TRANSITIONS,
        DEFAULT_TRANSITION_POOL,
        exclude="none",
    )


def direct_storyboard_scenes(
    scenes: list[dict[str, Any]],
    *,
    strategy: str = "auto",
    motion_pool: Iterable[str] | None = None,
    transition_pool: Iterable[str] | None = None,
    default_motion: str = "ken_burns",
    default_transition: str = "crossfade",
    default_transition_duration: float = 0.35,
) -> list[dict[str, Any]]:
    """Freeze one reproducible visual direction decision into every scene."""
    motions = normalize_motion_pool(motion_pool)
    transitions = normalize_transition_pool(transition_pool)
    directed: list[dict[str, Any]] = []
    for index, raw in enumerate(scenes):
        scene = dict(raw)
        if strategy == "fixed":
            motion = default_motion if default_motion in IMAGE_MOTIONS else "none"
            transition = (
                "none"
                if index == 0
                else default_transition
                if default_transition in SCENE_TRANSITIONS
                else "crossfade"
            )
            duration = (
                0.0
                if index == 0 or transition == "none"
                else float(default_transition_duration)
            )
            reason = "使用生产配方中的固定导演预设"
        else:
            text = " ".join(
                str(scene.get(key) or "")
                for key in ("narration", "visual_prompt")
            ).lower()
            motion, motion_reason = _select_motion(text, index, motions)
            transition, transition_reason = _select_transition(
                text,
                index,
                len(scenes),
                transitions,
            )
            duration = TRANSITION_DURATIONS[transition]
            reason = f"{motion_reason}；{transition_reason}"
        scene.update(
            image_motion=motion,
            transition=transition,
            transition_duration=round(duration, 3),
            direction_reason=reason,
        )
        directed.append(scene)
    return directed


def _select_motion(text: str, index: int, pool: list[str]) -> tuple[str, str]:
    rules = (
        (("人物", "肖像", "面部", "表情", "心理", "眼神", "portrait", "face"), ("push_in", "ken_burns"), "聚焦人物或情绪主体"),
        (("全景", "概览", "总结", "结尾", "远景", "overview", "wide shot"), ("pull_out", "ken_burns"), "从主体退至全貌"),
        (("山", "河", "海", "城市", "地平线", "横向", "landscape", "panorama"), (("pan_right" if index % 2 == 0 else "pan_left"), "ken_burns"), "横向浏览空间关系"),
        (("高塔", "树木", "向上", "上升", "天空", "vertical", "tower"), ("pan_up", "push_in"), "沿垂直结构向上揭示"),
        (("向下", "深处", "峡谷", "海底", "俯瞰", "downward", "depth"), ("pan_down", "pull_out"), "沿纵深方向向下探索"),
        (("细节", "微观", "局部", "关键", "重点", "detail", "close-up"), ("push_in", "ken_burns"), "推进强调关键细节"),
    )
    for keywords, preferences, reason in rules:
        if any(keyword in text for keyword in keywords):
            return _pick(preferences, pool, text, index), reason
    preferences = (
        ("ken_burns", "push_in")
        if index == 0
        else ("pull_out", "pan_left")
        if index % 4 == 3
        else ("pan_right", "pan_left", "ken_burns")
    )
    return _pick(preferences, pool, text, index), "按镜头位置保持平稳视觉节奏"


def _select_transition(
    text: str,
    index: int,
    total: int,
    pool: list[str],
) -> tuple[str, str]:
    if index == 0:
        return "none", "首镜直接建立画面"
    rules = (
        (("但是", "然而", "相反", "却", "转折", "but", "however"), ("slide_left", "slide_right"), "方向切换提示观点转折"),
        (("原来", "答案", "为什么", "揭示", "发现", "真相", "reveal"), ("circle_open", "zoom_in"), "聚焦式揭示承接关键信息"),
        (("历史", "过去", "后来", "多年", "演变", "曾经", "history", "time"), ("dissolve", "blur"), "柔和溶解表达时间变化"),
        (("向上", "上升", "增长", "天空", "up"), ("wipe_up", "slide_left"), "顺应画面向上的动势"),
        (("下降", "沉入", "向下", "down"), ("wipe_down", "dissolve"), "顺应画面向下的动势"),
        (("突然", "冲击", "爆发", "瞬间", "dramatic"), ("zoom_in", "slide_left"), "快速转场提升信息冲击"),
    )
    if index == total - 1 and any(word in text for word in ("最后", "总结", "结尾", "因此", "所以")):
        return _pick(("fade_black", "dissolve", "crossfade"), pool, text, index), "收束式转场进入结论"
    for keywords, preferences, reason in rules:
        if any(keyword in text for keyword in keywords):
            return _pick(preferences, pool, text, index), reason
    if index % 3:
        return _pick(("crossfade", "dissolve"), pool, text, index), "连续内容采用克制的主转场"
    return _pick(("slide_left", "blur", "crossfade"), pool, text, index), "段落边界使用轻量强调转场"


def _pick(
    preferences: Iterable[str],
    pool: list[str],
    text: str,
    index: int,
) -> str:
    for value in preferences:
        if value in pool:
            return value
    digest = hashlib.sha256(f"{index}:{text}".encode()).digest()
    return pool[digest[0] % len(pool)]


def _normalize_pool(
    values: Iterable[str] | None,
    supported: tuple[str, ...],
    defaults: tuple[str, ...],
    *,
    exclude: str,
) -> list[str]:
    cleaned = list(
        dict.fromkeys(
            str(value).strip()
            for value in (values or defaults)
            if str(value).strip() in supported and str(value).strip() != exclude
        )
    )
    return cleaned or [value for value in defaults if value in supported]
