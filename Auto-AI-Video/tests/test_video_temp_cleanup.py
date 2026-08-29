from pathlib import Path

from pixelle_video.services.video import VideoService, prune_stale_video_temp_media


def test_compositor_temp_media_is_task_scoped_and_removed(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("PIXELLE_VIDEO_ROOT", str(tmp_path))
    source = tmp_path / "output" / "video-task" / "frames" / "01_video.mp4"
    source.parent.mkdir(parents=True)
    source.write_bytes(b"source")

    service = VideoService()
    temporary = Path(service._get_unique_temp_path("padded", str(source)))

    assert temporary.parent == tmp_path / "temp" / "video-task"
    temporary.write_bytes(b"temporary")
    service._cleanup_temp_media(str(temporary))

    assert not temporary.exists()
    assert not temporary.parent.exists()


def test_startup_prune_only_removes_compositor_owned_temp_media(
    tmp_path: Path, monkeypatch
):
    monkeypatch.setenv("PIXELLE_VIDEO_ROOT", str(tmp_path))
    temp_root = tmp_path / "temp"
    scoped = temp_root / "interrupted-task"
    scoped.mkdir(parents=True)
    flat = temp_root / "padded_1234abcd_scene.mp4"
    nested = scoped / "trimmed_abcdef12_scene.mp4"
    preserved = temp_root / "keep-me.txt"
    flat.write_bytes(b"flat")
    nested.write_bytes(b"nested")
    preserved.write_bytes(b"user")

    result = prune_stale_video_temp_media()

    assert result == {
        "files": 2,
        "directories": 1,
        "bytes": 10,
        "skipped": [],
    }
    assert not flat.exists()
    assert not scoped.exists()
    assert preserved.read_bytes() == b"user"
