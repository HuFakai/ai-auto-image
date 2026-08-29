"""Channel-level visual continuity memory and prompt formatting."""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, ConfigDict, Field, field_validator


class VisualMemory(BaseModel):
    """Stable visual constraints shared by generated images and covers."""

    model_config = ConfigDict(extra="forbid")

    characters: list[str] = Field(default_factory=list, max_length=24)
    palette: list[str] = Field(default_factory=list, max_length=24)
    composition: list[str] = Field(default_factory=list, max_length=24)
    forbidden_elements: list[str] = Field(default_factory=list, max_length=32)
    exemplars: list[str] = Field(default_factory=list, max_length=24)

    @field_validator(
        "characters", "palette", "composition", "forbidden_elements", "exemplars",
        mode="before",
    )
    @classmethod
    def clean_items(cls, value: Any) -> list[str]:
        if value is None:
            return []
        if isinstance(value, str):
            value = [value]
        if not isinstance(value, list):
            raise ValueError("visual_memory entries must be arrays of strings")
        return list(dict.fromkeys(
            str(item).strip() for item in value if str(item).strip()
        ))


def build_visual_memory_prompt(memory: VisualMemory | dict[str, Any] | None) -> str:
    """Format visual memory as deterministic, model-facing prompt text."""
    if not memory:
        return ""
    config = memory if isinstance(memory, VisualMemory) else VisualMemory.model_validate(memory)
    sections = [
        ("Recurring characters", config.characters),
        ("Palette", config.palette),
        ("Composition rules", config.composition),
        ("Reference exemplars", config.exemplars),
        ("Forbidden elements", config.forbidden_elements),
    ]
    lines = [
        "VISUAL MEMORY — preserve this channel identity across images and cover art:",
    ]
    for label, values in sections:
        if values:
            suffix = "; ".join(values)
            if label == "Forbidden elements":
                lines.append(f"- {label}: DO NOT USE {suffix}")
            else:
                lines.append(f"- {label}: {suffix}")
    return "\n".join(lines) if len(lines) > 1 else ""


def merge_visual_prompt(prefix: str | None, memory_prompt: str) -> str:
    """Append visual memory without disturbing an existing style prefix."""
    values = [str(value or "").strip() for value in (prefix, memory_prompt) if str(value or "").strip()]
    return "\n".join(values)
