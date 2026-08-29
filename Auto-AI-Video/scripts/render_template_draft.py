#!/usr/bin/env python3
"""Build or render a low-cost HyperFrames template draft without model calls."""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import math
import sys
import wave
from pathlib import Path

from PIL import Image, ImageDraw

PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from pixelle_video.models.storyboard import (  # noqa: E402
    Storyboard,
    StoryboardConfig,
    StoryboardFrame,
)
from pixelle_video.rendering_versions import HYPERFRAMES_RENDERER_VERSION  # noqa: E402
from pixelle_video.services.hyperframes_process import (  # noqa: E402
    hyperframes_process_manager,
)
from pixelle_video.services.hyperframes_project import (  # noqa: E402
    HyperFramesProjectBuilder,
)
from pixelle_video.services.hyperframes_renderer import (  # noqa: E402
    HyperFramesRendererAdapter,
)
from pixelle_video.services.template_packs import TemplatePackRegistry  # noqa: E402

SAMPLE_COPY = {
    "stickman-psychology": (
        "为什么越想停止内耗，脑子反而越停不下来？",
        [
            "先别急着赶走念头。",
            "给它一个名字，再把注意力放回眼前的小行动。",
            "行动会让大脑重新获得可控感。",
        ],
    ),
    "morning-radio": (
        "今天，先完成最重要的一小步",
        [
            "早上好，今天不需要一下子变得更好。",
            "把前十分钟留给自己，慢慢吃完早餐。",
            "选一件真正重要的小事，然后开始。",
        ],
    ),
    "knowledge-card": (
        "为什么高山上的水更容易沸腾？",
        [
            "海拔越高，周围空气压力越低。",
            "水蒸气更容易冲出液面，所以更早达到沸腾条件。",
            "沸点降低，不代表食物会更快熟。",
        ],
    ),
}


def _write_silence(path: Path, duration: float = 2.0, sample_rate: int = 16000) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(sample_rate)
        audio.writeframes(b"\0\0" * int(duration * sample_rate))


def _hex(value: str) -> tuple[int, int, int]:
    value = value.lstrip("#")[:6]
    return tuple(int(value[index : index + 2], 16) for index in (0, 2, 4))


def _write_placeholder(path: Path, category: str, variables: dict[str, object], index: int) -> None:
    width, height = 720, 1280
    surface = _hex(str(variables["surface_color"]))
    accent = _hex(str(variables["accent_color"]))
    image = Image.new("RGB", (width, height), surface)
    draw = ImageDraw.Draw(image)
    if category == "psychology":
        draw.rectangle(
            (42, 42, width - 42, height - 42), fill=(252, 250, 244), outline=(24, 25, 22), width=5
        )
        center_x = width // 2 + (index - 2) * 48
        draw.ellipse((center_x - 55, 255, center_x + 55, 365), outline=(24, 25, 22), width=10)
        draw.line((center_x, 365, center_x, 690), fill=(24, 25, 22), width=12)
        draw.line((center_x, 455, center_x - 145, 565), fill=(24, 25, 22), width=12)
        draw.line((center_x, 455, center_x + 145, 525), fill=(24, 25, 22), width=12)
        draw.line((center_x, 690, center_x - 115, 880), fill=(24, 25, 22), width=12)
        draw.line((center_x, 690, center_x + 125, 875), fill=(24, 25, 22), width=12)
        draw.ellipse((70, 920, 300, 1150), fill=accent)
    elif category == "lifestyle":
        for y in range(height):
            ratio = y / height
            color = tuple(
                round(surface[channel] * ratio + accent[channel] * (1 - ratio))
                for channel in range(3)
            )
            draw.line((0, y, width, y), fill=color)
        sun_x = 170 + index * 110
        draw.ellipse((sun_x - 85, 170, sun_x + 85, 340), fill=(255, 239, 196))
        draw.rectangle((0, 780, width, height), fill=(92, 83, 65))
        draw.rounded_rectangle((125, 690, 595, 1050), radius=42, fill=(205, 177, 136))
        draw.ellipse((265, 740, 455, 930), fill=(245, 235, 214))
    else:
        draw.rectangle((42, 42, width - 42, height - 42), outline=accent, width=4)
        for step in range(8):
            y = 120 + step * 135
            draw.line((75, y, width - 75, y), fill=(45, 57, 51), width=2)
        radius = 145 + index * 25
        draw.ellipse(
            (360 - radius, 500 - radius, 360 + radius, 500 + radius),
            fill=(31, 69, 64),
            outline=accent,
            width=8,
        )
        points = []
        for point in range(6):
            angle = math.pi * 2 * point / 6
            points.append(
                (360 + math.cos(angle) * radius * 0.72, 500 + math.sin(angle) * radius * 0.72)
            )
        draw.line(points + [points[0]], fill=(235, 244, 238), width=8)
    path.parent.mkdir(parents=True, exist_ok=True)
    image.save(path)


async def _run(args: argparse.Namespace) -> dict[str, object]:
    pack = TemplatePackRegistry(PROJECT_ROOT).load(args.template, args.version)
    variables = pack.resolve_variables(json.loads(args.variables or "{}"))
    cache_key = hashlib.sha256(
        json.dumps(
            {"fingerprint": pack.fingerprint, "variables": variables},
            ensure_ascii=False,
            sort_keys=True,
        ).encode("utf-8")
    ).hexdigest()[:16]
    task_dir = (
        PROJECT_ROOT
        / "output"
        / "template-drafts"
        / pack.template_id
        / f"v{pack.version}"
        / cache_key
    )
    final_path = task_dir / "draft.mp4"
    title, narrations = SAMPLE_COPY[pack.template_id]
    frames: list[StoryboardFrame] = []
    for index, narration in enumerate(narrations, start=1):
        image_path = task_dir / "source" / f"scene-{index}.png"
        audio_path = task_dir / "source" / f"scene-{index}.wav"
        _write_placeholder(image_path, pack.category, variables, index)
        _write_silence(audio_path)
        frames.append(
            StoryboardFrame(
                index=index - 1,
                narration=narration,
                image_prompt="local template draft placeholder",
                audio_path=str(audio_path),
                media_type="image",
                image_path=str(image_path),
                duration=2.0,
                image_motion=("push_in", "pan_left", "pull_out")[index - 1],
                transition="none" if index == 1 else "crossfade",
                transition_duration=0.3,
            )
        )
    storyboard = Storyboard(
        title=title,
        config=StoryboardConfig(
            media_width=1024,
            media_height=1536,
            task_id=f"template-draft-{pack.template_id}-v{pack.version}",
            render_engine="hyperframes",
            renderer_version=HYPERFRAMES_RENDERER_VERSION,
            frame_template=pack.native_template,
            video_fps=args.fps,
        ),
        frames=frames,
    )
    build = HyperFramesProjectBuilder(PROJECT_ROOT).build(
        storyboard,
        task_dir,
        template_id=pack.template_id,
        template_version=pack.version,
        template_variables=variables,
    )
    result: dict[str, object] = {
        "template_id": pack.template_id,
        "version": pack.version,
        "fingerprint": pack.fingerprint,
        "variables": variables,
        "project_dir": build.project_dir,
        "model_calls": 0,
    }
    if args.build_only:
        return result
    if final_path.is_file() and final_path.stat().st_size > 0 and not args.force:
        return {**result, "video_path": str(final_path), "cached": True}
    await hyperframes_process_manager.ensure_started()
    adapter = HyperFramesRendererAdapter(render_timeout=args.timeout)
    await adapter.ready()
    submitted = await adapter.submit(
        build.project_dir,
        output_path=str(final_path),
        fps=args.fps,
        quality="draft",
        strictness="strict",
        workers=1,
        use_gpu=args.use_gpu,
    )
    rendered = await adapter.wait(str(submitted["id"]))
    return {
        **result,
        "video_path": rendered.output_path,
        "duration": rendered.duration,
        "size_bytes": rendered.size_bytes,
        "check_report_path": rendered.check_report_path,
        "cached": False,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--template", choices=sorted(SAMPLE_COPY), required=True)
    parser.add_argument("--version", type=int, default=1)
    parser.add_argument("--variables", default="{}", help="JSON variable overrides")
    parser.add_argument("--fps", type=int, choices=(24, 30), default=24)
    parser.add_argument("--timeout", type=float, default=600)
    parser.add_argument("--build-only", action="store_true")
    parser.add_argument("--force", action="store_true")
    parser.add_argument("--use-gpu", action=argparse.BooleanOptionalAction, default=True)
    args = parser.parse_args()
    if args.version < 1:
        parser.error("version must be >= 1")
    print(json.dumps(asyncio.run(_run(args)), ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
