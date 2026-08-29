"""Versioned template packs shared by native HTML and HyperFrames rendering."""

from __future__ import annotations

import base64
import hashlib
import html
import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

_IDENTIFIER = re.compile(r"^[a-z0-9][a-z0-9-]{1,63}$")
_COLOR = re.compile(r"^#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?$")
_TEMPLATE_TOKEN = re.compile(
    r"\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)(?::[a-zA-Z_]+(?:=([^}]*))?)?\s*\}\}"
)
_VIEWPORT_SIZE = re.compile(
    r'<meta\s+name=["\']viewport["\']\s+content=["\'][^"\']*'
    r"width\s*=\s*(\d+)[^\"']*height\s*=\s*(\d+)",
    re.IGNORECASE,
)
_PREVIEW_CSP = (
    "default-src 'none'; img-src data:; style-src 'unsafe-inline'; "
    "font-src 'none'; media-src data:; connect-src 'none'; frame-src 'none'; "
    "object-src 'none'; base-uri 'none'; form-action 'none'"
)


@dataclass(frozen=True)
class TemplateVariable:
    name: str
    type: str
    label: str
    default: Any
    minimum: float | None = None
    maximum: float | None = None
    max_length: int = 120
    choices: tuple[str, ...] = ()


@dataclass(frozen=True)
class TemplatePack:
    template_id: str
    version: int
    display_name: str
    category: str
    native_template: str
    variables: dict[str, TemplateVariable]
    css: str
    design: str
    manifest: dict[str, Any]
    repository_root: Path
    source_dir: Path
    fingerprint: str
    preview_html: str
    preview_width: int
    preview_height: int

    def resolve_variables(self, overrides: dict[str, Any] | None = None) -> dict[str, Any]:
        overrides = dict(overrides or {})
        unknown = sorted(set(overrides) - set(self.variables))
        if unknown:
            raise ValueError(
                f"Unknown variables for {self.template_id}@{self.version}: "
                + ", ".join(unknown)
            )
        return {
            name: _coerce_variable(definition, overrides.get(name, definition.default))
            for name, definition in self.variables.items()
        }

    def public_metadata(self) -> dict[str, Any]:
        return {
            "template_id": self.template_id,
            "version": self.version,
            "display_name": self.display_name,
            "category": self.category,
            "native_template": self.native_template,
            "fingerprint": self.fingerprint,
            "preview_html": self.preview_html,
            "preview_width": self.preview_width,
            "preview_height": self.preview_height,
            "variables": {
                name: {
                    "type": item.type,
                    "label": item.label,
                    "default": item.default,
                    **({"min": item.minimum} if item.minimum is not None else {}),
                    **({"max": item.maximum} if item.maximum is not None else {}),
                    **({"choices": list(item.choices)} if item.choices else {}),
                }
                for name, item in self.variables.items()
            },
        }

    def render_preview(self, overrides: dict[str, Any] | None = None) -> dict[str, Any]:
        """Render a safe, self-contained preview using validated live variables."""
        variables = self.resolve_variables(overrides)
        native_html = (self.repository_root / "templates" / self.native_template).read_text(
            encoding="utf-8"
        )
        return {
            "template_id": self.template_id,
            "version": self.version,
            "fingerprint": self.fingerprint,
            "variables": variables,
            "preview_html": _build_preview_html(
                native_html,
                variables,
                category=self.category,
            ),
            "preview_width": self.preview_width,
            "preview_height": self.preview_height,
        }


class TemplatePackRegistry:
    """Discover immutable template versions from ``templates/hyperframes``."""

    def __init__(self, repository_root: str | Path | None = None):
        root = (
            Path(repository_root).expanduser().resolve()
            if repository_root
            else Path(__file__).resolve().parents[2]
        )
        self.repository_root = root
        self.root = root / "templates" / "hyperframes"

    def list(self) -> list[TemplatePack]:
        if not self.root.is_dir():
            return []
        packs: list[TemplatePack] = []
        for manifest in sorted(self.root.glob("*/v*/manifest.json")):
            relative = manifest.relative_to(self.root)
            template_id = relative.parts[0]
            version_part = relative.parts[1]
            if version_part.startswith("v") and version_part[1:].isdigit():
                packs.append(self.load(template_id, int(version_part[1:])))
        return packs

    def load(self, template_id: str, version: int = 1) -> TemplatePack:
        if not _IDENTIFIER.fullmatch(template_id):
            raise ValueError(f"Invalid template id: {template_id}")
        if not isinstance(version, int) or version < 1:
            raise ValueError("Template version must be a positive integer")
        source_dir = (self.root / template_id / f"v{version}").resolve()
        try:
            source_dir.relative_to(self.root.resolve())
        except ValueError as exc:
            raise ValueError("Template path escapes the registry root") from exc
        manifest_path = source_dir / "manifest.json"
        css_path = source_dir / "scene.css"
        design_path = source_dir / "DESIGN.md"
        for required in (manifest_path, css_path, design_path):
            if not required.is_file():
                raise FileNotFoundError(
                    f"Template pack {template_id}@{version} is missing {required.name}"
                )

        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        if manifest.get("schema_version") != 1:
            raise ValueError(f"Unsupported template manifest schema: {manifest.get('schema_version')}")
        if manifest.get("template_id") != template_id or manifest.get("version") != version:
            raise ValueError(f"Template manifest identity mismatch for {template_id}@{version}")
        native_template = str(manifest.get("native_template") or "")
        native_path = (self.repository_root / "templates" / native_template).resolve()
        try:
            native_path.relative_to((self.repository_root / "templates").resolve())
        except ValueError as exc:
            raise ValueError("Native template path escapes templates root") from exc
        if not native_path.is_file():
            raise FileNotFoundError(f"Native template is missing: {native_template}")

        raw_variables = manifest.get("variables") or {}
        if not isinstance(raw_variables, dict):
            raise ValueError("Template variables must be an object")
        variables: dict[str, TemplateVariable] = {}
        for name, raw in raw_variables.items():
            if not re.fullmatch(r"[a-z][a-z0-9_]{1,63}", name) or not isinstance(raw, dict):
                raise ValueError(f"Invalid template variable declaration: {name}")
            variable_type = str(raw.get("type") or "text")
            if variable_type not in {"text", "color", "number", "bool", "choice"}:
                raise ValueError(f"Unsupported variable type for {name}: {variable_type}")
            variables[name] = TemplateVariable(
                name=name,
                type=variable_type,
                label=str(raw.get("label") or name),
                default=raw.get("default"),
                minimum=float(raw["min"]) if raw.get("min") is not None else None,
                maximum=float(raw["max"]) if raw.get("max") is not None else None,
                max_length=int(raw.get("max_length") or 120),
                choices=tuple(str(item) for item in raw.get("choices") or ()),
            )

        fingerprint = hashlib.sha256()
        for path in (manifest_path, css_path, design_path, native_path):
            fingerprint.update(str(path.relative_to(self.repository_root)).encode("utf-8"))
            fingerprint.update(b"\0")
            fingerprint.update(path.read_bytes())
            fingerprint.update(b"\0")
        native_html = native_path.read_text(encoding="utf-8")
        resolved_variables = {
            name: _coerce_variable(definition, definition.default)
            for name, definition in variables.items()
        }
        preview_width, preview_height = _preview_dimensions(native_template, native_html)
        preview_html = _build_preview_html(
            native_html,
            resolved_variables,
            category=str(manifest.get("category") or "general"),
        )
        pack = TemplatePack(
            template_id=template_id,
            version=version,
            display_name=str(manifest.get("display_name") or template_id),
            category=str(manifest.get("category") or "general"),
            native_template=native_template,
            variables=variables,
            css=css_path.read_text(encoding="utf-8"),
            design=design_path.read_text(encoding="utf-8"),
            manifest=manifest,
            repository_root=self.repository_root,
            source_dir=source_dir,
            fingerprint=fingerprint.hexdigest(),
            preview_html=preview_html,
            preview_width=preview_width,
            preview_height=preview_height,
        )
        pack.resolve_variables()
        return pack


def _coerce_variable(definition: TemplateVariable, value: Any) -> Any:
    if definition.type == "bool":
        if isinstance(value, bool):
            return value
        if isinstance(value, str) and value.lower() in {"true", "false"}:
            return value.lower() == "true"
        raise ValueError(f"{definition.name} must be a boolean")
    if definition.type == "number":
        if isinstance(value, bool):
            raise ValueError(f"{definition.name} must be a number")
        try:
            number = float(value)
        except (TypeError, ValueError) as exc:
            raise ValueError(f"{definition.name} must be a number") from exc
        if definition.minimum is not None and number < definition.minimum:
            raise ValueError(f"{definition.name} must be >= {definition.minimum:g}")
        if definition.maximum is not None and number > definition.maximum:
            raise ValueError(f"{definition.name} must be <= {definition.maximum:g}")
        return number
    text = str(value if value is not None else "").strip()
    if definition.type == "color" and not _COLOR.fullmatch(text):
        raise ValueError(f"{definition.name} must be a #RRGGBB or #RRGGBBAA color")
    if definition.type == "choice" and text not in definition.choices:
        raise ValueError(
            f"{definition.name} must be one of: {', '.join(definition.choices)}"
        )
    if len(text) > definition.max_length:
        raise ValueError(f"{definition.name} exceeds {definition.max_length} characters")
    return text


def _preview_dimensions(native_template: str, document: str) -> tuple[int, int]:
    viewport = _VIEWPORT_SIZE.search(document)
    if viewport:
        return int(viewport.group(1)), int(viewport.group(2))
    size = re.search(r"(?:^|/)(\d{2,5})x(\d{2,5})(?:/|$)", native_template)
    if size:
        return int(size.group(1)), int(size.group(2))
    return 1080, 1920


def _build_preview_html(
    document: str,
    variables: dict[str, Any],
    *,
    category: str,
) -> str:
    """Render a self-contained, inert preview from a trusted local template."""
    sample_title, sample_text = _preview_copy(category)
    replacements: dict[str, Any] = {
        **variables,
        "image": _preview_image_data_uri(category, variables),
        "title": sample_title,
        "text": sample_text,
        "index": "01",
        "progress_percent": 62,
    }

    def replace_token(match: re.Match[str]) -> str:
        name = match.group(1)
        fallback = (match.group(2) or "").strip()
        value = replacements.get(name, fallback)
        return html.escape(str(value if value is not None else ""), quote=True)

    rendered = _TEMPLATE_TOKEN.sub(replace_token, document)
    return _sanitize_preview_document(rendered)


def _preview_copy(category: str) -> tuple[str, str]:
    samples = {
        "psychology": (
            "为什么越想控制情绪，反而越容易焦虑？",
            "先看见情绪，再决定如何回应。给自己十秒钟，也是在找回主动权。",
        ),
        "lifestyle": (
            "早安，今天也从一件小事开始",
            "不必急着追赶所有答案。把此刻做好，清晨就会慢慢打开新的可能。",
        ),
        "knowledge": (
            "一分钟看懂：海水为什么是蓝色？",
            "阳光进入海水后，红光更容易被吸收，蓝光则更容易散射到我们眼中。",
        ),
    }
    return samples.get(
        category,
        ("画面模板实际效果", "这里展示标题、主体图片、字幕卡与栏目角标的真实排版关系。"),
    )


def _preview_image_data_uri(category: str, variables: dict[str, Any]) -> str:
    accent = str(variables.get("accent_color") or "#BFFF3C")
    surface = str(variables.get("surface_color") or "#101612")
    motif = {
        "psychology": "思绪与情绪",
        "lifestyle": "清晨与日光",
        "knowledge": "自然与知识",
    }.get(category, "视觉样片")
    svg = f"""<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1536" viewBox="0 0 1024 1536">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop stop-color="{surface}"/><stop offset="1" stop-color="{accent}"/></linearGradient><radialGradient id="r"><stop stop-color="#ffffff" stop-opacity=".72"/><stop offset="1" stop-color="#ffffff" stop-opacity="0"/></radialGradient></defs>
<rect width="1024" height="1536" fill="url(#g)"/><circle cx="790" cy="350" r="330" fill="url(#r)"/><path d="M0 1140 C240 980 370 1220 580 1040 S850 860 1024 960 V1536 H0Z" fill="#07110d" fill-opacity=".48"/><path d="M0 1240 C260 1100 460 1380 720 1160 S930 1040 1024 1100 V1536 H0Z" fill="#ffffff" fill-opacity=".13"/><text x="72" y="1390" fill="#ffffff" fill-opacity=".78" font-family="sans-serif" font-size="38" letter-spacing="8">{html.escape(motif)}</text>
</svg>"""
    encoded = base64.b64encode(svg.encode("utf-8")).decode("ascii")
    return f"data:image/svg+xml;base64,{encoded}"


def _sanitize_preview_document(document: str) -> str:
    # Template packs are local and reviewed, while the extra restrictions keep previews
    # inert even if a future template accidentally contains active or remote content.
    for tag in ("script", "iframe", "object", "embed", "link", "base", "form"):
        document = re.sub(
            rf"<\s*{tag}\b[^>]*>.*?<\s*/\s*{tag}\s*>",
            "",
            document,
            flags=re.IGNORECASE | re.DOTALL,
        )
        document = re.sub(
            rf"<\s*{tag}\b[^>]*?/?>",
            "",
            document,
            flags=re.IGNORECASE | re.DOTALL,
        )
    document = re.sub(
        r"\s+on[a-z0-9_-]+\s*=\s*(?:\"[^\"]*\"|'[^']*'|[^\s>]+)",
        "",
        document,
        flags=re.IGNORECASE,
    )
    document = re.sub(
        r"\s+srcdoc\s*=\s*(?:\"[^\"]*\"|'[^']*'|[^\s>]+)",
        "",
        document,
        flags=re.IGNORECASE,
    )
    document = re.sub(
        r"(\s(?:src|href|poster)\s*=\s*)([\"'])(?:https?:)?//.*?\2",
        r"\1\2\2",
        document,
        flags=re.IGNORECASE | re.DOTALL,
    )
    document = re.sub(
        r"@import\s+(?:url\()?\s*[\"']?(?:https?:)?//[^;]+;?",
        "",
        document,
        flags=re.IGNORECASE,
    )
    document = re.sub(
        r"url\(\s*[\"']?(?:https?:)?//[^)]+\)",
        "none",
        document,
        flags=re.IGNORECASE,
    )
    security_meta = (
        f'<meta http-equiv="Content-Security-Policy" content="{_PREVIEW_CSP}">'
        '<meta name="referrer" content="no-referrer">'
    )
    if re.search(r"<head(?:\s[^>]*)?>", document, flags=re.IGNORECASE):
        return re.sub(
            r"(<head(?:\s[^>]*)?>)",
            rf"\1{security_meta}",
            document,
            count=1,
            flags=re.IGNORECASE,
        )
    return f"<!doctype html><html><head>{security_meta}</head><body>{document}</body></html>"
