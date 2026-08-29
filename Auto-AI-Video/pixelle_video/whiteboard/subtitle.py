"""Template-independent subtitle overlay for whiteboard mode."""

from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


def render_transparent_canvas(
    output_path: str | Path,
    *,
    width: int,
    height: int,
) -> str:
    output = Path(output_path)
    output.parent.mkdir(parents=True, exist_ok=True)
    Image.new("RGBA", (width, height), (0, 0, 0, 0)).save(output, "PNG")
    return str(output)


def render_whiteboard_subtitle(
    text: str,
    keywords: list[str],
    output_path: str | Path,
    *,
    width: int,
    height: int,
) -> str:
    """Draw a transparent, safe-area subtitle layer without HTML templates."""
    output = Path(output_path)
    output.parent.mkdir(parents=True, exist_ok=True)
    image = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    font = _font(max(32, round(width * 0.052)))
    max_width = round(width * 0.84)
    lines = _wrap_chars(draw, text.strip(), font, max_width)
    line_height = round(font.size * 1.45)
    block_height = max(line_height, len(lines) * line_height)
    y0 = min(round(height * 0.82), height - block_height - round(height * 0.055))
    y0 = max(round(height * 0.66), y0)
    left = round(width * 0.055)
    right = width - left
    padding = round(width * 0.035)
    draw.rounded_rectangle(
        (left, y0 - padding, right, y0 + block_height + padding // 2),
        radius=round(width * 0.028),
        fill=(18, 18, 18, 205),
        outline=(255, 255, 255, 42),
        width=max(1, width // 540),
    )
    keyword_ranges = _keyword_ranges(text, keywords)
    cursor = 0
    for line_index, line in enumerate(lines):
        line_width = draw.textlength(line, font=font)
        x = round((width - line_width) / 2)
        y = y0 + line_index * line_height
        for char in line:
            highlighted = any(start <= cursor < end for start, end in keyword_ranges)
            color = (202, 255, 64, 255) if highlighted else (255, 255, 255, 255)
            draw.text((x, y), char, font=font, fill=color, stroke_width=1, stroke_fill=(0, 0, 0, 220))
            x += draw.textlength(char, font=font)
            cursor += 1
    image.save(output, "PNG")
    return str(output)


def _font(size: int) -> ImageFont.FreeTypeFont:
    candidates = [
        Path("/System/Library/Fonts/PingFang.ttc"),
        Path("/System/Library/Fonts/STHeiti Medium.ttc"),
        Path("/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc"),
        Path("C:/Windows/Fonts/msyh.ttc"),
    ]
    path = next((item for item in candidates if item.is_file()), None)
    if path is None:
        raise RuntimeError("No CJK font is available for whiteboard subtitles")
    return ImageFont.truetype(str(path), size)


def _wrap_chars(
    draw: ImageDraw.ImageDraw,
    text: str,
    font: ImageFont.FreeTypeFont,
    max_width: int,
) -> list[str]:
    lines: list[str] = []
    current = ""
    for char in text:
        candidate = current + char
        if current and draw.textlength(candidate, font=font) > max_width:
            lines.append(current)
            current = char
        else:
            current = candidate
    if current:
        lines.append(current)
    return lines[:3] or [""]


def _keyword_ranges(text: str, keywords: list[str]) -> list[tuple[int, int]]:
    folded = text.casefold()
    ranges: list[tuple[int, int]] = []
    for keyword in keywords:
        token = keyword.strip().casefold()
        if not token:
            continue
        start = 0
        while True:
            index = folded.find(token, start)
            if index < 0:
                break
            ranges.append((index, index + len(token)))
            start = index + len(token)
    return ranges
