"""Integration coverage for the native image + HTML video renderer."""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import ffmpeg
import pytest
from PIL import Image, ImageDraw

from pixelle_video.services.video import VideoService

pytestmark = pytest.mark.skipif(
    not shutil.which("ffmpeg") or not shutil.which("ffprobe"),
    reason="FFmpeg is required for native renderer integration tests",
)


def _run_ffmpeg(*args: str) -> None:
    subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", *args],
        check=True,
        capture_output=True,
        text=True,
    )


def _make_image(path: Path, color: str) -> None:
    _run_ffmpeg(
        "-f",
        "lavfi",
        "-i",
        f"color=c={color}:s=160x284:d=0.1",
        "-frames:v",
        "1",
        str(path),
    )


def _make_audio(path: Path, frequency: int) -> None:
    _run_ffmpeg(
        "-f",
        "lavfi",
        "-i",
        f"sine=frequency={frequency}:sample_rate=44100:duration=1",
        str(path),
    )


def _duration(path: Path) -> float:
    return float(ffmpeg.probe(str(path))["format"]["duration"])


def _pixel_at(video: Path, timestamp: float, output: Path) -> tuple[int, int, int]:
    _run_ffmpeg(
        "-ss",
        f"{timestamp:.3f}",
        "-i",
        str(video),
        "-frames:v",
        "1",
        str(output),
    )
    with Image.open(output).convert("RGB") as image:
        return image.getpixel((image.width // 2, image.height // 2))


def _green_bbox(path: Path):
    with Image.open(path).convert("RGB") as image:
        mask = Image.new("1", image.size)
        mask.putdata(
            [
                green > 180 and red < 80 and blue < 80
                for red, green, blue in image.getdata()
            ]
        )
        return mask.getbbox()


def test_image_motion_and_crossfade_produce_playable_video(tmp_path: Path):
    service = VideoService()
    first_image = tmp_path / "first.png"
    second_image = tmp_path / "second.png"
    third_image = tmp_path / "third.png"
    first_audio = tmp_path / "first.wav"
    second_audio = tmp_path / "second.wav"
    third_audio = tmp_path / "third.wav"
    first_clip = tmp_path / "first.mp4"
    second_clip = tmp_path / "second.mp4"
    third_clip = tmp_path / "third.mp4"
    output = tmp_path / "crossfade.mp4"

    _make_image(first_image, "#d8ff45")
    _make_image(second_image, "#111111")
    _make_image(third_image, "#4455dd")
    _make_audio(first_audio, 440)
    _make_audio(second_audio, 660)
    _make_audio(third_audio, 880)

    service.create_video_from_image(
        str(first_image),
        str(first_audio),
        str(first_clip),
        fps=15,
        motion="ken_burns",
    )
    service.create_video_from_image(
        str(second_image),
        str(second_audio),
        str(second_clip),
        fps=15,
        motion="slow_pan",
    )
    service.create_video_from_image(
        str(third_image),
        str(third_audio),
        str(third_clip),
        fps=15,
        motion="push_in",
    )
    service.concat_videos(
        [str(first_clip), str(second_clip), str(third_clip)],
        str(output),
        transition=["slide_left", "dissolve"],
        transition_duration=[0.2, 0.25],
    )

    probe = ffmpeg.probe(str(output))
    streams = {stream["codec_type"] for stream in probe["streams"]}
    assert streams == {"audio", "video"}
    assert abs(_duration(output) - 3) <= 0.1
    video = next(stream for stream in probe["streams"] if stream["codec_type"] == "video")
    assert (int(video["width"]), int(video["height"])) == (160, 284)

    # The first narration runs to 1.0s. Its visual must remain intact at 0.9s;
    # the transition may only begin once the second narration starts.
    before_boundary = _pixel_at(output, 0.9, tmp_path / "before-boundary.png")
    during_transition = _pixel_at(output, 1.1, tmp_path / "during-transition.png")
    assert before_boundary[1] > 220
    assert during_transition[1] < before_boundary[1] - 35

    mixed_output = tmp_path / "mixed.mp4"
    service.concat_videos(
        [str(first_clip), str(second_clip), str(third_clip)],
        str(mixed_output),
        transition=["none", "crossfade"],
        transition_duration=[0, 0.2],
    )
    assert abs(_duration(mixed_output) - 3) <= 0.1


def test_audio_merge_removes_task_scoped_padding_file(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("PIXELLE_VIDEO_ROOT", str(tmp_path))
    source = tmp_path / "output" / "merge-task" / "frames" / "source.mp4"
    audio = tmp_path / "voice.wav"
    output = source.with_name("merged.mp4")
    source.parent.mkdir(parents=True)
    _run_ffmpeg(
        "-f",
        "lavfi",
        "-i",
        "color=c=#222222:s=160x284:d=0.35",
        "-an",
        str(source),
    )
    _make_audio(audio, 440)

    VideoService().merge_audio_video(str(source), str(audio), str(output))

    assert output.is_file()
    assert not (tmp_path / "temp" / "merge-task").exists()


def test_transparent_html_layer_stays_fixed_over_moving_background(tmp_path: Path):
    source = tmp_path / "pattern.png"
    overlay = tmp_path / "overlay.png"
    audio = tmp_path / "audio.wav"
    output = tmp_path / "layered.mp4"
    early = tmp_path / "early.png"
    late = tmp_path / "late.png"

    pattern = Image.new("RGB", (160, 284))
    pixels = pattern.load()
    for x in range(160):
        color = (240, 40, 40) if (x // 4) % 2 == 0 else (40, 40, 240)
        for y in range(284):
            pixels[x, y] = color
    pattern.save(source)
    transparent = Image.new("RGBA", (160, 284), (0, 0, 0, 0))
    ImageDraw.Draw(transparent).rectangle((62, 112, 98, 148), fill=(0, 255, 0, 255))
    transparent.save(overlay)
    _make_audio(audio, 520)

    VideoService().create_video_from_image(
        str(source),
        str(audio),
        str(output),
        fps=15,
        motion="slow_pan",
        overlay=str(overlay),
    )
    _run_ffmpeg("-ss", "0.1", "-i", str(output), "-frames:v", "1", str(early))
    _run_ffmpeg("-ss", "0.8", "-i", str(output), "-frames:v", "1", str(late))

    assert _green_bbox(early) == _green_bbox(late)
    assert _green_bbox(early) is not None
    with Image.open(early).convert("RGB") as first, Image.open(late).convert("RGB") as last:
        assert first.crop((0, 0, 50, 100)).tobytes() != last.crop(
            (0, 0, 50, 100)
        ).tobytes()


def test_focus_anchor_keeps_off_centre_subject_after_vertical_crop(tmp_path: Path):
    source = tmp_path / "wide-subject.png"
    overlay = tmp_path / "vertical-overlay.png"
    audio = tmp_path / "audio.wav"
    output = tmp_path / "focused.mp4"
    snapshot = tmp_path / "focused.png"
    image = Image.new("RGB", (320, 180), "#202020")
    ImageDraw.Draw(image).rectangle((258, 55, 305, 135), fill="#00ff00")
    image.save(source)
    Image.new("RGBA", (160, 284), (0, 0, 0, 0)).save(overlay)
    _make_audio(audio, 440)

    VideoService().create_video_from_image(
        str(source),
        str(audio),
        str(output),
        fps=15,
        motion="push_in",
        overlay=str(overlay),
        focus_x=0.88,
        focus_y=0.52,
    )
    _run_ffmpeg("-ss", "0.5", "-i", str(output), "-frames:v", "1", str(snapshot))

    assert _green_bbox(snapshot) is not None
