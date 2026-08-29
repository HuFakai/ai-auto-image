"""Versioned whiteboard visual recipes derived from the cs-board template set."""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml


@dataclass(frozen=True)
class WhiteboardTemplate:
    template_id: str
    version: int
    name: str
    description: str
    recommended_for: tuple[str, ...]
    preview_path: Path
    prompt_recipe: str
    render_profile: dict[str, Any]
    fingerprint: str

    def public_metadata(self) -> dict[str, Any]:
        return {
            "template_id": self.template_id,
            "version": self.version,
            "display_name": self.name,
            "description": self.description,
            "recommended_for": list(self.recommended_for),
            "preview_url": (
                f"/api/resources/whiteboard/templates/{self.template_id}/versions/"
                f"{self.version}/preview"
            ),
            "render_profile": dict(self.render_profile),
            "fingerprint": self.fingerprint,
        }


class WhiteboardTemplateRegistry:
    """Load the immutable whiteboard registry without touching HTML template packs."""

    def __init__(self, repository_root: Path | None = None) -> None:
        self.repository_root = repository_root or Path(__file__).resolve().parents[2]
        self.registry_path = self.repository_root / "templates" / "whiteboard" / "registry.yaml"

    def list(self) -> list[WhiteboardTemplate]:
        payload = yaml.safe_load(self.registry_path.read_text(encoding="utf-8")) or {}
        if payload.get("schema_version") != 1:
            raise ValueError("Unsupported whiteboard template registry version")
        templates = [self._parse(item) for item in payload.get("templates") or []]
        keys = {(item.template_id, item.version) for item in templates}
        if len(keys) != len(templates):
            raise ValueError("Whiteboard template IDs and versions must be unique")
        return templates

    def load(self, template_id: str, version: int = 1) -> WhiteboardTemplate:
        for template in self.list():
            if template.template_id == template_id and template.version == version:
                return template
        raise FileNotFoundError(f"Unknown whiteboard template: {template_id}@{version}")

    def resolve(self, value: dict[str, Any] | None = None) -> dict[str, Any]:
        raw = dict(value or {})
        template_id = str(raw.get("template_id") or "minimal-whiteboard").strip()
        try:
            version = int(raw.get("template_version") or 1)
        except (TypeError, ValueError) as exc:
            raise ValueError("video.whiteboard.template_version must be an integer") from exc
        template = self.load(template_id, version)
        profile = dict(template.render_profile)
        profile.update(dict(raw.get("render_profile") or {}))
        path_mode = str(profile.get("path_mode") or "skeleton")
        if path_mode not in {"skeleton", "edge", "region", "grid"}:
            raise ValueError("video.whiteboard.render_profile.path_mode is unsupported")
        stroke_detail = str(profile.get("stroke_detail") or "standard")
        if stroke_detail not in {"light", "standard", "detailed", "full"}:
            raise ValueError("video.whiteboard.render_profile.stroke_detail is unsupported")
        hand_enabled = bool(raw.get("hand_enabled", True))
        fallback_policy = str(raw.get("fallback_policy") or "grid")
        if fallback_policy not in {"grid", "region", "fail"}:
            raise ValueError("video.whiteboard.fallback_policy must be grid, region, or fail")
        return {
            "template_id": template.template_id,
            "template_version": template.version,
            "template_fingerprint": template.fingerprint,
            "prompt_recipe": template.prompt_recipe,
            "render_profile": profile,
            "hand_enabled": hand_enabled,
            "hand_asset_id": str(raw.get("hand_asset_id") or "default"),
            "fallback_policy": fallback_policy,
        }

    def _parse(self, item: dict[str, Any]) -> WhiteboardTemplate:
        preview_path = (self.repository_root / str(item["preview"])).resolve()
        assets_root = (self.repository_root / "assets" / "whiteboard").resolve()
        if assets_root not in preview_path.parents or not preview_path.is_file():
            raise ValueError(f"Invalid whiteboard preview: {item.get('preview')}")
        canonical = json.dumps(item, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        fingerprint = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
        return WhiteboardTemplate(
            template_id=str(item["id"]),
            version=int(item["version"]),
            name=str(item["name"]),
            description=str(item["description"]),
            recommended_for=tuple(str(value) for value in item.get("recommended_for") or []),
            preview_path=preview_path,
            prompt_recipe=str(item["prompt_recipe"]).strip(),
            render_profile=dict(item.get("render_profile") or {}),
            fingerprint=fingerprint,
        )
