import os
from pathlib import Path

from pixelle_video.utils import os_util


def test_local_ffmpeg_pair_wins_when_path_has_ffmpeg_without_ffprobe(
    tmp_path: Path, monkeypatch
):
    suffix = ".exe" if os.name == "nt" else ""
    system_bin = tmp_path / "system-bin"
    system_bin.mkdir()
    (system_bin / f"ffmpeg{suffix}").touch(mode=0o755)
    local_bin = tmp_path / ".windows-tools" / "ffmpeg" / "bin"
    local_bin.mkdir(parents=True)
    (local_bin / f"ffmpeg{suffix}").touch(mode=0o755)
    (local_bin / f"ffprobe{suffix}").touch(mode=0o755)

    monkeypatch.setenv("PIXELLE_VIDEO_ROOT", str(tmp_path))
    monkeypatch.setenv("PATH", str(system_bin))
    if os.name == "nt":
        monkeypatch.setenv("PATHEXT", ".EXE")

    os_util.ensure_local_ffmpeg_on_path()

    assert Path(os.environ["PATH"].split(os.pathsep)[0]) == local_bin
    assert Path(os_util.which_ffmpeg()).parent == local_bin
    assert Path(os_util.which_ffprobe()).parent == local_bin
