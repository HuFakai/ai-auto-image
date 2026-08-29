"""Deterministic task-owned cover art and final-video prepending."""

from __future__ import annotations

import hashlib
import json
import math
import os
import subprocess
import uuid
from dataclasses import dataclass
from fractions import Fraction
from pathlib import Path
from typing import Any, Iterable

import ffmpeg
from PIL import Image, ImageDraw, ImageEnhance, ImageFilter, ImageFont, ImageOps

from pixelle_video.utils.os_util import which_ffmpeg, which_ffprobe

COVER_DURATION = 1.2
_COVER_VERSION = 1
COVER_TEMPLATE_VERSION = 1
_OUTPUT_MARKER_PREFIX = "pixelle-video-cover-v1:"


@dataclass(frozen=True)
class CoveredVideo:
    video_path: str
    cover_path: str
    duration: float
    reused_output: bool
    reused_cover: bool


class VideoCoverService:
    """Create a local-media title card and atomically prepend it to an MP4."""

    def ensure(
        self,
        *,
        video_path: str | Path,
        task_dir: str | Path,
        title: str,
        media_paths: Iterable[str | Path | None],
        duration: float = COVER_DURATION,
        cover_prompt: str | None = None,
    ) -> CoveredVideo:
        video = Path(video_path).expanduser().resolve()
        task = Path(task_dir).expanduser().resolve()
        task.mkdir(parents=True, exist_ok=True)
        if not self._usable_file(video):
            raise FileNotFoundError(f"Cannot add a cover to missing video: {video}")

        probe = self._probe_video(video)
        width, height = probe["width"], probe["height"]
        fps = probe["fps"]
        sources = [
            Path(item).expanduser().resolve()
            for item in media_paths
            if item and self._usable_file(Path(item).expanduser())
        ]
        if not sources:
            source_snapshot = task / "cover-source.png"
            source_manifest = task / "cover-source.json"
            raw_identity = self._source_identity(video)
            output_is_covered = str(probe.get("comment") or "").startswith(
                _OUTPUT_MARKER_PREFIX
            )
            snapshot_matches_raw = False
            try:
                snapshot_matches_raw = (
                    json.loads(source_manifest.read_text(encoding="utf-8"))
                    == raw_identity
                )
            except (OSError, json.JSONDecodeError):
                pass
            if not self._usable_file(source_snapshot) or (
                not output_is_covered and not snapshot_matches_raw
            ):
                frame = self._read_media_frame(video)
                temporary = source_snapshot.with_name(
                    f".{source_snapshot.name}.{uuid.uuid4().hex}.tmp.png"
                )
                try:
                    frame.save(temporary, format="PNG", optimize=True)
                    os.replace(temporary, source_snapshot)
                finally:
                    temporary.unlink(missing_ok=True)
                self._write_json_atomic(source_manifest, raw_identity)
            sources = [source_snapshot]
        source = sources[0]

        cover_path = task / "cover.png"
        manifest_path = task / "cover.json"
        expected = self._cover_manifest(
            title, source, width, height, duration, cover_prompt
        )
        reused_cover = self._valid_cover(cover_path, manifest_path, expected)
        if not reused_cover:
            self._render_cover(source, cover_path, title, width, height)
            self._write_json_atomic(manifest_path, expected)

        marker = f"{_OUTPUT_MARKER_PREFIX}{expected['fingerprint']}"
        if probe.get("comment") == marker:
            return CoveredVideo(
                video_path=str(video),
                cover_path=str(cover_path),
                duration=probe["duration"],
                reused_output=True,
                reused_cover=reused_cover,
            )

        source_video = video
        trimmed_path: Path | None = None
        existing_marker = str(probe.get("comment") or "")
        if existing_marker.startswith(_OUTPUT_MARKER_PREFIX):
            trimmed_path = video.with_name(f".{video.stem}.without-cover-{uuid.uuid4().hex}.mp4")
            self._trim_existing_cover(video, trimmed_path, duration)
            source_video = trimmed_path

        output = video.with_name(f".{video.stem}.with-cover-{uuid.uuid4().hex}.mp4")
        try:
            self._prepend(
                source_video,
                cover_path,
                output,
                width=width,
                height=height,
                fps=fps,
                duration=duration,
                marker=marker,
                has_audio=probe["has_audio"],
                main_duration=(
                    max(probe["duration"] - duration, 0.001)
                    if trimmed_path
                    else probe["duration"]
                ),
            )
            if not self._usable_file(output):
                raise RuntimeError("FFmpeg completed without producing a covered video")
            os.replace(output, video)
        finally:
            output.unlink(missing_ok=True)
            if trimmed_path:
                trimmed_path.unlink(missing_ok=True)

        final_probe = self._probe_video(video)
        if final_probe.get("comment") != marker:
            raise RuntimeError("Covered video is missing its retry marker")
        return CoveredVideo(
            video_path=str(video),
            cover_path=str(cover_path),
            duration=final_probe["duration"],
            reused_output=False,
            reused_cover=reused_cover,
        )

    @staticmethod
    def storyboard_media_paths(storyboard) -> list[str]:
        paths: list[str] = []
        for frame in storyboard.frames:
            for name in (
                "image_path",
                "composed_image_path",
                "video_path",
                "whiteboard_silent_path",
                "video_segment_path",
            ):
                value = getattr(frame, name, None)
                if value:
                    paths.append(value)
        return paths

    @staticmethod
    def _usable_file(path: Path) -> bool:
        try:
            return path.is_file() and path.stat().st_size > 0
        except OSError:
            return False

    @staticmethod
    def _source_identity(path: Path) -> dict[str, str | int]:
        stat = path.stat()
        return {
            "path": str(path),
            "size": stat.st_size,
            "mtime_ns": stat.st_mtime_ns,
        }

    def _cover_manifest(
        self,
        title: str,
        source: Path,
        width: int,
        height: int,
        duration: float,
        cover_prompt: str | None = None,
    ) -> dict[str, object]:
        payload: dict[str, object] = {
            "version": _COVER_VERSION,
            "template_version": COVER_TEMPLATE_VERSION,
            "title": title.strip() or "Untitled",
            "width": width,
            "height": height,
            "duration": duration,
            "source": self._source_identity(source),
            "prompt": str(cover_prompt or "").strip(),
        }
        canonical = json.dumps(payload, ensure_ascii=False, sort_keys=True).encode("utf-8")
        payload["fingerprint"] = hashlib.sha256(canonical).hexdigest()
        return payload

    @staticmethod
    def _valid_cover(path: Path, manifest_path: Path, expected: dict[str, object]) -> bool:
        try:
            if json.loads(manifest_path.read_text(encoding="utf-8")) != expected:
                return False
            with Image.open(path) as image:
                image.verify()
            with Image.open(path) as image:
                return image.size == (expected["width"], expected["height"])
        except (OSError, ValueError, json.JSONDecodeError):
            return False

    def _render_cover(
        self,
        source: Path,
        output: Path,
        title: str,
        width: int,
        height: int,
    ) -> None:
        self._render_classic(source, output, title, width, height)

    def _render_classic(
        self,
        source: Path,
        output: Path,
        title: str,
        width: int,
        height: int,
    ) -> None:
        media = self._read_media_frame(source)
        canvas = ImageOps.fit(media.convert("RGB"), (width, height), method=Image.Resampling.LANCZOS)
        canvas = ImageEnhance.Color(canvas).enhance(0.78).filter(
            ImageFilter.GaussianBlur(max(8, min(width, height) // 45))
        )
        shade = Image.new("RGBA", (width, height), (0, 0, 0, 0))
        shade_pixels = shade.load()
        for y in range(height):
            alpha = int(65 + 150 * (y / max(height - 1, 1)) ** 1.35)
            for x in range(width):
                shade_pixels[x, y] = (5, 8, 18, alpha)
        canvas = Image.alpha_composite(canvas.convert("RGBA"), shade)

        draw = ImageDraw.Draw(canvas)
        margin = max(24, width // 14)
        hero_top = max(28, height // 14)
        hero_height = int(height * 0.49)
        hero_box = (margin, hero_top, width - margin, hero_top + hero_height)
        radius = max(18, width // 28)
        hero = ImageOps.fit(
            media.convert("RGB"),
            (hero_box[2] - hero_box[0], hero_box[3] - hero_box[1]),
            method=Image.Resampling.LANCZOS,
        )
        mask = Image.new("L", hero.size, 0)
        ImageDraw.Draw(mask).rounded_rectangle((0, 0, *hero.size), radius=radius, fill=255)
        canvas.paste(hero, hero_box[:2], mask)
        draw.rounded_rectangle(hero_box, radius=radius, outline=(255, 255, 255, 95), width=max(2, width // 360))

        accent = (111, 242, 193, 255)
        text_top = hero_box[3] + max(28, height // 24)
        draw.rounded_rectangle(
            (margin, text_top, margin + max(64, width // 7), text_top + max(8, height // 160)),
            radius=max(4, width // 180),
            fill=accent,
        )
        title_text = title.strip() or "Untitled"
        max_text_width = width - 2 * margin
        font, lines = self._fit_title(title_text, max_text_width, int(height * 0.26), width, height)
        line_gap = max(6, height // 180)
        cursor_y = text_top + max(28, height // 30)
        for line in lines:
            draw.text(
                (margin, cursor_y),
                line,
                font=font,
                fill=(250, 252, 255, 255),
                stroke_width=max(1, width // 540),
                stroke_fill=(0, 0, 0, 95),
            )
            box = draw.textbbox((0, 0), line, font=font, stroke_width=0)
            cursor_y += box[3] - box[1] + line_gap
        label_font = self._font(max(13, min(width, height) // 45))
        draw.text(
            (margin, height - margin - max(18, height // 70)),
            "PIXELLE  /  VIDEO STORY",
            font=label_font,
            fill=(220, 229, 238, 190),
        )

        temporary = output.with_name(f".{output.name}.{uuid.uuid4().hex}.tmp.png")
        try:
            canvas.convert("RGB").save(temporary, format="PNG", optimize=True)
            os.replace(temporary, output)
        finally:
            temporary.unlink(missing_ok=True)

    def _render_centered_title(
        self,
        source: Path,
        output: Path,
        title: str,
        width: int,
        height: int,
    ) -> None:
        """Variant 2: full-bleed cinematic poster with a quiet lower headline."""
        media = self._read_media_frame(source)
        canvas = ImageOps.fit(media.convert("RGB"), (width, height), method=Image.Resampling.LANCZOS)
        canvas = ImageEnhance.Color(canvas).enhance(0.86).filter(ImageFilter.GaussianBlur(0.6))
        shade = Image.new("RGBA", (width, height), (0, 0, 0, 0))
        shade_draw = ImageDraw.Draw(shade)
        for y in range(height):
            progress = y / max(height - 1, 1)
            alpha = int(16 + 215 * progress**2.25)
            shade_draw.line((0, y, width, y), fill=(4, 8, 15, alpha))
        canvas = Image.alpha_composite(canvas.convert("RGBA"), shade)
        draw = ImageDraw.Draw(canvas, "RGBA")
        margin = max(30, width // 11)
        accent = (124, 244, 193, 255)
        eyebrow_font = self._font(max(14, min(width, height) // 52))
        eyebrow_y = int(height * 0.57)
        draw.text((margin, eyebrow_y), "A QUESTION WORTH KEEPING", font=eyebrow_font, fill=accent)
        draw.rounded_rectangle(
            (margin, eyebrow_y + max(28, height // 52), margin + max(72, width // 5), eyebrow_y + max(36, height // 44)),
            radius=max(3, width // 180),
            fill=accent,
        )
        font, lines = self._fit_title(
            title.strip() or "Untitled",
            width - 2 * margin,
            int(height * 0.25),
            width,
            height,
        )
        cursor_y = eyebrow_y + max(58, height // 22)
        for line in lines:
            draw.text(
                (margin, cursor_y),
                line,
                font=font,
                fill=(247, 249, 244, 255),
                stroke_width=max(1, width // 540),
                stroke_fill=(0, 0, 0, 105),
            )
            box = draw.textbbox((0, 0), line, font=font, stroke_width=0)
            cursor_y += box[3] - box[1] + max(6, height // 180)
        self._paint_brand(draw, width, height, margin)
        self._write_png(canvas, output)

    def _render_bottom_card(
        self,
        source: Path,
        output: Path,
        title: str,
        width: int,
        height: int,
    ) -> None:
        """Variant 3: warm editorial card with print-like contrast."""
        media = self._read_media_frame(source)
        canvas = ImageOps.fit(media.convert("RGB"), (width, height), method=Image.Resampling.LANCZOS)
        draw = ImageDraw.Draw(canvas, "RGBA")
        margin = max(24, width // 14)
        card_top = int(height * 0.64)
        draw.rounded_rectangle(
            (margin, card_top, width - margin, height - margin),
            radius=max(20, width // 26),
            fill=(246, 239, 222, 244),
            outline=(35, 33, 27, 75),
            width=max(2, width // 360),
        )
        content_x = margin + max(24, width // 20)
        eyebrow_font = self._font(max(13, min(width, height) // 54))
        draw.text(
            (content_x, card_top + max(24, height // 36)),
            "THE SHORT ANSWER  /  03",
            font=eyebrow_font,
            fill=(202, 72, 47, 255),
        )
        font, lines = self._fit_title(
            title.strip() or "Untitled",
            width - 2 * margin - max(24, width // 20),
            int(height * 0.18),
            width,
            height,
        )
        cursor_y = card_top + max(62, height // 17)
        for line in lines:
            draw.text(
                (content_x, cursor_y),
                line,
                font=font,
                fill=(22, 24, 22, 255),
            )
            box = draw.textbbox((0, 0), line, font=font, stroke_width=0)
            cursor_y += box[3] - box[1] + max(6, height // 180)
        brand_font = self._font(max(12, min(width, height) // 58))
        draw.text(
            (content_x, height - margin - max(22, height // 62)),
            "PIXELLE EDITORIAL",
            font=brand_font,
            fill=(67, 65, 58, 190),
        )
        self._write_png(canvas, output)

    def _render_top_chip(
        self,
        source: Path,
        output: Path,
        title: str,
        width: int,
        height: int,
    ) -> None:
        """Variant 4: graphic headline panel with a generous image field."""
        media = self._read_media_frame(source)
        canvas = ImageOps.fit(media.convert("RGB"), (width, height), method=Image.Resampling.LANCZOS)
        canvas = ImageEnhance.Contrast(canvas).enhance(1.04).convert("RGBA")
        draw = ImageDraw.Draw(canvas, "RGBA")
        margin = max(24, width // 14)
        panel_bottom = int(height * 0.35)
        draw.rectangle((0, 0, width, panel_bottom), fill=(8, 13, 20, 246))
        draw.rectangle(
            (margin, panel_bottom - max(8, height // 180), width - margin, panel_bottom),
            fill=(240, 196, 71, 255),
        )
        eyebrow_font = self._font(max(13, min(width, height) // 54))
        draw.text(
            (margin, max(28, height // 32)),
            "ONE IDEA  /  CLEARLY TOLD",
            font=eyebrow_font,
            fill=(240, 196, 71, 255),
        )
        font, lines = self._fit_title(
            title.strip() or "Untitled",
            width - 2 * margin,
            int(height * 0.22),
            width,
            height,
        )
        cursor_y = max(68, height // 14)
        for line in lines:
            draw.text(
                (margin, cursor_y),
                line,
                font=font,
                fill=(247, 249, 244, 255),
            )
            box = draw.textbbox((0, 0), line, font=font, stroke_width=0)
            cursor_y += box[3] - box[1] + max(6, height // 180)
        self._paint_brand(draw, width, height, margin)
        self._write_png(canvas, output)

    @staticmethod
    def _paint_brand(
        draw: ImageDraw.ImageDraw,
        width: int,
        height: int,
        margin: int,
    ) -> None:
        label_font = VideoCoverService._font(max(13, min(width, height) // 45))
        draw.text(
            (margin, height - margin - max(18, height // 70)),
            "PIXELLE  /  VIDEO STORY",
            font=label_font,
            fill=(220, 229, 238, 190),
        )

    @staticmethod
    def _write_png(canvas: Image.Image, output: Path) -> None:
        temporary = output.with_name(f".{output.name}.{uuid.uuid4().hex}.tmp.png")
        try:
            canvas.convert("RGB").save(temporary, format="PNG", optimize=True)
            os.replace(temporary, output)
        finally:
            temporary.unlink(missing_ok=True)

    @staticmethod
    def title_safe_area(width: int, height: int) -> dict[str, Any]:
        """Central title safe zone with normalized and pixel coordinates."""
        normalized = {"x": 0.08, "y": 0.08, "width": 0.84, "height": 0.70}
        return {
            "x": int(width * normalized["x"]),
            "y": int(height * normalized["y"]),
            "width": int(width * normalized["width"]),
            "height": int(height * normalized["height"]),
            "normalized": normalized,
        }

    @staticmethod
    def platform_crops(width: int, height: int) -> dict[str, dict[str, Any]]:
        """Crop boxes for common feed platforms plus in-crop safe areas."""
        ratios = {
            "douyin_9x16": (9, 16),
            "kuaishou_9x16": (9, 16),
            "wechat_9x16": (9, 16),
            "xhs_3x4": (3, 4),
            "feed_1x1": (1, 1),
            "feed_16x9": (16, 9),
        }
        crops: dict[str, dict[str, Any]] = {}
        for name, (rw, rh) in ratios.items():
            ratio = rw / rh
            source_ratio = width / height
            if source_ratio >= ratio:
                crop_w = int(height * ratio)
                crop_h = height
                x0 = (width - crop_w) // 2
                y0 = 0
            else:
                crop_w = width
                crop_h = int(width / ratio)
                x0 = 0
                y0 = int((height - crop_h) * 0.45)
            x1, y1 = x0 + crop_w, y0 + crop_h
            safe = VideoCoverService.title_safe_area(crop_w, crop_h)
            crops[name] = {
                "ratio": f"{rw}:{rh}",
                "box": [x0, y0, x1, y1],
                "width": crop_w,
                "height": crop_h,
                "safe_area": {
                    **safe,
                    "x": x0 + safe["x"],
                    "y": y0 + safe["y"],
                },
            }
        return crops

    @staticmethod
    def _read_media_frame(path: Path) -> Image.Image:
        try:
            with Image.open(path) as image:
                return image.convert("RGB")
        except (OSError, ValueError):
            import cv2

            capture = cv2.VideoCapture(str(path))
            try:
                ok, frame = capture.read()
            finally:
                capture.release()
            if not ok or frame is None:
                raise RuntimeError(f"Could not read cover media: {path}")
            return Image.fromarray(cv2.cvtColor(frame, cv2.COLOR_BGR2RGB))

    @classmethod
    def _fit_title(
        cls,
        text: str,
        max_width: int,
        max_height: int,
        width: int,
        height: int,
    ) -> tuple[ImageFont.FreeTypeFont | ImageFont.ImageFont, list[str]]:
        for size in range(max(28, min(width, height) // 10), 17, -2):
            font = cls._font(size)
            lines = cls._wrap_text(text, font, max_width, max_lines=3)
            line_heights = [font.getbbox(line)[3] - font.getbbox(line)[1] for line in lines]
            if lines and sum(line_heights) + max(0, len(lines) - 1) * height // 180 <= max_height:
                return font, lines
        font = cls._font(18)
        return font, cls._wrap_text(text, font, max_width, max_lines=3)

    @staticmethod
    def _wrap_text(
        text: str,
        font: ImageFont.FreeTypeFont | ImageFont.ImageFont,
        max_width: int,
        *,
        max_lines: int,
    ) -> list[str]:
        draw = ImageDraw.Draw(Image.new("RGB", (1, 1)))
        tokens = text.split() if " " in text.strip() else list(text.strip())
        separator = " " if " " in text.strip() else ""
        lines: list[str] = []
        current = ""
        for token in tokens:
            candidate = token if not current else f"{current}{separator}{token}"
            if current and draw.textlength(candidate, font=font) > max_width:
                lines.append(current)
                current = token
                if len(lines) == max_lines:
                    break
            else:
                current = candidate
        if len(lines) < max_lines and current:
            lines.append(current)
        consumed = separator.join(lines)
        if consumed != text.strip() and lines:
            ellipsis = "…"
            last = lines[-1]
            while last and draw.textlength(last + ellipsis, font=font) > max_width:
                last = last[:-1].rstrip()
            lines[-1] = last + ellipsis
        return lines

    @staticmethod
    def _font(size: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
        candidates = (
            Path("/System/Library/Fonts/PingFang.ttc"),
            Path("/System/Library/Fonts/Supplemental/Arial Unicode.ttf"),
            Path("/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc"),
            Path("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"),
            Path("C:/Windows/Fonts/msyh.ttc"),
            Path("C:/Windows/Fonts/simhei.ttf"),
            Path("C:/Windows/Fonts/simsun.ttc"),
        )
        for path in candidates:
            if path.is_file():
                return ImageFont.truetype(str(path), size=size, index=0)
        return ImageFont.load_default(size=size)

    @staticmethod
    def _probe_video(path: Path) -> dict[str, object]:
        ffprobe_path = which_ffprobe()
        if not ffprobe_path:
            raise RuntimeError("ffprobe is required to inspect the video cover")
        try:
            data = ffmpeg.probe(str(path), cmd=ffprobe_path)
        except ffmpeg.Error as exc:
            detail = exc.stderr.decode(errors="replace") if exc.stderr else str(exc)
            raise RuntimeError(f"Could not inspect final video: {detail}") from exc
        video_stream = next(
            (stream for stream in data.get("streams", []) if stream.get("codec_type") == "video"),
            None,
        )
        if video_stream is None:
            raise RuntimeError("Final MP4 has no video stream")
        rate = video_stream.get("avg_frame_rate") or video_stream.get("r_frame_rate") or "30/1"
        try:
            fps = float(Fraction(rate))
        except (ValueError, ZeroDivisionError):
            fps = 30.0
        return {
            "width": int(video_stream["width"]),
            "height": int(video_stream["height"]),
            "fps": max(1.0, fps),
            "duration": float(data.get("format", {}).get("duration") or 0),
            "has_audio": any(
                stream.get("codec_type") == "audio" for stream in data.get("streams", [])
            ),
            "comment": data.get("format", {}).get("tags", {}).get("comment"),
        }

    @staticmethod
    def _prepend(
        video: Path,
        cover: Path,
        output: Path,
        *,
        width: int,
        height: int,
        fps: float,
        duration: float,
        marker: str,
        has_audio: bool,
        main_duration: float,
    ) -> None:
        ffmpeg_path = which_ffmpeg()
        if not ffmpeg_path:
            raise RuntimeError("ffmpeg is required to prepend the video cover")
        command = [
            ffmpeg_path,
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-loop",
            "1",
            "-framerate",
            f"{fps:.6f}",
            "-t",
            f"{duration:.6f}",
            "-i",
            str(cover),
            "-i",
            str(video),
        ]
        if not has_audio:
            command.extend(
                ["-f", "lavfi", "-t", f"{main_duration:.6f}", "-i", "anullsrc=r=48000:cl=stereo"]
            )
        main_audio = "[1:a]" if has_audio else "[2:a]"
        filters = (
            f"[0:v]scale={width}:{height}:force_original_aspect_ratio=decrease,"
            f"pad={width}:{height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps={fps:.6f},"
            f"trim=duration={duration:.6f},setpts=PTS-STARTPTS[coverv];"
            f"[1:v]scale={width}:{height}:force_original_aspect_ratio=decrease,"
            f"pad={width}:{height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps={fps:.6f},"
            "setpts=PTS-STARTPTS[mainv];"
            f"anullsrc=r=48000:cl=stereo,atrim=duration={duration:.6f},"
            "asetpts=PTS-STARTPTS[covera];"
            f"{main_audio}aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,"
            "asetpts=PTS-STARTPTS[maina];"
            "[coverv][covera][mainv][maina]concat=n=2:v=1:a=1[vout][aout]"
        )
        command.extend(
            [
                "-filter_complex",
                filters,
                "-map",
                "[vout]",
                "-map",
                "[aout]",
                "-c:v",
                "libx264",
                "-preset",
                "medium",
                "-crf",
                "20",
                "-pix_fmt",
                "yuv420p",
                "-c:a",
                "aac",
                "-b:a",
                "192k",
                "-metadata",
                f"comment={marker}",
                "-movflags",
                "+faststart",
                str(output),
            ]
        )
        try:
            subprocess.run(command, capture_output=True, text=True, check=True)
        except subprocess.CalledProcessError as exc:
            raise RuntimeError(f"Failed to prepend video cover: {exc.stderr or exc}") from exc

    @staticmethod
    def _trim_existing_cover(video: Path, output: Path, duration: float) -> None:
        ffmpeg_path = which_ffmpeg()
        if not ffmpeg_path:
            raise RuntimeError("ffmpeg is required to replace the video cover")
        command = [
            ffmpeg_path,
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-ss",
            f"{duration:.6f}",
            "-i",
            str(video),
            "-c",
            "copy",
            str(output),
        ]
        try:
            subprocess.run(command, capture_output=True, text=True, check=True)
        except subprocess.CalledProcessError as exc:
            raise RuntimeError(f"Failed to replace existing video cover: {exc.stderr or exc}") from exc

    @staticmethod
    def _write_json_atomic(path: Path, value: dict[str, object]) -> None:
        temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
        try:
            temporary.write_text(
                json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True),
                encoding="utf-8",
            )
            os.replace(temporary, path)
        finally:
            temporary.unlink(missing_ok=True)


def apply_text_watermark(video_path: str | Path, config: dict[str, object]) -> str:
    """Burn a text badge into the final MP4 without requiring FFmpeg drawtext."""
    if not config.get("enabled"):
        return str(video_path)
    source = Path(video_path).expanduser().resolve()
    if not source.is_file():
        raise FileNotFoundError(source)
    ffmpeg_path = which_ffmpeg()
    if not ffmpeg_path:
        raise RuntimeError("ffmpeg is required to render a watermark")
    marker_path = source.with_suffix(source.suffix + ".watermark.json")
    fingerprint = hashlib.sha256(
        json.dumps(config, ensure_ascii=False, sort_keys=True).encode("utf-8")
    ).hexdigest()
    try:
        marker = json.loads(marker_path.read_text(encoding="utf-8"))
        stat = source.stat()
        if marker == {
            "fingerprint": fingerprint,
            "size_bytes": stat.st_size,
            "mtime_ns": stat.st_mtime_ns,
        }:
            return str(source)
    except (OSError, json.JSONDecodeError):
        pass
    probe = VideoCoverService._probe_video(source)
    width, height = int(probe["width"]), int(probe["height"])
    opacity = min(1.0, max(0.0, float(config.get("opacity", 0.35))))
    temporary = source.with_name(f".{source.stem}.watermark.{uuid.uuid4().hex}.mp4")
    badge_path = source.with_name(f".{source.stem}.watermark.{uuid.uuid4().hex}.png")
    try:
        _render_watermark_badge(
            str(config.get("text") or ""),
            badge_path,
            frame_width=width,
            frame_height=height,
            opacity=opacity,
        )
        x, y = _watermark_overlay_position(
            str(config.get("position") or "bottom_right"),
            moving=config.get("motion") == "moving",
        )
        filter_graph = f"[1:v]format=rgba[wm];[0:v][wm]overlay=x='{x}':y='{y}':shortest=1[vout]"
        completed = subprocess.run(
            [
                ffmpeg_path,
                "-hide_banner",
                "-loglevel",
                "error",
                "-y",
                "-i",
                str(source),
                "-loop",
                "1",
                "-i",
                str(badge_path),
                "-filter_complex",
                filter_graph,
                "-map",
                "[vout]",
                "-map",
                "0:a?",
                "-map_metadata",
                "0",
                "-c:v",
                "libx264",
                "-preset",
                "medium",
                "-crf",
                "20",
                "-pix_fmt",
                "yuv420p",
                "-c:a",
                "copy",
                "-movflags",
                "+faststart",
                str(temporary),
            ],
            capture_output=True,
            text=True,
        )
        if completed.returncode:
            missing_overlay = "No such filter" in completed.stderr or "Filter not found" in completed.stderr
            if not missing_overlay:
                raise RuntimeError(f"Failed to render watermark: {completed.stderr[-2000:]}")
            _opencv_watermark_fallback(
                source,
                badge_path,
                temporary,
                position=str(config.get("position") or "bottom_right"),
                moving=config.get("motion") == "moving",
                ffmpeg_path=ffmpeg_path,
            )
        os.replace(temporary, source)
        stat = source.stat()
        VideoCoverService._write_json_atomic(
            marker_path,
            {
                "fingerprint": fingerprint,
                "size_bytes": stat.st_size,
                "mtime_ns": stat.st_mtime_ns,
            },
        )
        return str(source)
    finally:
        temporary.unlink(missing_ok=True)
        badge_path.unlink(missing_ok=True)


def _render_watermark_badge(
    text: str,
    output: Path,
    *,
    frame_width: int,
    frame_height: int,
    opacity: float,
) -> None:
    """Create a compact transparent text badge using Pillow."""
    label = text.strip()
    if not label:
        raise ValueError("watermark text cannot be empty")
    font_size = max(18, min(frame_width, frame_height) // 36)
    max_width = max(120, int(frame_width * 0.52))
    while font_size > 14:
        font = VideoCoverService._font(font_size)
        bounds = font.getbbox(label)
        if bounds[2] - bounds[0] <= max_width:
            break
        font_size -= 2
    font = VideoCoverService._font(font_size)
    bounds = font.getbbox(label)
    text_width = max(1, bounds[2] - bounds[0])
    text_height = max(1, bounds[3] - bounds[1])
    padding_x = max(12, font_size // 2)
    padding_y = max(8, font_size // 3)
    badge = Image.new(
        "RGBA",
        (text_width + padding_x * 2, text_height + padding_y * 2),
        (0, 0, 0, 0),
    )
    draw = ImageDraw.Draw(badge, "RGBA")
    alpha = max(1, round(255 * opacity))
    draw.rounded_rectangle(
        (0, 0, badge.width - 1, badge.height - 1),
        radius=max(8, badge.height // 3),
        fill=(5, 8, 12, min(170, alpha)),
        outline=(255, 255, 255, min(95, alpha)),
        width=max(1, badge.height // 28),
    )
    draw.text(
        (padding_x - bounds[0], padding_y - bounds[1]),
        label,
        font=font,
        fill=(255, 255, 255, alpha),
    )
    badge.save(output, format="PNG", optimize=True)


def _watermark_overlay_position(position: str, *, moving: bool) -> tuple[str, str]:
    if moving:
        return (
            "(W-w)*(0.5+0.42*sin(t/3.1))",
            "(H-h)*(0.5+0.42*cos(t/4.3))",
        )
    margin = "max(24,H/40)"
    positions = {
        "top_left": (margin, margin),
        "top_center": ("(W-w)/2", margin),
        "top_right": (f"W-w-{margin}", margin),
        "center_left": (margin, "(H-h)/2"),
        "center": ("(W-w)/2", "(H-h)/2"),
        "center_right": (f"W-w-{margin}", "(H-h)/2"),
        "bottom_left": (margin, f"H-h-{margin}"),
        "bottom_center": ("(W-w)/2", f"H-h-{margin}"),
        "bottom_right": (f"W-w-{margin}", f"H-h-{margin}"),
    }
    return positions.get(position, positions["bottom_right"])


def _opencv_watermark_fallback(
    source: Path,
    badge_path: Path,
    output: Path,
    *,
    position: str,
    moving: bool,
    ffmpeg_path: str,
) -> None:
    """Burn the badge frame-by-frame when FFmpeg lacks the overlay filter."""
    import cv2
    import numpy as np

    capture = cv2.VideoCapture(str(source))
    width = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT))
    fps = capture.get(cv2.CAP_PROP_FPS) or 30.0
    frame_count = max(1, int(capture.get(cv2.CAP_PROP_FRAME_COUNT)))
    silent = output.with_name(f".{output.stem}.silent-{uuid.uuid4().hex}.mp4")
    writer = cv2.VideoWriter(
        str(silent),
        cv2.VideoWriter_fourcc(*"mp4v"),
        fps,
        (width, height),
    )
    if not capture.isOpened() or not writer.isOpened():
        capture.release()
        writer.release()
        raise RuntimeError("OpenCV watermark fallback could not open the video")
    badge = cv2.imread(str(badge_path), cv2.IMREAD_UNCHANGED)
    if badge is None or badge.shape[2] != 4:
        capture.release()
        writer.release()
        raise RuntimeError("OpenCV watermark fallback could not read the badge")
    try:
        index = 0
        while True:
            ok, frame = capture.read()
            if not ok:
                break
            x, y = _watermark_pixel_position(
                position,
                width,
                height,
                badge.shape[1],
                badge.shape[0],
                progress=index / max(frame_count - 1, 1),
                moving=moving,
            )
            alpha = badge[:, :, 3:4].astype(np.float32) / 255.0
            region = frame[y : y + badge.shape[0], x : x + badge.shape[1]].astype(np.float32)
            frame[y : y + badge.shape[0], x : x + badge.shape[1]] = (
                badge[:, :, :3].astype(np.float32) * alpha + region * (1 - alpha)
            ).astype(np.uint8)
            writer.write(frame)
            index += 1
    finally:
        capture.release()
        writer.release()
    try:
        completed = subprocess.run(
            [
                ffmpeg_path,
                "-hide_banner",
                "-loglevel",
                "error",
                "-y",
                "-i",
                str(silent),
                "-i",
                str(source),
                "-map",
                "0:v:0",
                "-map",
                "1:a?",
                "-map_metadata",
                "1",
                "-c:v",
                "copy",
                "-c:a",
                "copy",
                "-movflags",
                "+faststart",
                str(output),
            ],
            capture_output=True,
            text=True,
        )
        if completed.returncode:
            raise RuntimeError(f"Failed to remux fallback watermark video: {completed.stderr[-2000:]}")
    finally:
        silent.unlink(missing_ok=True)


def _watermark_pixel_position(
    position: str,
    width: int,
    height: int,
    badge_width: int,
    badge_height: int,
    *,
    progress: float,
    moving: bool,
) -> tuple[int, int]:
    margin = max(24, height // 40)
    if moving:
        x = round((width - badge_width) * (0.08 + 0.84 * progress))
        y = round((height - badge_height) * (0.5 + 0.38 * math.sin(progress * math.tau)))
        return max(0, min(x, width - badge_width)), max(0, min(y, height - badge_height))
    horizontal = {
        "left": margin,
        "center": (width - badge_width) // 2,
        "right": width - badge_width - margin,
    }
    vertical = {
        "top": margin,
        "center": (height - badge_height) // 2,
        "bottom": height - badge_height - margin,
    }
    row, _, column = position.partition("_")
    if position == "center":
        row = column = "center"
    return horizontal.get(column, horizontal["right"]), vertical.get(row, vertical["bottom"])
