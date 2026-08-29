"""Pre-generation storyboard planning and content-level quality gates."""

from __future__ import annotations

import re
from typing import Any, Callable, Literal

from loguru import logger
from pydantic import BaseModel, Field

from pixelle_video.utils.content_generators import (
    generate_image_prompts,
    generate_narrations_from_topic,
    generate_title,
    split_narration_script,
)
from pixelle_video.utils.prompt_helper import build_image_prompt
from pixelle_video.utils.scene_direction import direct_storyboard_scenes


class AuditIssue(BaseModel):
    scene: int | None = None
    severity: Literal["warn", "fail"] = "warn"
    problem: str
    suggestion: str


class LLMAudit(BaseModel):
    status: Literal["pass", "warn", "fail"]
    summary: str
    issues: list[AuditIssue] = Field(default_factory=list)


_CONTENT_REVIEW_MAX_TOKENS = 3_000


def recommend_custom_script_scene_count(text: str) -> int:
    """Preview the natural scene count; the planner remains free to create any count."""
    return max(1, len(_split_custom_script_scenes(text)))


def describe_custom_script_scene_count(text: str, scenes: int) -> str:
    compact_length = len(re.sub(r"\s+", "", text or ""))
    return (
        f"按当前文案 {compact_length} 字符预估约 {scenes} 镜；"
        "创建分镜时将按语义和口播节奏自主拆分，不设置数量上限"
    )


async def plan_storyboard(
    request: dict[str, Any],
    llm: Any,
    content_policy: str = "general",
    llm_review: bool = True,
    progress_callback: Callable[[int, int, str], None] | None = None,
) -> dict[str, Any]:
    """Create a reusable storyboard without invoking TTS or media generation."""
    text = str(request.get("text") or "").strip()
    if not text:
        raise ValueError("Storyboard planning requires non-empty text")
    limit_scenes = bool(request.get("limit_scenes", True))
    n_scenes = int(request.get("n_scenes") or 5) if limit_scenes else None
    mode = request.get("mode") or "generate"

    def progress(current: int, message: str) -> None:
        if progress_callback:
            progress_callback(current, 7, message)

    progress(1, "正在生成视频标题")
    title = str(request.get("title") or "").strip() or await generate_title(
        llm, text, strategy="auto"
    )
    progress(
        2,
        "正在按语义和口播节奏自主拆分分镜"
        if request.get("custom_script")
        else f"正在生成 {n_scenes} 个分镜旁白" if limit_scenes else "正在让 AI 按语义自主决定分镜数量",
    )
    if request.get("narrations"):
        narrations = [str(item).strip() for item in request["narrations"] if str(item).strip()]
    elif mode == "fixed":
        if request.get("custom_script"):
            narrations = _split_custom_script_scenes(text)
        else:
            narrations = await split_narration_script(
                text, split_mode=request.get("split_mode") or "paragraph"
            )
    else:
        narrations = await generate_narrations_from_topic(
            llm,
            topic=text,
            n_scenes=n_scenes,
            min_words=int(request.get("min_narration_words") or 5),
            max_words=int(request.get("max_narration_words") or 20),
        )
    if not narrations:
        raise ValueError("Storyboard planning produced no narration scenes")

    progress(3, f"正在生成 {len(narrations)} 个画面提示词")
    if request.get("image_prompts"):
        prompts = [str(item).strip() for item in request["image_prompts"]]
    else:
        prompts = await generate_image_prompts(
            llm,
            narrations=narrations,
            min_words=int(request.get("min_image_prompt_words") or 30),
            max_words=int(request.get("max_image_prompt_words") or 60),
        )
        prefix = str(request.get("prompt_prefix") or "")
        prompts = [build_image_prompt(prompt, prefix) for prompt in prompts]
    if len(prompts) != len(narrations):
        raise ValueError("Storyboard narration and visual prompt counts do not match")

    scenes = [
        {"position": index, "narration": narration, "visual_prompt": prompts[index]}
        for index, narration in enumerate(narrations)
    ]
    progress(4, "正在为每个分镜选择运镜与转场")
    scenes = direct_storyboard_scenes(
        scenes,
        strategy=str(request.get("scene_direction") or "auto"),
        motion_pool=request.get("motion_pool"),
        transition_pool=request.get("transition_pool"),
        default_motion=str(request.get("image_motion") or "ken_burns"),
        default_transition=str(request.get("transition") or "crossfade"),
        default_transition_duration=float(request.get("transition_duration") or 0.35),
    )
    progress(5, "正在执行内容规则检查")
    checks = inspect_storyboard_content(title, scenes, content_policy)
    if llm_review:
        progress(6, "正在进行 AI 事实与安全复核")
        checks.append(await _llm_content_review(llm, title, scenes, content_policy))
    progress(7, "分镜规划完成")
    return {
        "title": title,
        "scenes": scenes,
        "content_policy": content_policy,
        "content_checks": checks,
        "content_gate_status": _rollup(checks),
    }


def inspect_storyboard_content(
    title: str,
    scenes: list[dict[str, Any]],
    content_policy: str,
) -> list[dict[str, Any]]:
    """Run deterministic checks that remain auditable after LLM planning."""
    script = "\n".join(str(scene.get("narration") or "") for scene in scenes)
    checks: list[dict[str, Any]] = []
    empty = [scene["position"] + 1 for scene in scenes if not str(scene.get("narration") or "").strip()]
    checks.append(
        _check(
            "content_structure",
            "fail" if empty or not title.strip() else "pass",
            {"scenes": len(scenes), "empty_scenes": empty, "title": title},
        )
    )

    prohibited = [
        term
        for term in ("百分百有效", "保证治愈", "彻底根治", "立刻痊愈", "绝对不会")
        if term in script
    ]
    checks.append(
        _check(
            "content_prohibited_claims",
            "fail" if prohibited else "pass",
            {"matches": prohibited},
        )
    )

    if content_policy == "psychology":
        patterns = (
            r"你(?:就是|一定是).{0,8}(?:症|障碍|患者)",
            r"说明你有.{0,8}(?:症|障碍)",
            r"再不.{0,12}就会",
        )
        matches = sorted({match.group(0) for pattern in patterns for match in re.finditer(pattern, script)})
        checks.append(
            _check(
                "content_psychology_language",
                "fail" if matches else "pass",
                {"matches": matches, "rule": "避免诊断化、恐吓式表达"},
            )
        )
        action_words = ("可以", "试着", "尝试", "先", "记录", "呼吸", "求助")
        has_action = any(word in script for word in action_words)
        checks.append(
            _check(
                "content_actionable_advice",
                "pass" if has_action else "warn",
                {"has_action": has_action, "expected": "至少一个低风险、可执行的小行动"},
            )
        )
    elif content_policy == "science":
        speculation_markers = ("可能", "推测", "证据", "研究", "目前", "尚不确定")
        has_marker = any(word in script for word in speculation_markers)
        checks.append(
            _check(
                "content_fact_boundaries",
                "pass" if has_marker else "warn",
                {"has_boundary_language": has_marker, "markers": list(speculation_markers)},
            )
        )
    return checks


def _split_custom_script_scenes(text: str) -> list[str]:
    """Split fixed copy on natural boundaries without forcing it into a target count."""
    cleaned = re.sub(r"\s+", " ", text or "").strip()
    if not cleaned:
        return []
    sentences = [
        item.strip()
        for item in re.split(r"(?<=[。.!?！？])\s*", cleaned)
        if item.strip()
    ]
    units: list[str] = []
    for sentence in sentences:
        clauses = [
            item
            for item in re.split(r"(?<=[，,；;：:、])", sentence)
            if item
        ]
        current = ""
        for clause in clauses:
            if current and len(current) + len(clause) > 72:
                units.append(current)
                current = ""
            while len(clause) > 72:
                head, clause = clause[:72], clause[72:]
                if current:
                    units.append(current)
                    current = ""
                units.append(head)
            current += clause
        if current:
            units.append(current)

    scenes: list[str] = []
    current = ""
    for unit in units:
        if not current:
            current = unit
        elif len(current) < 32 and len(current) + len(unit) <= 72:
            current += unit
        else:
            scenes.append(current)
            current = unit
    if current:
        if scenes and len(current) < 18 and len(scenes[-1]) + len(current) <= 72:
            scenes[-1] += current
        else:
            scenes.append(current)
    return scenes


async def audit_storyboard_content(
    llm: Any,
    title: str,
    scenes: list[dict[str, Any]],
    content_policy: str,
    llm_options: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    """Run deterministic checks and a fresh LLM review for an edited storyboard."""
    checks = inspect_storyboard_content(title, scenes, content_policy)
    checks.append(
        await _llm_content_review(
            llm,
            title,
            scenes,
            content_policy,
            llm_options=llm_options,
        )
    )
    return checks


def rollup_content_checks(checks: list[dict[str, Any]]) -> str:
    """Expose the same content-gate rollup used by initial planning."""
    return _rollup(checks)


async def _llm_content_review(
    llm: Any,
    title: str,
    scenes: list[dict[str, Any]],
    policy: str,
    llm_options: dict[str, Any] | None = None,
) -> dict[str, Any]:
    policy_instruction = {
        "science": "核查事实错误、因果倒置、数值或尺度错误，并确认事实与推测被清楚区分。",
        "psychology": "核查医学诊断化、贴标签、恐吓、过度承诺，以及可能伤害用户的行动建议。",
        "general": "核查明显事实错误、危险建议、过度承诺和误导性表述。",
    }.get(policy, "核查明显事实错误和危险建议。")
    script = "\n".join(
        f"镜头 {scene['position'] + 1}: {scene['narration']}" for scene in scenes
    )
    prompt = (
        "你是短视频内容安全与事实审校员。只指出能够具体定位的问题，不因风格偏好扣分。"
        f"\n审校要求：{policy_instruction}\n标题：{title}\n{script}"
    )
    route = _llm_route_info(llm)
    try:
        request_options = dict(llm_options or {})
        request_options.setdefault("reasoning_effort", "none")
        audit = await llm(
            prompt=prompt,
            temperature=0.1,
            max_tokens=_CONTENT_REVIEW_MAX_TOKENS,
            response_type=LLMAudit,
            **request_options,
        )
        return _check(
            "content_llm_review",
            audit.status,
            {
                "policy": policy,
                "summary": audit.summary,
                "issues": [issue.model_dump() for issue in audit.issues],
                "model_route": route,
            },
        )
    except Exception as exc:
        logger.warning("Content LLM review unavailable: {}", exc)
        return _check(
            "content_llm_review",
            "warn",
            {
                "policy": policy,
                "summary": "设置页文字模型内容复核暂不可用",
                "error": str(exc),
                "error_type": type(exc).__name__,
                "model_route": route,
            },
        )


def _llm_route_info(llm: Any) -> dict[str, str]:
    resolver = getattr(llm, "route_info", None)
    if not callable(resolver):
        return {}
    try:
        value = resolver()
    except Exception:
        return {}
    return value if isinstance(value, dict) else {}


def _check(name: str, status: str, detail: dict[str, Any]) -> dict[str, Any]:
    return {"name": name, "status": status, "detail": detail}


def _rollup(checks: list[dict[str, Any]]) -> str:
    statuses = {check["status"] for check in checks}
    if "fail" in statuses:
        return "fail"
    if "warn" in statuses:
        return "warn"
    return "pass"
