"""Channel-level sound presets and the ffmpeg mixing/preview backend."""

from __future__ import annotations

import json
import os
import subprocess
import threading
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from pixelle_video.utils.os_util import which_ffmpeg, which_ffprobe

PRESET_VERSION = 1
DEFAULT_LOUDNESS_TARGET_LUFS = -14.0
SCENE_EMOTIONS = {"neutral", "warm", "excited", "calm", "serious", "playful"}
STEREO_PAN = "pan=stereo|c0=c0|c1=c1"


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


@dataclass(frozen=True)
class SceneVoiceOverride:
    """Per-scene voice overrides (scene is 1-based)."""

    scene: int
    tts_speed: float | None = None
    pause_seconds: float | None = None
    emotion: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "scene": self.scene,
            "tts_speed": self.tts_speed,
            "pause_seconds": self.pause_seconds,
            "emotion": self.emotion,
        }


@dataclass(frozen=True)
class SoundPreset:
    """Audio recipe for one channel, applied as an audio-only redo."""

    channel_id: str
    bgm_path: str | None = None
    bgm_volume: float = 0.2
    bgm_mode: str = "loop"
    intro_path: str | None = None
    intro_volume: float = 1.0
    outro_path: str | None = None
    outro_volume: float = 1.0
    auto_duck: bool = False
    duck_threshold_db: float = -20.0
    duck_reduction_db: float = 8.0
    loudness_target_lufs: float = DEFAULT_LOUDNESS_TARGET_LUFS
    scene_overrides: tuple[SceneVoiceOverride, ...] = field(default_factory=tuple)
    updated_at: str = ""
    voice_volume: float = 1.0

    def to_dict(self) -> dict[str, Any]:
        return {
            "version": PRESET_VERSION,
            "channel_id": self.channel_id,
            "voice_volume": self.voice_volume,
            "bgm_path": self.bgm_path,
            "bgm_volume": self.bgm_volume,
            "bgm_mode": self.bgm_mode,
            "intro_path": self.intro_path,
            "intro_volume": self.intro_volume,
            "outro_path": self.outro_path,
            "outro_volume": self.outro_volume,
            "auto_duck": self.auto_duck,
            "duck_threshold_db": self.duck_threshold_db,
            "duck_reduction_db": self.duck_reduction_db,
            "loudness_target_lufs": self.loudness_target_lufs,
            "scene_overrides": [item.to_dict() for item in self.scene_overrides],
            "updated_at": self.updated_at,
        }

    def override_for(self, scene: int) -> SceneVoiceOverride | None:
        for item in self.scene_overrides:
            if item.scene == scene:
                return item
        return None


def normalize_sound_preset(channel_id: str, raw: dict[str, Any]) -> SoundPreset:
    """Validate and normalize one channel sound preset payload."""
    overrides: list[SceneVoiceOverride] = []
    for item in raw.get("scene_overrides") or []:
        scene = int(item.get("scene") or 0)
        if scene < 1:
            raise ValueError("scene_overrides.scene must be >= 1")
        speed = item.get("tts_speed")
        if speed is not None:
            speed = float(speed)
            if not 0.5 <= speed <= 2.0:
                raise ValueError("scene_overrides.tts_speed must be between 0.5 and 2.0")
        pause = item.get("pause_seconds")
        if pause is not None:
            pause = float(pause)
            if not 0 <= pause <= 10:
                raise ValueError("scene_overrides.pause_seconds must be between 0 and 10")
        emotion = str(item.get("emotion") or "").strip() or None
        if emotion and emotion not in SCENE_EMOTIONS:
            raise ValueError(f"scene_overrides.emotion must be one of {sorted(SCENE_EMOTIONS)}")
        overrides.append(
            SceneVoiceOverride(scene=scene, tts_speed=speed, pause_seconds=pause, emotion=emotion)
        )
    overrides.sort(key=lambda item: item.scene)

    def _path(value: Any) -> str | None:
        text = str(value or "").strip()
        return text or None

    voice_volume = float(
        raw.get("voice_volume") if raw.get("voice_volume") is not None else 1.0
    )
    bgm_volume = float(raw.get("bgm_volume") if raw.get("bgm_volume") is not None else 0.2)
    intro_volume = float(raw.get("intro_volume") if raw.get("intro_volume") is not None else 1.0)
    outro_volume = float(raw.get("outro_volume") if raw.get("outro_volume") is not None else 1.0)
    for name, value in (
        ("voice_volume", voice_volume),
        ("bgm_volume", bgm_volume),
        ("intro_volume", intro_volume),
        ("outro_volume", outro_volume),
    ):
        if not 0 <= value <= 1.5:
            raise ValueError(f"{name} must be between 0 and 1.5")
    mode = str(raw.get("bgm_mode") or "loop")
    if mode not in {"loop", "once"}:
        raise ValueError("bgm_mode must be loop or once")
    threshold = float(raw.get("duck_threshold_db") if raw.get("duck_threshold_db") is not None else -20)
    reduction = float(raw.get("duck_reduction_db") if raw.get("duck_reduction_db") is not None else 8)
    if not -60 <= threshold <= 0:
        raise ValueError("duck_threshold_db must be between -60 and 0")
    if not 1 <= reduction <= 24:
        raise ValueError("duck_reduction_db must be between 1 and 24")
    target = float(
        raw.get("loudness_target_lufs")
        if raw.get("loudness_target_lufs") is not None
        else DEFAULT_LOUDNESS_TARGET_LUFS
    )
    if not -30 <= target <= -9:
        raise ValueError("loudness_target_lufs must be between -30 and -9")
    return SoundPreset(
        channel_id=channel_id,
        voice_volume=voice_volume,
        bgm_path=_path(raw.get("bgm_path")),
        bgm_volume=bgm_volume,
        bgm_mode=mode,
        intro_path=_path(raw.get("intro_path")),
        intro_volume=intro_volume,
        outro_path=_path(raw.get("outro_path")),
        outro_volume=outro_volume,
        auto_duck=bool(raw.get("auto_duck")),
        duck_threshold_db=threshold,
        duck_reduction_db=reduction,
        loudness_target_lufs=target,
        scene_overrides=tuple(overrides),
        updated_at=_utc_now(),
    )


class SoundPresetStore:
    """File-backed channel sound presets (independent of channel YAML)."""

    def __init__(self, presets_dir: str | Path):
        self._dir = Path(presets_dir).expanduser().resolve()
        self._dir.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()

    def _path(self, channel_id: str) -> Path:
        return self._dir / f"{channel_id}.json"

    def load(self, channel_id: str) -> SoundPreset | None:
        path = self._path(channel_id)
        with self._lock:
            try:
                raw = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                return None
        return normalize_sound_preset(channel_id, raw)

    def save(self, preset: SoundPreset, *, validate_audio: bool = True) -> SoundPreset:
        if validate_audio:
            missing = [
                name
                for name in ("bgm_path", "intro_path", "outro_path")
                if getattr(preset, name) and not Path(getattr(preset, name)).is_file()
            ]
            if missing:
                raise ValueError(f"missing audio files: {', '.join(missing)}")
        raw = preset.to_dict()
        raw["updated_at"] = _utc_now()
        stored = normalize_sound_preset(preset.channel_id, raw)
        path = self._path(preset.channel_id)
        temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
        try:
            temporary.write_text(
                json.dumps(stored.to_dict(), ensure_ascii=False, indent=2, sort_keys=True),
                encoding="utf-8",
            )
            os.replace(temporary, path)
        finally:
            temporary.unlink(missing_ok=True)
        return stored

    def delete(self, channel_id: str) -> bool:
        with self._lock:
            try:
                self._path(channel_id).unlink()
                return True
            except FileNotFoundError:
                return False

    def list(self) -> list[SoundPreset]:
        presets: list[SoundPreset] = []
        with self._lock:
            paths = sorted(self._dir.glob("*.json"))
        for path in paths:
            try:
                raw = json.loads(path.read_text(encoding="utf-8"))
                presets.append(normalize_sound_preset(raw.get("channel_id", path.stem), raw))
            except (OSError, json.JSONDecodeError, ValueError):
                continue
        return presets


def probe_audio(path: str | Path) -> dict[str, Any] | None:
    """Lightweight ffprobe metadata for one audio file."""
    ffprobe = which_ffprobe()
    if not ffprobe:
        return None
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
            timeout=20,
            check=True,
        )
        data = json.loads(completed.stdout)
    except (OSError, subprocess.SubprocessError, json.JSONDecodeError):
        return None
    audio = next(
        (item for item in data.get("streams", []) if item.get("codec_type") == "audio"),
        None,
    )
    if not audio:
        return None
    return {
        "path": str(path),
        "codec": audio.get("codec_name"),
        "sample_rate": audio.get("sample_rate"),
        "channels": audio.get("channels"),
        "duration": float((data.get("format") or {}).get("duration") or 0),
    }


def preset_preview_metadata(preset: SoundPreset) -> dict[str, Any]:
    """Return probe metadata and computed estimates for a preset."""
    assets: dict[str, Any] = {}
    for name in ("bgm_path", "intro_path", "outro_path"):
        value = getattr(preset, name)
        if not value:
            assets[name] = {"path": None, "configured": False}
            continue
        probe = probe_audio(value)
        assets[name] = {
            "path": value,
            "configured": True,
            "exists": bool(probe),
            **(probe or {}),
        }
    return {
        "channel_id": preset.channel_id,
        "voice_volume": preset.voice_volume,
        "assets": assets,
        "auto_duck": preset.auto_duck,
        "duck_threshold_db": preset.duck_threshold_db,
        "duck_reduction_db": preset.duck_reduction_db,
        "loudness_target_lufs": preset.loudness_target_lufs,
        "scene_overrides": [item.to_dict() for item in preset.scene_overrides],
        "estimated_bgm_loop_duration": (
            assets["bgm_path"].get("duration") if assets.get("bgm_path") else None
        ),
    }


def apply_sound_preset(
    *,
    video_path: str | Path,
    preset: SoundPreset,
    output_path: str | Path,
    scene_segment_paths: list[str | Path] | None = None,
    scene_pauses: list[float] | None = None,
    cover_duration: float = 1.2,
) -> dict[str, Any]:
    """Audio-only redo: rebuild narration with pauses, mix intro/BGM/outro with
    sidechain ducking, normalize loudness, and remux onto the existing video."""
    ffmpeg = which_ffmpeg()
    ffprobe = which_ffprobe()
    if not ffmpeg or not ffprobe:
        raise RuntimeError("ffmpeg/ffprobe are required for sound mixing")
    video = Path(video_path).expanduser().resolve()
    if not video.is_file():
        raise FileNotFoundError(f"video not found: {video}")
    total_duration = _video_duration(ffprobe, video)
    if total_duration <= 0:
        raise RuntimeError(f"could not read duration of {video}")

    assets = {
        "intro": _resolve_asset(preset.intro_path),
        "bgm": _resolve_asset(preset.bgm_path),
        "outro": _resolve_asset(preset.outro_path),
    }
    missing = [
        name
        for name, path in assets.items()
        if getattr(preset, f"{name}_path") and not path
    ]
    if missing:
        raise ValueError(f"missing configured audio assets: {', '.join(missing)}")

    command: list[str] = [ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-i", str(video)]
    if assets["intro"]:
        command += ["-i", str(assets["intro"])]
    if assets["bgm"]:
        if preset.bgm_mode == "loop":
            command += ["-stream_loop", "-1"]
        command += ["-i", str(assets["bgm"])]
    if assets["outro"]:
        command += ["-i", str(assets["outro"])]

    input_count = command.count("-i")
    intro_index = 1 if assets["intro"] else None
    bgm_index = input_count - 1 - (1 if assets["outro"] else 0) if assets["bgm"] else None
    outro_index = input_count - 1 if assets["outro"] else None

    narration_chain, narration_source = _build_narration_chain(
        ffprobe,
        scene_segment_paths,
        scene_pauses,
        cover_duration,
        total_duration,
    )
    filters = [
        f"{narration_chain},volume={preset.voice_volume:.3f}[nar0]",
        "[nar0]asplit=2[nar][duckkey]",
    ]
    mix_inputs = ["[nar]"]
    if intro_index is not None:
        filters.append(
            f"[{intro_index}:a]aresample=48000,{STEREO_PAN},"
            "aformat=sample_fmts=fltp:channel_layouts=stereo,"
            f"volume={preset.intro_volume:.3f},atrim=duration={total_duration:.3f}[intro0]"
        )
        mix_inputs.append("[intro0]")
    if bgm_index is not None:
        bgm_filter = (
            f"[{bgm_index}:a]aresample=48000,{STEREO_PAN},"
            "aformat=sample_fmts=fltp:channel_layouts=stereo,"
            f"atrim=duration={total_duration:.3f},volume={preset.bgm_volume:.3f}[bgm0]"
        )
        if preset.auto_duck:
            bgm_filter += (
                f";[bgm0][duckkey]sidechaincompress="
                f"threshold={preset.duck_threshold_db:.1f}:ratio=8:attack=20:release=300:makeup=1[bgm1]"
            )
            mix_inputs.append("[bgm1]")
        else:
            mix_inputs.append("[bgm0]")
        filters.append(bgm_filter)
    if outro_index is not None:
        outro_duration = _audio_duration(ffprobe, Path(assets["outro"])) or 0
        delay_ms = max(int((total_duration - outro_duration) * 1000), 0)
        filters.append(
            f"[{outro_index}:a]aresample=48000,{STEREO_PAN},"
            "aformat=sample_fmts=fltp:channel_layouts=stereo,"
            f"volume={preset.outro_volume:.3f},adelay={delay_ms}|{delay_ms},"
            f"atrim=duration={total_duration:.3f}[outro0]"
        )
        mix_inputs.append("[outro0]")
    mix_label = "".join(mix_inputs)
    filters.append(
        f"{mix_label}amix=inputs={len(mix_inputs)}:duration=longest:normalize=0[mixa];"
        f"[mixa]loudnorm=I={preset.loudness_target_lufs:.1f}:TP=-1.5:LRA=11,"
        "aresample=48000,asetpts=PTS-STARTPTS[aout]"
    )

    output = Path(output_path).expanduser().resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_name(f".{output.name}.{uuid.uuid4().hex}.tmp.mp4")
    command += [
        "-filter_complex",
        ";".join(filters),
        "-map",
        "0:v",
        "-c:v",
        "copy",
        "-map",
        "[aout]",
        "-c:a",
        "aac",
        "-b:a",
        "192k",
        "-movflags",
        "+faststart",
        str(temporary),
    ]
    try:
        completed = subprocess.run(command, capture_output=True, text=True, timeout=600)
    except subprocess.TimeoutExpired as exc:
        temporary.unlink(missing_ok=True)
        raise RuntimeError("sound mixing timed out") from exc
    if completed.returncode != 0 or not temporary.is_file():
        temporary.unlink(missing_ok=True)
        raise RuntimeError(f"sound mixing failed: {completed.stderr[-2000:]}")
    os.replace(temporary, output)
    return {
        "output_path": str(output),
        "duration": total_duration,
        "narration_source": narration_source,
        "mixed": True,
        "used_assets": {
            name: (str(path) if path else None) for name, path in assets.items()
        },
    }


def create_audio_preview(
    *,
    preset: SoundPreset,
    output_path: str | Path,
    duration: float = 15.0,
) -> dict[str, Any]:
    """Generate a lightweight audible preview of intro/BGM/outro without video."""
    if not preset.intro_path and not preset.bgm_path and not preset.outro_path:
        raise ValueError("preset has no audio assets to preview")
    ffmpeg = which_ffmpeg()
    if not ffmpeg:
        raise RuntimeError("ffmpeg is required for audio preview")
    command: list[str] = [ffmpeg, "-hide_banner", "-loglevel", "error", "-y"]
    if preset.bgm_path and preset.bgm_mode == "loop":
        command += ["-stream_loop", "-1"]
    for name in ("intro_path", "bgm_path", "outro_path"):
        value = getattr(preset, name)
        if value:
            command += ["-i", str(value)]
    filters: list[str] = []
    mix_inputs: list[str] = []
    input_index = 0
    for name in ("intro_path", "bgm_path", "outro_path"):
        value = getattr(preset, name)
        if not value:
            continue
        index = input_index
        input_index += 1
        volume = getattr(preset, name.replace("_path", "_volume"))
        if name == "outro_path":
            probe = probe_audio(value)
            length = float(probe["duration"]) if probe else 0
            delay_ms = max(int((duration - length) * 1000), 0)
            filters.append(
                f"[{index}:a]aresample=48000,{STEREO_PAN},volume={volume:.3f},"
                f"adelay={delay_ms}|{delay_ms},atrim=duration={duration:.3f}[p{index}]"
            )
        else:
            filters.append(
                f"[{index}:a]aresample=48000,{STEREO_PAN},volume={volume:.3f},"
                f"atrim=duration={duration:.3f}[p{index}]"
            )
        mix_inputs.append(f"[p{index}]")
    filters.append(
        f"{''.join(mix_inputs)}amix="
        f"inputs={len(mix_inputs)}:duration=longest:normalize=0,"
        f"loudnorm=I={preset.loudness_target_lufs:.1f}:TP=-1.5:LRA=11,"
        "aresample=48000[aout]"
    )
    output = Path(output_path).expanduser().resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    command += [
        "-filter_complex",
        ";".join(filters),
        "-map",
        "[aout]",
        "-c:a",
        "aac",
        "-b:a",
        "192k",
        "-movflags",
        "+faststart",
        str(output),
    ]
    try:
        completed = subprocess.run(command, capture_output=True, text=True, timeout=300)
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError("audio preview generation timed out") from exc
    if completed.returncode != 0 or not output.is_file():
        raise RuntimeError(f"audio preview failed: {completed.stderr[-2000:]}")
    return {"output_path": str(output), "duration": duration}


def _resolve_asset(path: str | None) -> Path | None:
    if not path:
        return None
    candidate = Path(path).expanduser()
    return candidate.resolve() if candidate.is_file() else None


def _video_duration(ffprobe: str, video: Path) -> float:
    try:
        completed = subprocess.run(
            [ffprobe, "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(video)],
            capture_output=True,
            text=True,
            timeout=30,
            check=True,
        )
        return float(completed.stdout.strip() or 0)
    except (OSError, subprocess.SubprocessError, ValueError):
        return 0.0


def _audio_duration(ffprobe: str, audio: Path) -> float:
    probe = probe_audio(audio)
    return float(probe["duration"]) if probe else 0.0


def _build_narration_chain(
    ffprobe: str,
    scene_segment_paths: list[str | Path] | None,
    scene_pauses: list[float] | None,
    cover_duration: float,
    total_duration: float,
) -> tuple[str, str]:
    """Return (filter_chain, source_kind). With segments, narration is rebuilt
    from scene audio plus cover silence and per-scene pauses; otherwise the
    existing video audio is used unchanged."""
    if not scene_segment_paths:
        return (
            "[0:a]aresample=48000,pan=stereo|c0=c0|c1=c1,"
            "aformat=sample_fmts=fltp:channel_layouts=stereo,asetpts=PTS-STARTPTS",
            "video_track",
        )
    parts: list[str] = [f"anullsrc=r=48000:cl=stereo,atrim=duration={cover_duration:.3f}[s0]"]
    concat_labels = ["[s0]"]
    pauses = list(scene_pauses or [])
    for index, segment in enumerate(scene_segment_paths):
        dur = _audio_duration(ffprobe, Path(segment))
        if dur <= 0:
            dur = 0.5
        pause = pauses[index] if index < len(pauses) else 0.0
        label = f"[seg{index}]"
        parts.append(
            f"[{index + 1}:a]aresample=48000,pan=stereo|c0=c0|c1=c1,"
            f"aformat=sample_fmts=fltp:channel_layouts=stereo,"
            f"apad,atrim=duration={dur + pause:.3f}{label}"
        )
        concat_labels.append(f"[seg{index}]")
    parts.append(
        "".join(concat_labels) + f"concat=n={len(concat_labels)}:v=0:a=1,"
        f"atrim=duration={total_duration:.3f}"
    )
    return ";".join(parts), "scene_segments"
