"""Deterministic focal-point detection and safe cover-crop geometry."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from PIL import Image, ImageFilter


@dataclass(frozen=True)
class FocalPoint:
    """Normalized subject anchor frozen into a storyboard scene."""

    x: float
    y: float
    confidence: float
    source: str = "local_saliency_v1"


@dataclass(frozen=True)
class CoverCrop:
    """Pixel crop after aspect-fill scaling plus the anchor inside the crop."""

    scaled_width: int
    scaled_height: int
    crop_x: int
    crop_y: int
    focus_x: float
    focus_y: float


def clamp_focus(value: float | None) -> float:
    """Clamp normalized focus values while accepting old missing metadata."""

    return min(max(float(value if value is not None else 0.5), 0.0), 1.0)


def detect_focal_point(image_path: str | Path) -> FocalPoint:
    """Estimate a subject anchor from high-frequency visual saliency.

    The detector intentionally has no model/network dependency. It downsamples the
    image, finds strong interior edges and calculates their weighted centroid. A
    gentle centre prior avoids chasing compression noise without forcing an
    off-centre subject back to the middle.
    """

    path = Path(image_path)
    with Image.open(path) as source:
        image = source.convert("L")
        image.thumbnail((192, 192), Image.Resampling.LANCZOS)
        edges = image.filter(ImageFilter.FIND_EDGES)

    width, height = edges.size
    if width < 5 or height < 5:
        return FocalPoint(0.5, 0.5, 0.0, "center_fallback")

    pixels = list(edges.getdata())
    interior = [
        pixels[y * width + x]
        for y in range(2, height - 2)
        for x in range(2, width - 2)
    ]
    if not interior or max(interior) <= 2:
        return FocalPoint(0.5, 0.5, 0.0, "center_fallback")

    ordered = sorted(interior)
    threshold = max(ordered[int((len(ordered) - 1) * 0.82)], 6)
    weighted_x = weighted_y = total = 0.0
    salient_pixels = 0
    for y in range(2, height - 2):
        ny = y / max(height - 1, 1)
        for x in range(2, width - 2):
            value = pixels[y * width + x]
            if value < threshold:
                continue
            nx = x / max(width - 1, 1)
            centre_distance = min(((nx - 0.5) ** 2 + (ny - 0.5) ** 2) ** 0.5, 0.71)
            centre_prior = 1.0 - 0.22 * (centre_distance / 0.71)
            weight = (value - threshold + 1) * centre_prior
            weighted_x += nx * weight
            weighted_y += ny * weight
            total += weight
            salient_pixels += 1

    if total <= 0 or salient_pixels < 4:
        return FocalPoint(0.5, 0.5, 0.0, "center_fallback")

    coverage = salient_pixels / max(len(interior), 1)
    strength = sum(value for value in interior if value >= threshold) / (
        max(salient_pixels, 1) * 255
    )
    confidence = min(max(strength * (1.0 - min(coverage, 0.5)), 0.05), 1.0)
    return FocalPoint(
        round(clamp_focus(weighted_x / total), 6),
        round(clamp_focus(weighted_y / total), 6),
        round(confidence, 6),
    )


def cover_crop(
    source_width: int,
    source_height: int,
    target_width: int,
    target_height: int,
    focus_x: float | None,
    focus_y: float | None,
) -> CoverCrop:
    """Calculate an aspect-fill crop that keeps the focal anchor visible."""

    if min(source_width, source_height, target_width, target_height) <= 0:
        raise ValueError("Crop dimensions must be positive")
    scale = max(target_width / source_width, target_height / source_height)
    scaled_width = max(round(source_width * scale), target_width)
    scaled_height = max(round(source_height * scale), target_height)
    anchor_x = clamp_focus(focus_x) * scaled_width
    anchor_y = clamp_focus(focus_y) * scaled_height
    crop_x = round(min(max(anchor_x - target_width / 2, 0), scaled_width - target_width))
    crop_y = round(min(max(anchor_y - target_height / 2, 0), scaled_height - target_height))
    local_x = clamp_focus((anchor_x - crop_x) / target_width)
    local_y = clamp_focus((anchor_y - crop_y) / target_height)
    return CoverCrop(
        scaled_width=scaled_width,
        scaled_height=scaled_height,
        crop_x=crop_x,
        crop_y=crop_y,
        focus_x=round(local_x, 6),
        focus_y=round(local_y, 6),
    )
