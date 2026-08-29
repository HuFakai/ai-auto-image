"""Deterministic local whiteboard drawing renderer.

The implementation follows cs-board's useful invariants—persistent canvas,
ordered reveal, visible hand tracking, and an explicit hold on the completed
artwork—without importing its web service, queue, TTS, or HTML renderer.
"""

from __future__ import annotations

import json
import subprocess
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

import cv2
import numpy as np

from pixelle_video.utils.os_util import which_ffmpeg


@dataclass(frozen=True)
class WhiteboardAnalysis:
    width: int
    height: int
    background_mode: str
    ink_density: float
    path_mode_requested: str
    path_mode_applied: str
    path_points: int
    fallback_reason: str | None = None


class WhiteboardRenderer:
    """Reveal a generated visual as a hand-drawn, narration-length MP4."""

    def __init__(self, repository_root: Path | None = None) -> None:
        self.repository_root = repository_root or Path(__file__).resolve().parents[2]

    def render(
        self,
        *,
        image_path: str | Path,
        output_path: str | Path,
        duration: float,
        width: int,
        height: int,
        fps: int,
        settings: dict[str, Any],
        analysis_path: str | Path | None = None,
    ) -> tuple[str, WhiteboardAnalysis]:
        if duration <= 0:
            raise ValueError("Whiteboard duration must be positive")
        if width < 64 or height < 64 or fps < 1:
            raise ValueError("Whiteboard output dimensions and FPS must be positive")
        image = self._read_image(Path(image_path))
        profile = dict(settings.get("render_profile") or {})
        normalized, background = self._normalize_canvas(image, width, height, profile)
        edge_mask, dark_mode = self._edge_mask(normalized, profile)
        requested = str(profile.get("path_mode") or "skeleton")
        points = self._ordered_points(edge_mask, requested, profile)
        applied = requested
        fallback_reason = None
        if len(points) < 24:
            fallback = str(settings.get("fallback_policy") or "grid")
            if fallback == "fail":
                raise RuntimeError("Whiteboard line analysis found too few drawable points")
            points = self._grid_points(normalized, background)
            applied = fallback
            fallback_reason = "线稿特征不足，已在白板引擎内部改用稳定网格揭示。"
        if not points:
            raise RuntimeError("Whiteboard renderer could not find drawable content")

        analysis = WhiteboardAnalysis(
            width=width,
            height=height,
            background_mode="dark" if dark_mode else "light",
            ink_density=round(float(np.count_nonzero(edge_mask)) / edge_mask.size, 6),
            path_mode_requested=requested,
            path_mode_applied=applied,
            path_points=len(points),
            fallback_reason=fallback_reason,
        )
        if analysis_path:
            target = Path(analysis_path)
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(
                json.dumps(asdict(analysis), ensure_ascii=False, indent=2),
                encoding="utf-8",
            )

        output = Path(output_path)
        output.parent.mkdir(parents=True, exist_ok=True)
        self._encode_frames(
            source=normalized,
            background=background,
            edge_mask=edge_mask,
            points=points,
            output=output,
            duration=duration,
            fps=fps,
            settings=settings,
        )
        if not output.is_file() or output.stat().st_size <= 0:
            raise RuntimeError("Whiteboard renderer did not produce a valid segment")
        return str(output), analysis

    @staticmethod
    def _read_image(path: Path) -> np.ndarray:
        if not path.is_file():
            raise FileNotFoundError(f"Whiteboard source image not found: {path}")
        raw = np.fromfile(str(path), dtype=np.uint8)
        image = cv2.imdecode(raw, cv2.IMREAD_COLOR)
        if image is None:
            raise ValueError(f"Whiteboard source image is invalid: {path}")
        return image

    @staticmethod
    def _normalize_canvas(
        image: np.ndarray,
        width: int,
        height: int,
        profile: dict[str, Any],
    ) -> tuple[np.ndarray, np.ndarray]:
        source_h, source_w = image.shape[:2]
        scale = min(width / source_w, height / source_h)
        target_w = max(2, int(round(source_w * scale)))
        target_h = max(2, int(round(source_h * scale)))
        resized = cv2.resize(image, (target_w, target_h), interpolation=cv2.INTER_AREA)
        corners = np.concatenate(
            [
                resized[: max(2, target_h // 40), : max(2, target_w // 40)].reshape(-1, 3),
                resized[-max(2, target_h // 40) :, -max(2, target_w // 40) :].reshape(-1, 3),
            ]
        )
        background = np.median(corners, axis=0).astype(np.uint8)
        configured = str(profile.get("background_mode") or "auto")
        if configured == "light" and float(np.mean(background)) < 150:
            background = np.array([238, 242, 246], dtype=np.uint8)
        canvas = np.empty((height, width, 3), dtype=np.uint8)
        canvas[...] = background
        x = (width - target_w) // 2
        y = (height - target_h) // 2
        canvas[y : y + target_h, x : x + target_w] = resized
        return canvas, background

    @staticmethod
    def _edge_mask(source: np.ndarray, profile: dict[str, Any]) -> tuple[np.ndarray, bool]:
        gray = cv2.cvtColor(source, cv2.COLOR_BGR2GRAY)
        configured = str(profile.get("background_mode") or "auto")
        corners = np.concatenate(
            [gray[: max(2, gray.shape[0] // 40), :].ravel(), gray[-max(2, gray.shape[0] // 40) :, :].ravel()]
        )
        dark = configured == "dark" or (configured == "auto" and float(np.median(corners)) < 100)
        if dark:
            enhanced = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8)).apply(gray)
            edges = cv2.Canny(enhanced, 28, 92, L2gradient=True)
        else:
            blurred = cv2.GaussianBlur(gray, (5, 5), 0)
            edges = cv2.Canny(blurred, 42, 132, L2gradient=True)
        edges = cv2.morphologyEx(edges, cv2.MORPH_CLOSE, np.ones((3, 3), np.uint8))
        return edges, dark

    @staticmethod
    def _ordered_points(
        edge_mask: np.ndarray,
        path_mode: str,
        profile: dict[str, Any],
    ) -> list[tuple[int, int]]:
        contours, _ = cv2.findContours(edge_mask, cv2.RETR_LIST, cv2.CHAIN_APPROX_NONE)
        contours = [item for item in contours if cv2.arcLength(item, closed=False) >= 18]
        contours.sort(key=lambda item: (cv2.boundingRect(item)[1], cv2.boundingRect(item)[0]))
        limits = {"light": 28, "standard": 56, "detailed": 96, "full": 0}
        limit = limits.get(str(profile.get("stroke_detail") or "standard"), 56)
        if limit:
            contours = sorted(contours, key=lambda item: cv2.arcLength(item, False), reverse=True)[
                :limit
            ]
            contours.sort(key=lambda item: (cv2.boundingRect(item)[1], cv2.boundingRect(item)[0]))
        points: list[tuple[int, int]] = []
        sample_step = 2 if path_mode == "skeleton" else 4
        for contour in contours:
            raw = contour.reshape(-1, 2)
            if len(raw) < 2:
                continue
            for x, y in raw[::sample_step]:
                points.append((int(x), int(y)))
        return points

    @staticmethod
    def _grid_points(source: np.ndarray, background: np.ndarray) -> list[tuple[int, int]]:
        distance = np.linalg.norm(source.astype(np.int16) - background.astype(np.int16), axis=2)
        active = distance > 24
        height, width = active.shape
        step = max(12, min(width, height) // 48)
        points: list[tuple[int, int]] = []
        for y in range(step // 2, height, step):
            row = range(step // 2, width, step)
            if (y // step) % 2:
                row = reversed(list(row))
            points.extend((x, y) for x in row if active[y, x])
        return points

    def _encode_frames(
        self,
        *,
        source: np.ndarray,
        background: np.ndarray,
        edge_mask: np.ndarray,
        points: list[tuple[int, int]],
        output: Path,
        duration: float,
        fps: int,
        settings: dict[str, Any],
    ) -> None:
        ffmpeg = which_ffmpeg()
        if not ffmpeg:
            raise RuntimeError("ffmpeg is required for whiteboard rendering")
        height, width = source.shape[:2]
        command = [
            ffmpeg,
            "-y",
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "rawvideo",
            "-pix_fmt",
            "bgr24",
            "-s",
            f"{width}x{height}",
            "-r",
            str(fps),
            "-i",
            "-",
            "-an",
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-crf",
            "20",
            "-pix_fmt",
            "yuv420p",
            "-movflags",
            "+faststart",
            str(output),
        ]
        process = subprocess.Popen(command, stdin=subprocess.PIPE, stderr=subprocess.PIPE)
        if process.stdin is None:
            raise RuntimeError("Could not open whiteboard encoder input")
        frame_count = max(1, int(round(duration * fps)))
        draw_end = max(1, int(frame_count * 0.54))
        color_end = max(draw_end + 1, int(frame_count * 0.78))
        revealed = np.zeros((height, width), dtype=np.uint8)
        dilated_edges = cv2.dilate(edge_mask, np.ones((5, 5), np.uint8))
        hand = self._load_hand(height) if settings.get("hand_enabled", True) else None
        last_index = 0
        try:
            for frame_index in range(frame_count):
                if frame_index < draw_end:
                    target_index = max(
                        1, round((frame_index + 1) / draw_end * len(points))
                    )
                    for index in range(last_index, min(target_index, len(points))):
                        x, y = points[index]
                        cv2.circle(revealed, (x, y), max(3, min(width, height) // 160), 255, -1)
                        if index > 0:
                            cv2.line(revealed, points[index - 1], (x, y), 255, 3, cv2.LINE_AA)
                    last_index = target_index
                    mask = cv2.bitwise_and(revealed, dilated_edges)
                    canvas = np.empty_like(source)
                    canvas[...] = background
                    canvas[mask > 0] = source[mask > 0]
                    hand_point = points[min(target_index - 1, len(points) - 1)]
                elif frame_index < color_end:
                    progress = (frame_index - draw_end + 1) / (color_end - draw_end)
                    diagonal = self._diagonal_mask(width, height, progress)
                    canvas = np.empty_like(source)
                    canvas[...] = background
                    canvas[diagonal] = source[diagonal]
                    canvas[dilated_edges > 0] = source[dilated_edges > 0]
                    hand_point = (
                        min(width - 1, int(progress * width)),
                        min(height - 1, int(progress * height)),
                    )
                else:
                    canvas = source.copy()
                    hand_point = None
                if hand is not None and hand_point is not None:
                    self._stamp_hand(canvas, hand, hand_point)
                process.stdin.write(canvas.tobytes())
        finally:
            process.stdin.close()
        stderr = process.stderr.read().decode("utf-8", errors="replace") if process.stderr else ""
        return_code = process.wait()
        if return_code:
            output.unlink(missing_ok=True)
            raise RuntimeError(f"Whiteboard ffmpeg encoding failed: {stderr.strip()}")

    @staticmethod
    def _diagonal_mask(width: int, height: int, progress: float) -> np.ndarray:
        y, x = np.ogrid[:height, :width]
        threshold = progress * (width + height)
        return (x + y) <= threshold

    def _load_hand(self, canvas_height: int) -> np.ndarray | None:
        path = self.repository_root / "assets" / "whiteboard" / "hands" / "default.png"
        raw = np.fromfile(str(path), dtype=np.uint8)
        hand = cv2.imdecode(raw, cv2.IMREAD_UNCHANGED)
        if hand is None or hand.shape[2] != 4:
            return None
        target_height = max(96, round(canvas_height * 0.22))
        scale = target_height / hand.shape[0]
        return cv2.resize(
            hand,
            (max(1, round(hand.shape[1] * scale)), target_height),
            interpolation=cv2.INTER_AREA,
        )

    @staticmethod
    def _stamp_hand(canvas: np.ndarray, hand: np.ndarray, point: tuple[int, int]) -> None:
        height, width = canvas.shape[:2]
        hand_h, hand_w = hand.shape[:2]
        x0 = max(0, min(width, point[0]))
        y0 = max(0, min(height, point[1]))
        x1 = min(width, x0 + hand_w)
        y1 = min(height, y0 + hand_h)
        if x1 <= x0 or y1 <= y0:
            return
        overlay = hand[: y1 - y0, : x1 - x0]
        alpha = overlay[:, :, 3:4].astype(np.float32) / 255.0
        canvas[y0:y1, x0:x1] = (
            overlay[:, :, :3].astype(np.float32) * alpha
            + canvas[y0:y1, x0:x1].astype(np.float32) * (1.0 - alpha)
        ).astype(np.uint8)
