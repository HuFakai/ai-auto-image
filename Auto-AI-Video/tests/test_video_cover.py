from pathlib import Path
from types import SimpleNamespace

from PIL import Image

from pixelle_video.services.video_cover import (
    COVER_DURATION,
    VideoCoverService,
    apply_text_watermark,
)


def test_cover_and_marked_output_are_reused_on_retry(tmp_path: Path, monkeypatch):
    media = tmp_path / "scene.png"
    Image.new("RGB", (160, 240), (28, 88, 150)).save(media)
    video = tmp_path / "final.mp4"
    video.write_bytes(b"raw-video")
    state = {"comment": None, "duration": 5.0, "prepends": 0}

    def probe(_path):
        return {
            "width": 180,
            "height": 320,
            "fps": 25.0,
            "duration": state["duration"],
            "has_audio": True,
            "comment": state["comment"],
        }

    def prepend(_video, _cover, output, **options):
        state["prepends"] += 1
        state["comment"] = options["marker"]
        state["duration"] += options["duration"]
        output.write_bytes(b"covered-video")

    service = VideoCoverService()
    monkeypatch.setattr(service, "_probe_video", probe)
    monkeypatch.setattr(service, "_prepend", prepend)

    first = service.ensure(
        video_path=video,
        task_dir=tmp_path,
        title="被设计的封面标题",
        media_paths=[media],
    )
    assert Path(first.cover_path).is_file()
    assert Image.open(first.cover_path).size == (180, 320)
    assert first.duration == 5.0 + COVER_DURATION
    assert first.reused_output is False
    assert state["prepends"] == 1

    monkeypatch.setattr(
        service,
        "_render_cover",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("cover regenerated")),
    )
    second = service.ensure(
        video_path=video,
        task_dir=tmp_path,
        title="被设计的封面标题",
        media_paths=[media],
    )
    assert second.reused_cover is True
    assert second.reused_output is True
    assert state["prepends"] == 1


def test_prepend_concatenates_silence_and_main_audio_without_retiming(
    tmp_path: Path,
    monkeypatch,
):
    calls = []
    monkeypatch.setattr("pixelle_video.services.video_cover.which_ffmpeg", lambda: "/ffmpeg")
    monkeypatch.setattr(
        "pixelle_video.services.video_cover.subprocess.run",
        lambda command, **kwargs: calls.append((command, kwargs)),
    )

    VideoCoverService._prepend(
        tmp_path / "main.mp4",
        tmp_path / "cover.png",
        tmp_path / "out.mp4",
        width=1080,
        height=1920,
        fps=30,
        duration=COVER_DURATION,
        marker="pixelle-video-cover-v1:test",
        has_audio=True,
        main_duration=8,
    )

    command, options = calls[0]
    filters = command[command.index("-filter_complex") + 1]
    assert "[1:a]aresample=48000" in filters
    assert "[coverv][covera][mainv][maina]concat=n=2:v=1:a=1" in filters
    assert "adelay" not in filters
    assert "-metadata" in command
    assert "comment=pixelle-video-cover-v1:test" in command
    assert options["check"] is True


def test_watermark_uses_pillow_badge_and_overlay_without_drawtext(
    tmp_path: Path,
    monkeypatch,
):
    source = tmp_path / "final.mp4"
    source.write_bytes(b"video-before-watermark")
    calls: list[list[str]] = []

    monkeypatch.setattr(
        VideoCoverService,
        "_probe_video",
        staticmethod(lambda _path: {"width": 180, "height": 320}),
    )
    monkeypatch.setattr(
        "pixelle_video.services.video_cover.which_ffmpeg",
        lambda: "/ffmpeg",
    )

    def run(command, **_kwargs):
        calls.append(command)
        Path(command[-1]).write_bytes(b"video-after-watermark")
        return SimpleNamespace(returncode=0, stderr="")

    monkeypatch.setattr("pixelle_video.services.video_cover.subprocess.run", run)

    result = apply_text_watermark(
        source,
        {
            "enabled": True,
            "text": "一分钟科普",
            "motion": "fixed",
            "position": "bottom_right",
            "opacity": 0.5,
        },
    )

    assert result == str(source.resolve())
    assert source.read_bytes() == b"video-after-watermark"
    command = calls[0]
    filter_graph = command[command.index("-filter_complex") + 1]
    assert "overlay=" in filter_graph
    assert "drawtext" not in filter_graph
    assert "-map_metadata" in command
