"""Automatic technical quality checks for completed production videos."""

from __future__ import annotations

import json
import re
import subprocess
from pathlib import Path
from typing import Any

from pixelle_video.utils.os_util import which_ffmpeg, which_ffprobe


def inspect_video(
    video_path: str | Path,
    expected_duration: float | None = None,
    deep: bool = True,
) -> list[dict[str, Any]]:
    """Return durable pass/warn/fail checks without raising on broken media."""
    path = Path(video_path).expanduser().resolve()
    checks: list[dict[str, Any]] = []
    if not path.is_file():
        return [_check("file", "fail", {"path": str(path), "reason": "missing"})]
    checks.append(
        _check("file", "pass", {"path": str(path), "size_bytes": path.stat().st_size})
    )
    ffprobe = which_ffprobe()
    if not ffprobe:
        return checks + [_check("ffprobe", "warn", {"reason": "ffprobe unavailable"})]
    try:
        completed = subprocess.run(
            [
                ffprobe,
                "-v",
                "error",
                "-show_streams",
                "-show_format",
                "-of",
                "json",
                str(path),
            ],
            capture_output=True,
            text=True,
            timeout=30,
            check=True,
        )
        probe = json.loads(completed.stdout)
    except (subprocess.SubprocessError, json.JSONDecodeError) as exc:
        return checks + [_check("ffprobe", "fail", {"reason": str(exc)})]

    streams = probe.get("streams") or []
    video = next((item for item in streams if item.get("codec_type") == "video"), None)
    audio = next((item for item in streams if item.get("codec_type") == "audio"), None)
    if not video:
        checks.append(_check("video_stream", "fail", {"reason": "missing"}))
    else:
        width, height = int(video.get("width") or 0), int(video.get("height") or 0)
        checks.extend(
            [
                _check(
                    "video_codec",
                    "pass" if video.get("codec_name") == "h264" else "warn",
                    {"codec": video.get("codec_name")},
                ),
                _check(
                    "vertical_resolution",
                    "pass" if height > width and width >= 720 else "warn",
                    {"width": width, "height": height},
                ),
                _check(
                    "frame_rate",
                    "pass" if _rate(video.get("avg_frame_rate")) >= 24 else "warn",
                    {"fps": _rate(video.get("avg_frame_rate"))},
                ),
            ]
        )
    checks.append(
        _check(
            "audio_stream",
            "pass" if audio and audio.get("codec_name") == "aac" else "fail",
            {"codec": audio.get("codec_name") if audio else None},
        )
    )
    duration = float((probe.get("format") or {}).get("duration") or 0)
    duration_ok = duration > 0 and (
        expected_duration is None or abs(duration - expected_duration) <= 2.0
    )
    checks.append(
        _check(
            "duration",
            "pass" if duration_ok else "warn",
            {"seconds": duration, "expected_seconds": expected_duration},
        )
    )
    if deep and which_ffmpeg():
        checks.extend(_inspect_signal(path))
    return checks


def inspect_subtitle_layout(frames: list[dict[str, Any]]) -> dict[str, Any]:
    """Verify measured subtitle boxes against the vertical-platform safe area."""
    measured: list[dict[str, Any]] = []
    missing: list[int] = []
    violations: list[int] = []
    adjusted: list[int] = []
    for offset, frame in enumerate(frames):
        position = int(frame.get("index", offset)) + 1
        composed_path = frame.get("composed_image_path") or frame.get("overlay_path")
        if not composed_path:
            missing.append(position)
            continue
        layout_path = Path(composed_path).with_suffix(".layout.json")
        if not layout_path.is_file():
            missing.append(position)
            continue
        try:
            layout = json.loads(layout_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            missing.append(position)
            continue
        subtitles = [
            element
            for element in layout.get("elements") or []
            if element.get("kind") == "subtitle"
        ]
        if not subtitles:
            missing.append(position)
            continue
        measured.append({"scene": position, "layout_path": str(layout_path)})
        if any(element.get("adjusted") for element in subtitles):
            adjusted.append(position)
        if any(not element.get("in_safe_area") for element in subtitles):
            violations.append(position)

    if violations:
        status = "fail"
    elif missing:
        status = "warn"
    else:
        status = "pass"
    return _check(
        "subtitle_safe_area",
        status,
        {
            "measured_scenes": [item["scene"] for item in measured],
            "adjusted_scenes": adjusted,
            "missing_layout_scenes": missing,
            "affected_scenes": violations,
            "repair_scope": "composition",
        },
    )


def build_quality_repair_plan(revision: dict[str, Any]) -> dict[str, Any]:
    """Map failed quality checks to the smallest reusable scene pipeline step."""
    scenes = revision.get("scenes") or []
    all_scenes = [int(scene["position"]) + 1 for scene in scenes]
    locked_scenes = {
        int(scene["position"]) + 1 for scene in scenes if bool(scene.get("locked"))
    }
    scope_by_scene: dict[int, str] = {}
    checks_by_scene: dict[int, set[str]] = {}
    manual_checks: list[str] = []
    mapping = {
        "audio_stream": "voice",
        "audio_level": "voice",
        "peak_level": "voice",
        "integrated_loudness": "voice",
        "silence_anomaly": "voice",
        "voice_masking": "voice",
        "black_frames": "visual",
        "frozen_frames": "visual",
        "subtitle_safe_area": "composition",
        "file": "composition",
        "ffprobe": "composition",
        "video_stream": "composition",
        "video_codec": "composition",
        "vertical_resolution": "composition",
        "frame_rate": "composition",
        "duration": "composition",
        "signal_analysis": "composition",
    }
    for check in revision.get("quality_checks") or []:
        if check.get("status") != "fail":
            continue
        name = str(check.get("check_name") or check.get("name") or "unknown")
        scope = mapping.get(name)
        if not scope:
            manual_checks.append(name)
            continue
        detail = check.get("detail") or {}
        affected = detail.get("affected_scenes") or all_scenes
        for position in affected:
            scene = int(position)
            if scene in locked_scenes:
                continue
            scope_by_scene[scene] = _merge_repair_scope(scope_by_scene.get(scene), scope)
            checks_by_scene.setdefault(scene, set()).add(name)

    steps = []
    for scope in ("composition", "voice", "visual", "full"):
        scenes = sorted(scene for scene, value in scope_by_scene.items() if value == scope)
        if scenes:
            steps.append(
                {
                    "scope": scope,
                    "scenes": scenes,
                    "checks": sorted(
                        {name for scene in scenes for name in checks_by_scene.get(scene, set())}
                    ),
                }
            )
    return {
        "source_revision_id": revision.get("id"),
        "steps": steps,
        "manual_checks": sorted(set(manual_checks)),
        "locked_scenes": sorted(locked_scenes),
    }


def _merge_repair_scope(current: str | None, incoming: str) -> str:
    if not current or current == incoming:
        return incoming
    if "full" in {current, incoming}:
        return "full"
    if {current, incoming} == {"voice", "visual"}:
        return "full"
    return incoming if current == "composition" else current


def _inspect_signal(path: Path) -> list[dict[str, Any]]:
    ffmpeg = which_ffmpeg()
    assert ffmpeg is not None
    try:
        volume = subprocess.run(
            [ffmpeg, "-hide_banner", "-i", str(path), "-af", "volumedetect", "-f", "null", "-"],
            capture_output=True,
            text=True,
            timeout=180,
        )
        volume_log = volume.stderr
        mean_match = re.search(r"mean_volume:\s*(-?inf|-?[\d.]+) dB", volume_log)
        max_match = re.search(r"max_volume:\s*(-?inf|-?[\d.]+) dB", volume_log)
        mean_value = _db(mean_match.group(1)) if mean_match else None
        max_value = _db(max_match.group(1)) if max_match else None
        loudness = subprocess.run(
            [ffmpeg, "-hide_banner", "-i", str(path), "-af", "loudnorm=I=-14:TP=-1.5:LRA=11:print_format=json", "-f", "null", "-"],
            capture_output=True,
            text=True,
            timeout=180,
        )
        lufs_match = re.search(r'"input_i"\s*:\s*"(-?[\d.]+)"', loudness.stderr)
        lufs = float(lufs_match.group(1)) if lufs_match else None
        silence = subprocess.run(
            [ffmpeg, "-hide_banner", "-i", str(path), "-af", "silencedetect=n=-45dB:d=1.5", "-f", "null", "-"],
            capture_output=True,
            text=True,
            timeout=180,
        )
        silence_durations = [float(value) for value in re.findall(r"silence_duration:\s*([\d.]+)", silence.stderr)]
        if max_value is None:
            volume_status = "warn"
        elif max_value == float("-inf"):
            volume_status = "fail"
        elif mean_value is not None and (mean_value < -35 or mean_value > -8):
            volume_status = "warn"
        else:
            volume_status = "pass"
        signal = subprocess.run(
            [
                ffmpeg,
                "-hide_banner",
                "-i",
                str(path),
                "-vf",
                "blackdetect=d=2:pix_th=.10,freezedetect=n=-50dB:d=3",
                "-an",
                "-f",
                "null",
                "-",
            ],
            capture_output=True,
            text=True,
            timeout=180,
        )
        black_durations = [float(value) for value in re.findall(r"black_duration:([\d.]+)", signal.stderr)]
        freeze_durations = [float(value) for value in re.findall(r"freeze_duration:\s*([\d.]+)", signal.stderr)]
        return [
            _check("audio_level", volume_status, {"mean_db": mean_value, "max_db": max_value}),
            _check("peak_level", "fail" if max_value is not None and max_value > -0.1 else "pass", {"peak_db": max_value}),
            _check("integrated_loudness", "pass" if lufs is not None and -18 <= lufs <= -11 else "warn", {"lufs": lufs, "target_lufs": -14}),
            _check("silence_anomaly", "warn" if any(value >= 3 for value in silence_durations) else "pass", {"durations": silence_durations}),
            _check("voice_masking", "warn" if mean_value is not None and max_value is not None and max_value - mean_value < 4 else "pass", {"peak_to_mean_db": None if mean_value is None or max_value is None else round(max_value - mean_value, 2)}),
            _check(
                "black_frames",
                "warn" if black_durations else "pass",
                {"durations": black_durations},
            ),
            _check(
                "frozen_frames",
                "warn" if freeze_durations else "pass",
                {"durations": freeze_durations},
            ),
        ]
    except subprocess.TimeoutExpired:
        return [_check("signal_analysis", "warn", {"reason": "analysis timeout"})]


def _check(name: str, status: str, detail: dict[str, Any]) -> dict[str, Any]:
    return {"name": name, "status": status, "detail": detail}


def _rate(value: str | None) -> float:
    if not value:
        return 0.0
    numerator, _, denominator = value.partition("/")
    try:
        return float(numerator) / float(denominator or 1)
    except (ValueError, ZeroDivisionError):
        return 0.0


def _db(value: str) -> float:
    return float("-inf") if value == "-inf" else float(value)
