from pathlib import Path

import pytest

from pixelle_video.production.sound import normalize_sound_preset
from pixelle_video.services.tts_service import TTSService


def test_sound_preset_normalizes_voice_volume():
    preset = normalize_sound_preset("science", {"voice_volume": 0.75})

    assert preset.voice_volume == 0.75
    assert preset.to_dict()["voice_volume"] == 0.75


def test_sound_preset_rejects_voice_volume_outside_range():
    with pytest.raises(ValueError, match="voice_volume must be between 0 and 1.5"):
        normalize_sound_preset("science", {"voice_volume": 1.6})


@pytest.mark.asyncio
async def test_tts_service_maps_voice_volume_to_edge_tts(monkeypatch, tmp_path):
    calls: dict[str, object] = {}

    async def fake_edge_tts(**kwargs):
        calls.update(kwargs)
        Path(kwargs["output_path"]).write_bytes(b"audio")
        return b"audio"

    monkeypatch.setattr("pixelle_video.services.tts_service.edge_tts", fake_edge_tts)
    output = tmp_path / "narration.mp3"

    result = await TTSService({"tts": {"provider": "edge"}})(
        text="音量测试",
        voice="zh-CN-YunxiNeural",
        voice_volume=0.75,
        output_path=str(output),
    )

    assert result == str(output)
    assert calls["volume"] == "-25%"
    assert output.read_bytes() == b"audio"
