"""Build a deterministic, task-owned HyperFrames project from a storyboard."""

from __future__ import annotations

import hashlib
import html
import json
import os
import re
import shutil
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from pixelle_video.models.storyboard import Storyboard
from pixelle_video.rendering.subtitle_effects import (
    highlight_subtitle_text,
    normalize_subtitle_effect,
    normalize_subtitle_keywords,
    normalize_subtitle_timing,
)
from pixelle_video.rendering_versions import HYPERFRAMES_RENDERER_VERSION
from pixelle_video.services.template_packs import TemplatePack, TemplatePackRegistry
from pixelle_video.utils.template_util import parse_template_size


@dataclass(frozen=True)
class HyperFramesProjectBuild:
    project_dir: str
    entry_path: str
    manifest_path: str
    design_path: str
    duration: float
    assets: list[dict[str, Any]]
    template_id: str
    template_version: int
    template_fingerprint: str
    template_variables: dict[str, Any]


class HyperFramesProjectBuilder:
    """Freeze local media and one seek-safe HTML timeline into a task directory."""

    renderer_version = HYPERFRAMES_RENDERER_VERSION
    gsap_version = "3.14.2"

    def __init__(self, repository_root: str | Path | None = None):
        self.repository_root = (
            Path(repository_root).expanduser().resolve()
            if repository_root
            else Path(__file__).resolve().parents[2]
        )

    def build(
        self,
        storyboard: Storyboard,
        task_dir: str | Path,
        *,
        bgm_path: str | None = None,
        bgm_volume: float = 0.2,
        template_id: str = "knowledge-card",
        template_version: int = 1,
        template_variables: dict[str, Any] | None = None,
    ) -> HyperFramesProjectBuild:
        if not storyboard.frames:
            raise ValueError("HyperFrames project requires at least one storyboard frame")
        width, height = parse_template_size(storyboard.config.frame_template)
        registry = TemplatePackRegistry(
            self.repository_root
            if (self.repository_root / "templates" / "hyperframes").is_dir()
            else None
        )
        template_pack = registry.load(
            template_id or "knowledge-card",
            int(template_version),
        )
        resolved_variables = template_pack.resolve_variables(template_variables)
        subtitle_effect = normalize_subtitle_effect(storyboard.config.subtitle_effect)
        project = Path(task_dir).expanduser().resolve() / "hyperframes"
        assets_dir = project / "assets"
        template_dir = project / "template"
        assets_dir.mkdir(parents=True, exist_ok=True)
        template_dir.mkdir(parents=True, exist_ok=True)

        assets: list[dict[str, Any]] = []
        gsap = self._copy_asset(
            self._gsap_source(),
            assets_dir,
            "runtime",
            assets,
            filename_override="gsap.min.js",
        )
        scenes: list[dict[str, Any]] = []
        cursor = 0.0
        for position, frame in enumerate(storyboard.frames, start=1):
            if frame.media_type not in {None, "image"} or not frame.image_path:
                raise ValueError(
                    f"HyperFrames image+HTML F1 requires a local image for scene {position}"
                )
            if not frame.audio_path:
                raise ValueError(f"HyperFrames scene {position} is missing narration audio")
            duration = max(round(float(frame.duration or 0), 3), 0.1)
            scene_subtitle_effect = normalize_subtitle_effect(
                frame.subtitle_effect or subtitle_effect
            )
            keywords = normalize_subtitle_keywords(frame.subtitle_keywords)
            start_offset, end_offset = normalize_subtitle_timing(
                duration,
                frame.subtitle_start_offset,
                frame.subtitle_end_offset,
            )
            frame.subtitle_effect_applied = scene_subtitle_effect
            frame.subtitle_effect_fallback_reason = None
            transition = frame.transition or ("none" if position == 1 else "crossfade")
            transition_duration = (
                0.0
                if position == 1 or transition == "none"
                else min(
                    float(frame.transition_duration or 0.35),
                    duration / 2,
                    float(scenes[-1]["duration"]) / 2,
                )
            )
            visual_start = max(round(cursor - transition_duration, 3), 0)
            visual_duration = round(duration + cursor - visual_start, 3)
            image_asset = self._copy_asset(
                Path(frame.image_path), assets_dir, f"scene-{position}-image", assets
            )
            audio_asset = self._copy_asset(
                Path(frame.audio_path), assets_dir, f"scene-{position}-audio", assets
            )
            scenes.append(
                {
                    "position": position,
                    "start": round(cursor, 3),
                    "duration": duration,
                    "visual_start": visual_start,
                    "visual_duration": visual_duration,
                    "narration": frame.narration,
                    "image": image_asset,
                    "audio": audio_asset,
                    "image_motion": frame.image_motion or "ken_burns",
                    "transition": transition,
                    "transition_duration": round(transition_duration, 3),
                    "subtitle_effect": scene_subtitle_effect,
                    "subtitle_effect_applied": scene_subtitle_effect,
                    "subtitle_effect_fallback_reason": None,
                    "subtitle_keywords": keywords,
                    "subtitle_start_offset": start_offset,
                    "subtitle_end_offset": end_offset,
                    "direction_reason": frame.direction_reason or "",
                    "focus_x": round(float(frame.focus_x if frame.focus_x is not None else 0.5), 6),
                    "focus_y": round(float(frame.focus_y if frame.focus_y is not None else 0.5), 6),
                    "focus_confidence": round(float(frame.focus_confidence or 0), 6),
                    "focus_source": frame.focus_source or "center_fallback",
                }
            )
            cursor += duration
        total_duration = round(cursor, 3)

        bgm_asset = None
        if bgm_path:
            bgm_asset = self._copy_asset(Path(bgm_path), assets_dir, "bgm", assets)

        entry = project / "index.html"
        design = project / "DESIGN.md"
        manifest = project / "manifest.json"
        self._write_text(
            entry,
            self._render_html(
                storyboard.title,
                scenes,
                width,
                height,
                total_duration,
                gsap,
                bgm_asset,
                bgm_volume,
                template_pack,
                resolved_variables,
            ),
        )
        self._write_json(template_dir / "manifest.json", template_pack.manifest)
        self._write_text(template_dir / "scene.css", template_pack.css)
        self._write_text(
            design,
            self._design_document(
                width,
                height,
                template_pack,
                resolved_variables,
            ),
        )
        self._write_json(
            project / "hyperframes.json",
            {"paths": {"assets": "assets"}, "media": {"autoProxy": False}},
        )
        self._write_json(
            project / "package.json",
            {
                "name": f"pixelle-task-{storyboard.config.task_id or 'video'}",
                "private": True,
                "scripts": {
                    "check": f"npx --yes hyperframes@{self.renderer_version} check",
                    "preview": f"npx --yes hyperframes@{self.renderer_version} preview",
                },
            },
        )
        manifest_payload = {
            "schema_version": 1,
            "render_engine": "hyperframes",
            "renderer_version": self.renderer_version,
            "composition_id": "main",
            "width": width,
            "height": height,
            "duration": total_duration,
            "subtitle_effect": subtitle_effect,
            "entry_file": "index.html",
            "network_required": False,
            "template": {
                "template_id": template_pack.template_id,
                "version": template_pack.version,
                "fingerprint": template_pack.fingerprint,
                "variables": resolved_variables,
                "snapshot_dir": "template",
            },
            "scenes": scenes,
            "assets": assets,
        }
        self._write_json(manifest, manifest_payload)
        active_assets = {Path(item["path"]).name for item in assets}
        for stale_asset in assets_dir.iterdir():
            if stale_asset.is_file() and stale_asset.name not in active_assets:
                stale_asset.unlink()
        return HyperFramesProjectBuild(
            project_dir=str(project),
            entry_path=str(entry),
            manifest_path=str(manifest),
            design_path=str(design),
            duration=total_duration,
            assets=assets,
            template_id=template_pack.template_id,
            template_version=template_pack.version,
            template_fingerprint=template_pack.fingerprint,
            template_variables=resolved_variables,
        )

    def _gsap_source(self) -> Path:
        candidates = (
            self.repository_root
            / "services/hyperframes-renderer/node_modules/gsap/dist/gsap.min.js",
            self.repository_root
            / "services/hyperframes-renderer/fixtures/stickman-psychology/node_modules/gsap/dist/gsap.min.js",
        )
        for candidate in candidates:
            if candidate.is_file():
                return candidate
        raise FileNotFoundError(
            "GSAP runtime is missing; run npm install in services/hyperframes-renderer"
        )

    @staticmethod
    def _copy_asset(
        source: Path,
        destination: Path,
        label: str,
        manifest: list[dict[str, Any]],
        filename_override: str | None = None,
    ) -> str:
        source = source.expanduser().resolve()
        if not source.is_file() or source.stat().st_size <= 0:
            raise FileNotFoundError(f"HyperFrames asset is missing or empty: {source}")
        digest = hashlib.sha256(source.read_bytes()).hexdigest()
        suffix = source.suffix.lower() or ".bin"
        filename = filename_override or f"{label}-{digest[:16]}{suffix}"
        target = destination / filename
        target_digest = (
            hashlib.sha256(target.read_bytes()).hexdigest() if target.is_file() else None
        )
        if target_digest != digest:
            shutil.copy2(source, target)
        manifest.append(
            {
                "label": label,
                "path": f"assets/{filename}",
                "sha256": digest,
                "size_bytes": source.stat().st_size,
            }
        )
        return f"assets/{filename}"

    @staticmethod
    def _render_html(
        title: str,
        scenes: list[dict[str, Any]],
        width: int,
        height: int,
        duration: float,
        gsap_path: str,
        bgm_path: str | None,
        bgm_volume: float,
        template_pack: TemplatePack,
        template_variables: dict[str, Any],
    ) -> str:
        visual_clips: list[str] = []
        audio_clips: list[str] = []
        timeline: list[str] = []
        eyebrow_label = str(template_variables.get("eyebrow_label") or "").strip()
        for scene in scenes:
            number = scene["position"]
            start = scene["start"]
            scene_duration = scene["duration"]
            visual_start = scene["visual_start"]
            visual_duration = scene["visual_duration"]
            subtitle_effect = str(scene.get("subtitle_effect") or "static")
            narration = HyperFramesProjectBuilder._subtitle_markup(
                str(scene["narration"]),
                subtitle_effect,
                scene.get("subtitle_keywords") or [],
            )
            scene_progress = round(number / max(len(scenes), 1) * 100, 3)
            scene_index = (
                f'<span class="scene-index"><span data-var-text="eyebrow_label">'
                f'{html.escape(eyebrow_label)}</span> · {number:02d}</span>'
                if eyebrow_label
                else ""
            )
            visual_clips.append(
                f'''      <section id="scene-{number}" class="clip scene" data-start="{visual_start}" data-duration="{visual_duration}" data-track-index="{number}">
        <div id="scene-{number}-content" class="scene-content" style="opacity: {1 if number == 1 else 0}">
          <div class="scene-media-wrap" data-layout-allow-overflow><img id="scene-{number}-media" src="{scene["image"]}" alt="" style="object-position: {scene["focus_x"] * 100:.3f}% {scene["focus_y"] * 100:.3f}%; transform-origin: {scene["focus_x"] * 100:.3f}% {scene["focus_y"] * 100:.3f}%" /></div>
          <div class="scene-chrome" data-layout-allow-overlap>
            <span class="series-label" data-var-text="brand_label">{html.escape(str(template_variables["brand_label"]))}</span>
            <span class="template-title" data-var-text="video_title">{html.escape(title or "Pixelle Video")}</span>
            <div id="scene-{number}-copy" class="scene-copy" data-layout-allow-overlap>{scene_index}<p class="subtitle-text">{narration}</p></div>
            <div class="scene-progress" aria-hidden="true"><span style="--scene-progress: {scene_progress}%"></span></div>
          </div>
        </div>
      </section>'''
            )
            audio_clips.append(
                f'      <audio id="scene-{number}-audio" src="{scene["audio"]}" data-start="{start}" data-duration="{scene_duration}" data-track-index="{100 + number}" data-volume="1"></audio>'
            )
            timeline.append(
                HyperFramesProjectBuilder._motion_tween(
                    number,
                    str(scene.get("image_motion") or "ken_burns"),
                    visual_start,
                    visual_duration,
                    float(scene.get("focus_x", 0.5)),
                    float(scene.get("focus_y", 0.5)),
                )
            )
            if number > 1 and scene.get("transition") != "none":
                timeline.extend(
                    HyperFramesProjectBuilder._transition_tweens(
                        number,
                        str(scene.get("transition") or "crossfade"),
                        visual_start,
                        float(scene.get("transition_duration") or 0.35),
                    )
                )
            elif number > 1:
                timeline.extend(
                    HyperFramesProjectBuilder._hard_cut_tweens(number, visual_start)
                )
            timeline.extend(
                HyperFramesProjectBuilder._subtitle_tweens(
                    number,
                    subtitle_effect,
                    str(scene["narration"]),
                    visual_start,
                    start,
                    scene_duration,
                    float(scene.get("subtitle_start_offset") or 0),
                    float(scene.get("subtitle_end_offset") or 0),
                )
            )
        if bgm_path:
            audio_clips.append(
                f'      <audio id="background-music" src="{bgm_path}" data-start="0" data-duration="{duration}" data-track-index="1000" data-volume="{min(max(float(bgm_volume), 0), 1)}"></audio>'
            )
        safe_title = html.escape(title or "Pixelle Video")
        variable_declarations = [
            HyperFramesProjectBuilder._variable_declaration(
                definition,
                template_variables[name],
            )
            for name, definition in template_pack.variables.items()
        ]
        variable_declarations.append(
            {
                "id": "video_title",
                "type": "string",
                "label": "视频标题",
                "default": title or "Pixelle Video",
                "maxLength": 120,
            }
        )
        variables_attribute = (
            json.dumps(
                variable_declarations,
                ensure_ascii=False,
                separators=(",", ":"),
            )
            .replace("&", "&amp;")
            .replace("'", "&#39;")
        )
        css_variables = " ".join(
            (
                f"--accent_color: {template_variables['accent_color']};",
                f"--surface_color: {template_variables['surface_color']};",
                f"--text_color: {template_variables['text_color']};",
                f"--card_opacity: {template_variables['card_opacity']};",
            )
        )
        return f'''<!doctype html>
<html lang="zh-CN" data-composition-variables='{variables_attribute}'>
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width={width}, height={height}" />
    <title>{safe_title}</title>
    <script src="{gsap_path}"></script>
    <style>
      * {{ box-sizing: border-box; }}
      @font-face {{ font-family: "Hiragino Sans GB"; src: local("Hiragino Sans GB"); }}
      @font-face {{ font-family: "Songti SC"; src: local("Songti SC"); }}
      @font-face {{ font-family: "STSong"; src: local("STSong"); }}
      :root {{ {css_variables} }}
      html, body {{ margin: 0; width: {width}px; height: {height}px; overflow: hidden; background: var(--surface_color); }}
      body {{ font-family: "Hiragino Sans GB", sans-serif; color: #fff; }}
      #root {{ position: relative; width: {width}px; height: {height}px; overflow: hidden; }}
      .scene {{ position: absolute; inset: 0; width: 100%; height: 100%; overflow: hidden; background: var(--surface_color); }}
      .scene-content {{ position: absolute; inset: 0; width: 100%; height: 100%; overflow: hidden; background: var(--surface_color); transform-origin: center center; }}
      .scene-media-wrap {{ position: absolute; inset: 0; width: 100%; height: 100%; overflow: hidden; }}
      .scene-media-wrap::after {{ content: ""; position: absolute; inset: 0; background: linear-gradient(180deg, rgba(0,0,0,.04) 45%, rgba(0,0,0,.78) 100%); }}
      .scene-media-wrap img {{ display: block; width: 100%; height: 100%; object-fit: cover; transform-origin: center center; will-change: transform; backface-visibility: hidden; -webkit-backface-visibility: hidden; }}
      .scene-copy {{ position: absolute; z-index: 2; left: 7.5%; right: 7.5%; bottom: 9%; padding: 34px 36px; border-left: 8px solid #baff2a; background: rgba(7,9,8,.78); backdrop-filter: blur(12px); }}
      .scene-index {{ display: block; margin-bottom: 18px; color: #baff2a; font-size: 24px; font-weight: 800; letter-spacing: .16em; }}
      .scene-copy p {{ max-width: 100%; margin: 0; font-size: 48px; font-weight: 750; line-height: 1.42; letter-spacing: .01em; overflow-wrap: anywhere; }}
      .subtitle-char, .subtitle-word {{ display: inline-block; }}
      .subtitle-keyword {{ color: #d7ff55; background: rgba(186,255,42,.16); border-radius: .16em; font-weight: 900; text-shadow: 0 0 24px rgba(186,255,42,.24); }}
      mark.subtitle-keyword {{ padding: 0 .12em; }}
      .subtitle-text {{ white-space: pre-wrap; }}
{template_pack.css}
    </style>
  </head>
  <body>
    <div id="root" data-composition-id="main" data-start="0" data-width="{width}" data-height="{height}" data-duration="{duration}">
{os.linesep.join(visual_clips)}
{os.linesep.join(audio_clips)}
    </div>
    <script>
      window.__timelines = window.__timelines || {{}};
      const tl = gsap.timeline({{ paused: true }});
{os.linesep.join(timeline)}
      window.__timelines["main"] = tl;
    </script>
  </body>
</html>
'''

    @staticmethod
    def _variable_declaration(definition, value: Any) -> dict[str, Any]:
        type_map = {
            "text": "string",
            "color": "color",
            "number": "number",
            "bool": "boolean",
            "choice": "enum",
        }
        declaration: dict[str, Any] = {
            "id": definition.name,
            "type": type_map[definition.type],
            "label": definition.label,
            "default": value,
        }
        if definition.type == "text":
            declaration["maxLength"] = definition.max_length
        if definition.type == "number":
            if definition.minimum is not None:
                declaration["min"] = definition.minimum
            if definition.maximum is not None:
                declaration["max"] = definition.maximum
            declaration["step"] = 0.01
        if definition.type == "choice":
            declaration["options"] = [{"value": item, "label": item} for item in definition.choices]
        return declaration

    @staticmethod
    def _subtitle_markup(text: str, effect: str, keywords: object = None) -> str:
        """Produce local, fixed DOM groups for deterministic text animation."""

        normalized = normalize_subtitle_keywords(keywords)
        emphasis = HyperFramesProjectBuilder._keyword_mask(text, normalized)
        if effect == "typewriter":
            return "".join(
                f'<span class="subtitle-char{" subtitle-keyword" if emphasis[index] else ""}">{html.escape(character)}</span>'
                for index, character in enumerate(text)
            )
        if effect == "word_pop":
            parts = HyperFramesProjectBuilder._subtitle_units(text)
            markup: list[str] = []
            cursor = 0
            for part in parts:
                highlighted = any(emphasis[cursor : cursor + len(part)])
                cursor += len(part)
                if part.isspace():
                    markup.append(html.escape(part))
                else:
                    keyword_class = " subtitle-keyword" if highlighted else ""
                    markup.append(
                        f'<span class="subtitle-word{keyword_class}">{html.escape(part)}</span>'
                    )
            return "".join(markup)
        return highlight_subtitle_text(text, normalized).replace(
            'class="pixelle-subtitle-keyword"', 'class="subtitle-keyword"'
        )

    @staticmethod
    def _keyword_mask(text: str, keywords: list[str]) -> list[bool]:
        mask = [False] * len(text)
        folded = text.casefold()
        for keyword in sorted(keywords, key=len, reverse=True):
            needle = keyword.casefold()
            cursor = 0
            while needle and (position := folded.find(needle, cursor)) >= 0:
                for index in range(position, min(position + len(keyword), len(mask))):
                    mask[index] = True
                cursor = position + max(len(keyword), 1)
        return mask

    @staticmethod
    def _subtitle_units(text: str) -> list[str]:
        """Tokenize CJK by glyph, Latin text by word, and preserve spacing."""

        return re.findall(
            r"\s+|[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]|"
            r"[A-Za-z0-9]+(?:['’_-][A-Za-z0-9]+)*|[^\s]",
            text,
        )

    @staticmethod
    def _subtitle_tweens(
        number: int,
        effect: str,
        text: str,
        visual_start: float,
        start: float,
        scene_duration: float,
        start_offset: float = 0,
        end_offset: float = 0,
    ) -> list[str]:
        """Create seek-safe GSAP subtitle choreography from frozen scene timing."""

        paragraph = f"#scene-{number}-copy p"
        hide_start = round(visual_start, 3)
        visible_start = round(start + start_offset, 3)
        visible_end = round(start + scene_duration - end_offset, 3)
        reveal_start = round(
            visible_start + (0 if start_offset else min(0.08, scene_duration * 0.03)),
            3,
        )
        active_duration = max(visible_end - reveal_start, 0.05)
        if effect == "static":
            if start_offset <= 0 and end_offset <= 0:
                return []
            return [
                f'      tl.set("{paragraph}", {{ opacity: 0 }}, {hide_start});',
                f'      tl.set("{paragraph}", {{ opacity: 1 }}, {visible_start});',
                f'      tl.set("{paragraph}", {{ opacity: 0 }}, {visible_end});',
            ]
        if effect == "fade_up":
            reveal_duration = round(
                min(0.65, max(0.08, active_duration * 0.35), active_duration), 3
            )
            tweens = [
                f'      tl.set("{paragraph}", {{ y: 34, opacity: 0 }}, {hide_start});',
                f'      tl.to("{paragraph}", {{ y: 0, opacity: 1, duration: {reveal_duration}, ease: "power3.out" }}, {reveal_start});',
            ]
            if end_offset > 0:
                fade_out = round(min(0.22, max(end_offset, 0.08)), 3)
                tweens.append(
                    f'      tl.to("{paragraph}", {{ opacity: 0, duration: {fade_out}, ease: "power2.in" }}, {round(visible_end - fade_out, 3)});'
                )
            return tweens
        if effect == "typewriter":
            character_count = max(len(text), 1)
            reveal_window = min(max(active_duration * 0.55, 0.08), active_duration, 3.8)
            step = round(reveal_window / character_count, 6)
            selector = f"#scene-{number}-copy .subtitle-char"
            tweens = [
                f'      tl.set("{selector}", {{ opacity: 0 }}, {hide_start});',
                f'      tl.to("{selector}", {{ opacity: 1, duration: 0.001, stagger: {{ each: {step} }}, ease: "none" }}, {reveal_start});',
            ]
            if end_offset > 0:
                tweens.append(
                    f'      tl.set("{paragraph}", {{ opacity: 0 }}, {visible_end});'
                )
            return tweens
        if effect == "word_pop":
            word_count = max(
                sum(
                    1
                    for unit in HyperFramesProjectBuilder._subtitle_units(text)
                    if not unit.isspace()
                ),
                1,
            )
            reveal_window = min(max(active_duration * 0.42, 0.08), active_duration, 2.8)
            step = round(reveal_window / word_count, 6)
            selector = f"#scene-{number}-copy .subtitle-word"
            tweens = [
                f'      tl.set("{selector}", {{ y: 22, scale: 0.84, opacity: 0 }}, {hide_start});',
                f'      tl.to("{selector}", {{ y: 0, scale: 1, opacity: 1, duration: 0.32, stagger: {{ each: {step} }}, ease: "back.out(1.35)" }}, {reveal_start});',
            ]
            if end_offset > 0:
                tweens.append(
                    f'      tl.set("{paragraph}", {{ opacity: 0 }}, {visible_end});'
                )
            return tweens
        raise ValueError(f"Unsupported subtitle effect: {effect}")

    @staticmethod
    def _hard_cut_tweens(number: int, start: float) -> list[str]:
        """Make a no-transition scene switch explicit on the seekable timeline."""

        return [
            f'      tl.set("#scene-{number}-content", {{ opacity: 1 }}, {start});',
            f'      tl.set("#scene-{number - 1}-content", {{ opacity: 0 }}, {start});',
        ]

    @staticmethod
    def _motion_tween(
        number: int,
        motion: str,
        start: float,
        duration: float,
        focus_x: float = 0.5,
        focus_y: float = 0.5,
    ) -> str:
        """Build one seek-safe, linearly interpolated camera pose per image.

        A frozen ``set`` followed by a single ``to`` avoids GSAP ``fromTo``
        re-applying its start pose while HyperFrames workers seek arbitrary
        frames. Stable compositor options prevent 2D/3D switching and pixel
        rounding from showing up as camera shake.
        """
        horizontal_min = max(-4.0, min(4.0, 7.5 - focus_x * 100))
        horizontal_max = max(-4.0, min(4.0, 92.5 - focus_x * 100))
        vertical_min = max(-4.0, min(4.0, 6.0 - focus_y * 100))
        vertical_max = max(-4.0, min(4.0, 80.0 - focus_y * 100))
        horizontal_min = min(horizontal_min, horizontal_max)
        vertical_min = min(vertical_min, vertical_max)
        poses = {
            "none": ("scale: 1, xPercent: 0, yPercent: 0", "scale: 1, xPercent: 0, yPercent: 0"),
            "push_in": ("scale: 1.0, xPercent: 0, yPercent: 0", "scale: 1.12, xPercent: 0, yPercent: 0"),
            "pull_out": ("scale: 1.12, xPercent: 0, yPercent: 0", "scale: 1.0, xPercent: 0, yPercent: 0"),
            "pan_left": (
                f"scale: 1.12, xPercent: {horizontal_max:.3f}",
                f"scale: 1.12, xPercent: {horizontal_min:.3f}",
            ),
            "pan_right": (
                f"scale: 1.12, xPercent: {horizontal_min:.3f}",
                f"scale: 1.12, xPercent: {horizontal_max:.3f}",
            ),
            "slow_pan": (
                f"scale: 1.12, xPercent: {horizontal_min:.3f}",
                f"scale: 1.12, xPercent: {horizontal_max:.3f}",
            ),
            "pan_up": (
                f"scale: 1.12, yPercent: {vertical_max:.3f}",
                f"scale: 1.12, yPercent: {vertical_min:.3f}",
            ),
            "pan_down": (
                f"scale: 1.12, yPercent: {vertical_min:.3f}",
                f"scale: 1.12, yPercent: {vertical_max:.3f}",
            ),
            "ken_burns": (
                f"scale: 1.02, xPercent: {horizontal_min / 2:.3f}, yPercent: {vertical_max / 2:.3f}",
                f"scale: 1.12, xPercent: {horizontal_max / 2:.3f}, yPercent: {vertical_min / 2:.3f}",
            ),
        }
        origin, target = poses.get(motion, poses["ken_burns"])
        selector = f"#scene-{number}-media"
        frozen = (
            f'{origin}, transformOrigin: "{focus_x * 100:.3f}% {focus_y * 100:.3f}%", '
            "force3D: true, autoRound: false, smoothOrigin: false"
        )
        set_pose = f'      tl.set("{selector}", {{{frozen}}}, {start});'
        if motion == "none":
            return set_pose
        tween = (
            f'      tl.to("{selector}", {{{target}, duration: {duration}, ease: "none", '
            f'force3D: true, autoRound: false, smoothOrigin: false}}, {start});'
        )
        return f"{set_pose}\n{tween}"

    @staticmethod
    def _transition_tweens(
        number: int,
        transition: str,
        start: float,
        duration: float,
    ) -> list[str]:
        incoming = f"#scene-{number}-content"
        outgoing = f"#scene-{number - 1}-content"
        duration = max(duration, 0.05)
        if transition == "fade_black":
            half = round(duration / 2, 3)
            midpoint = round(start + half, 3)
            return [
                f'      tl.to("{outgoing}", {{opacity: 0, duration: {half}, ease: "power2.in"}}, {start});',
                f'      tl.fromTo("{incoming}", {{opacity: 0}}, '
                f'{{opacity: 1, duration: {half}, ease: "power2.out", immediateRender: false}}, {midpoint});',
            ]
        patterns = {
            "slide_left": (
                "xPercent: 100, opacity: 1",
                "xPercent: 0, opacity: 1",
                "xPercent: -35, opacity: 0.35",
            ),
            "slide_right": (
                "xPercent: -100, opacity: 1",
                "xPercent: 0, opacity: 1",
                "xPercent: 35, opacity: 0.35",
            ),
            "wipe_up": (
                'clipPath: "inset(100% 0 0 0)", opacity: 1',
                'clipPath: "inset(0% 0 0 0)", opacity: 1',
                "yPercent: -8, opacity: 0.5",
            ),
            "wipe_down": (
                'clipPath: "inset(0 0 100% 0)", opacity: 1',
                'clipPath: "inset(0 0 0% 0)", opacity: 1',
                "yPercent: 8, opacity: 0.5",
            ),
            "circle_open": (
                'clipPath: "circle(0% at 50% 50%)", opacity: 1',
                'clipPath: "circle(150% at 50% 50%)", opacity: 1',
                "scale: 1.04, opacity: 0.45",
            ),
            "zoom_in": (
                "scale: 1.18, opacity: 0",
                "scale: 1, opacity: 1",
                "scale: 0.9, opacity: 0",
            ),
            "blur": (
                'scale: 1.03, opacity: 0, filter: "blur(18px)"',
                'scale: 1, opacity: 1, filter: "blur(0px)"',
                'scale: 0.98, opacity: 0, filter: "blur(18px)"',
            ),
        }
        initial, final, outgoing_final = patterns.get(
            transition,
            ("opacity: 0", "opacity: 1", "opacity: 0"),
        )
        ease = "power3.inOut" if transition.startswith("slide") else "power2.inOut"
        return [
            f'      tl.fromTo("{incoming}", {{{initial}}}, '
            f'{{{final}, duration: {duration}, ease: "{ease}", immediateRender: false}}, {start});',
            f'      tl.to("{outgoing}", {{{outgoing_final}, duration: {duration}, ease: "{ease}"}}, {start});',
        ]

    @staticmethod
    def _design_document(
        width: int,
        height: int,
        template_pack: TemplatePack,
        variables: dict[str, Any],
    ) -> str:
        frozen = json.dumps(variables, ensure_ascii=False, indent=2)
        return f"""{template_pack.design.rstrip()}

## 任务冻结信息

- Canvas: {width} × {height}
- Template: `{template_pack.template_id}@{template_pack.version}`
- Fingerprint: `{template_pack.fingerprint}`
- Motion: deterministic per-scene camera presets and short caption reveals
- Subtitle effect: frozen per task in `manifest.json`
- Transitions: overlapping tracks with frozen scene-level timing and presets
- Runtime: local assets only; no render-time network, clocks, randomness, or input state

```json
{frozen}
```
"""

    @staticmethod
    def _write_text(path: Path, content: str) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_suffix(f"{path.suffix}.{os.getpid()}.{uuid.uuid4().hex}.tmp")
        try:
            temporary.write_text(content, encoding="utf-8")
            os.replace(temporary, path)
        finally:
            if temporary.exists():
                temporary.unlink()

    @classmethod
    def _write_json(cls, path: Path, value: dict[str, Any]) -> None:
        cls._write_text(path, json.dumps(value, ensure_ascii=False, indent=2) + "\n")
