"""Topic-inbox generation and deterministic explainable scoring."""

from __future__ import annotations

import hashlib
import math
import re
from typing import Any, Awaitable, Callable

from pydantic import BaseModel, Field

from .models import ChannelConfig


class TitleVariantSuggestion(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    angle: str = Field(default="clarity", max_length=40)
    hypothesis: str = Field(default="", max_length=300)


class TopicSuggestion(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    topic: str = Field(min_length=1, max_length=2000)
    cover_copy: str = Field(default="", max_length=120)
    platform_description: str = Field(default="", max_length=1000)
    tags: list[str] = Field(default_factory=list, max_length=12)
    semantic_terms: list[str] = Field(default_factory=list, max_length=16)
    title_variants: list[TitleVariantSuggestion] = Field(default_factory=list, max_length=6)


class TopicSuggestionBatch(BaseModel):
    items: list[TopicSuggestion] = Field(min_length=1, max_length=20)


async def propose_topics(
    channel: ChannelConfig,
    llm: Callable[..., Awaitable[Any]],
    count: int,
    history: list[str],
    source_text: str = "",
    topic_prompt: str = "",
) -> list[dict[str, Any]]:
    """Ask the configured LLM for a structured batch of production-ready topics."""
    recent = "\n".join(f"- {item}" for item in history[:50]) or "（暂无）"
    source = source_text.strip() or "（没有额外素材，请基于栏目定位策划）"
    prompt = topic_prompt.strip() or channel.topic.prompt.strip()
    prompt = prompt or f"为栏目《{channel.name}》策划短视频选题。"
    request = f"""你是批量短视频制片策划。请为下列栏目生成 {count} 个彼此不同、可以直接进入分镜制作的候选选题。

栏目：{channel.name}
栏目要求：{prompt}
内容策略：{channel.planning.content_policy}
额外素材或主题简报：
{source}

近期已生产选题，必须避免重复角度：
{recent}

每个候选必须包含：
1. title：准确而具体的短视频标题；
2. topic：供脚本生成使用的完整内容角度，包含核心事实、冲突或行动建议；
3. cover_copy：不超过 18 个汉字的封面文案；
4. platform_description：一段平台发布描述，不制造焦虑、不虚构事实；
5. tags：2 到 6 个不带井号的标签；
6. semantic_terms：5 到 10 个能表达题材、对象、机制和核心结论的语义概念词；
7. title_variants：3 到 4 个不同假设的备选标题，angle 使用 clarity、curiosity、contrast、action 之一，并说明 hypothesis。
不要输出医学诊断、绝对化承诺或无法核验的数据。"""
    result = await llm(
        prompt=request,
        temperature=0.9,
        max_tokens=4000,
        response_type=TopicSuggestionBatch,
    )
    return [item.model_dump() for item in result.items[:count]]


def score_topic(
    channel: ChannelConfig,
    title: str,
    topic: str,
    references: list[dict[str, Any]],
    semantic_terms: list[str] | None = None,
) -> dict[str, Any]:
    """Score a candidate with transparent heuristics and a duplicate reference."""
    text = f"{title} {topic}".strip()
    tokens = _tokens(text)
    vector = semantic_vector(text, semantic_terms or [])
    candidate_layers = _topic_layers(title, topic, semantic_terms or [])
    closest: dict[str, str] | None = None
    closest_similarity = 0.0
    closest_lexical = 0.0
    closest_semantic = 0.0
    closest_layers: dict[str, float] = {"core_conclusion": 0.0, "narrative_angle": 0.0, "case": 0.0}
    for reference in references:
        lexical = _jaccard(tokens, _tokens(reference["topic"]))
        reference_vector = reference.get("semantic_vector") or semantic_vector(
            reference["topic"], reference.get("semantic_terms") or []
        )
        semantic = cosine_similarity(vector, reference_vector)
        reference_layers = _topic_layers(
            str(reference.get("title") or ""),
            reference["topic"],
            reference.get("semantic_terms") or [],
        )
        layer_scores = {
            layer: _layer_similarity(candidate_layers[layer], reference_layers[layer])
            for layer in candidate_layers
        }
        similarity = max(lexical, semantic)
        # A topic is materially duplicated only when the conclusion and the
        # explanatory angle overlap. Same subject with a new angle/case remains
        # available for editorial review.
        material_similarity = min(
            layer_scores["core_conclusion"],
            max(layer_scores["narrative_angle"], layer_scores["case"]),
        )
        ranking_similarity = max(similarity, material_similarity)
        if ranking_similarity > closest_similarity:
            closest = reference
            closest_similarity = ranking_similarity
            closest_lexical = lexical
            closest_semantic = semantic
            closest_layers = layer_scores

    novelty = round(max(0.0, 100.0 * (1.0 - closest_similarity)))
    length = len(topic.strip())
    concrete_markers = len(re.findall(r"[0-9一二三四五六七八九十]|为什么|如何|步骤|方法|分钟|秒|场景|例如", text))
    specificity = min(100, round(48 + min(length, 180) / 4 + min(concrete_markers, 4) * 6))

    risky = re.findall(r"一定|绝对|保证|治愈|根治|你就是|百分之百|立刻见效", text)
    boundary = re.findall(r"可能|通常|研究|证据|目前|因人而异|建议", text)
    credibility = min(100, max(0, 78 - len(risky) * 18 + min(len(boundary), 3) * 5))

    channel_terms = _tokens(
        " ".join([channel.name, channel.topic.prompt, *channel.topic.seeds[:10]])
    )
    overlap = _jaccard(tokens, channel_terms)
    policy_bonus = 0
    if channel.planning.content_policy == "science" and re.search(r"为什么|原理|研究|证据|实验", text):
        policy_bonus = 12
    elif channel.planning.content_policy == "psychology" and re.search(r"情绪|关系|沟通|行动|内耗|边界|自尊", text):
        policy_bonus = 12
    channel_fit = min(100, round(70 + overlap * 45 + policy_bonus))
    overall = round(novelty * 0.32 + specificity * 0.24 + credibility * 0.22 + channel_fit * 0.22)

    duplicate_of = None
    if closest is not None and (
        closest_layers["core_conclusion"] >= 0.78
        and max(closest_layers["narrative_angle"], closest_layers["case"]) >= 0.62
        or closest_lexical >= 0.86
    ):
        duplicate_of = closest["id"]
    most_similar_history = None
    if closest is not None:
        most_similar_history = {
            "id": closest["id"],
            "topic": closest.get("topic", ""),
            "reason": (
                "核心结论、叙事角度或案例高度重合"
                if duplicate_of
                else "同主题但分层角度/案例存在差异，保留人工判断"
            ),
            "layer_scores": {
                key: round(value * 100) for key, value in closest_layers.items()
            },
        }
    return {
        "scores": {
            "overall": overall,
            "novelty": novelty,
            "semantic_similarity": round(closest_semantic * 100),
            "lexical_similarity": round(closest_lexical * 100),
            "specificity": specificity,
            "credibility": credibility,
            "channel_fit": channel_fit,
            "similarity_layers": {
                key: round(value * 100) for key, value in closest_layers.items()
            },
        },
        "reasons": {
            "novelty": (
                f"最近内容：语义向量 {round(closest_semantic * 100)}%，字面 {round(closest_lexical * 100)}%"
                if closest is not None
                else "尚无历史内容，可视为新角度"
            ),
            "specificity": f"主题正文 {length} 字，检测到 {concrete_markers} 个具体化线索",
            "credibility": (
                f"发现 {len(risky)} 个绝对化风险词、{len(boundary)} 个边界表达"
            ),
            "channel_fit": f"与栏目语义线索重合度 {round(overlap * 100)}%",
            "most_similar_history": most_similar_history,
        },
        "duplicate_of": duplicate_of,
        "fingerprint": topic_fingerprint(text),
        "semantic_terms": _clean_semantic_terms(semantic_terms or []),
        "semantic_vector": vector,
    }


_ANGLE_MARKERS = {
    "why": ("为什么", "为何", "原理", "机制", "原因", "how does", "why"),
    "action": ("如何", "怎么", "步骤", "方法", "清单", "how to", "tips"),
    "myth": ("误区", "误解", "谣言", "真的", "是不是", "myth", "misconception"),
    "comparison": ("区别", "对比", "比较", "前后", "vs", "versus"),
    "case": ("案例", "故事", "场景", "一个人", "例如", "case", "story"),
    "impact": ("影响", "后果", "结果", "改变", "impact", "effect"),
}
_CASE_MARKERS = (
    "案例", "故事", "场景", "例如", "某人", "一位", "用户", "患者", "case", "story",
)


def _topic_layers(title: str, topic: str, semantic_terms: list[str]) -> dict[str, str]:
    """Extract stable coarse layers without using an LLM."""
    text = f"{title} {topic}".strip()
    lower = text.casefold()
    angles = [
        angle for angle, markers in _ANGLE_MARKERS.items()
        if any(marker.casefold() in lower for marker in markers)
    ] or ["explanation"]
    case_fragments = [
        term for term in semantic_terms
        if any(marker.casefold() in str(term).casefold() for marker in _CASE_MARKERS)
    ]
    # Keep concrete entities/numbers in the case layer, while excluding generic
    # angle words so a new example is not mistaken for a new conclusion.
    case_tokens = re.findall(
        r"(?:[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*|\d+(?:\.\d+)?|第[一二三四五六七八九十]+[章节]|[“「][^”」]+[”」])",
        text,
    )
    case = " ".join(case_fragments + case_tokens) or "generic-case"
    conclusion_terms = [
        term for term in _clean_semantic_terms(semantic_terms)
        if not any(marker.casefold() in term for marker in _CASE_MARKERS)
    ]
    conclusion = " ".join(conclusion_terms) or _conclusion_text(text)
    return {
        "core_conclusion": conclusion,
        "narrative_angle": " ".join(angles),
        "case": case,
    }


def _conclusion_text(text: str) -> str:
    cleaned = re.sub(r"为什么|为何|如何|怎么|原理|机制|误区|案例|故事|例如", " ", text)
    return re.sub(r"\s+", " ", cleaned).strip() or text


def _layer_similarity(left: str, right: str) -> float:
    if left == right and left:
        return 1.0
    lexical = _jaccard(_tokens(left), _tokens(right))
    semantic = cosine_similarity(semantic_vector(left), semantic_vector(right))
    return max(lexical, semantic)


def prepare_title_variants(
    title: str,
    variants: list[dict[str, Any]] | None = None,
) -> list[dict[str, Any]]:
    """Build a stable control/variant set without trusting model-provided IDs."""
    prepared = [
        {
            "id": "control",
            "title": title.strip(),
            "angle": "control",
            "hypothesis": "原始策划标题，作为对照组",
            "selected": True,
        }
    ]
    seen = {title.strip().lower()}
    for index, item in enumerate(variants or [], start=1):
        candidate = str(item.get("title") or "").strip()
        if not candidate or candidate.lower() in seen:
            continue
        seen.add(candidate.lower())
        prepared.append(
            {
                "id": f"variant-{index}",
                "title": candidate[:200],
                "angle": str(item.get("angle") or "clarity")[:40],
                "hypothesis": str(item.get("hypothesis") or "")[:300],
                "selected": False,
            }
        )
    return prepared[:7]


def semantic_vector(
    text: str,
    semantic_terms: list[str] | None = None,
    dimensions: int = 384,
) -> list[float]:
    """Create a deterministic normalized hashing vector enriched by LLM concepts."""
    values = [0.0] * dimensions
    features: list[tuple[str, float]] = []
    features.extend((token, 1.0) for token in _tokens(text))
    features.extend((f"concept:{term}", 8.0) for term in _clean_semantic_terms(semantic_terms or []))
    for feature, weight in features:
        digest = hashlib.blake2b(feature.encode("utf-8"), digest_size=8).digest()
        index = int.from_bytes(digest[:4], "big") % dimensions
        sign = 1.0 if digest[4] & 1 else -1.0
        values[index] += sign * weight
    norm = math.sqrt(sum(value * value for value in values))
    if norm:
        values = [round(value / norm, 6) for value in values]
    return values


def cosine_similarity(left: list[float], right: list[float]) -> float:
    if not left or not right or len(left) != len(right):
        return 0.0
    similarity = sum(a * b for a, b in zip(left, right, strict=True))
    return max(0.0, min(1.0, similarity))


def topic_fingerprint(value: str) -> str:
    normalized = re.sub(r"[^a-z0-9\u4e00-\u9fff]+", "", value.lower())
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()


def _tokens(value: str) -> set[str]:
    normalized = re.sub(r"[^a-z0-9\u4e00-\u9fff]+", "", value.lower())
    if not normalized:
        return set()
    if len(normalized) == 1:
        return {normalized}
    return {normalized[index : index + 2] for index in range(len(normalized) - 1)}


def _clean_semantic_terms(values: list[str]) -> list[str]:
    cleaned: list[str] = []
    seen: set[str] = set()
    for value in values:
        term = re.sub(r"\s+", " ", str(value)).strip().lower()
        if term and term not in seen:
            seen.add(term)
            cleaned.append(term[:80])
    return cleaned[:16]


def _jaccard(left: set[str], right: set[str]) -> float:
    if not left or not right:
        return 0.0
    return len(left & right) / len(left | right)
