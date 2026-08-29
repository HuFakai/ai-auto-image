import asyncio

import pytest

from pixelle_video.utils import tts_util


@pytest.mark.asyncio
async def test_edge_tts_stream_timeout_retries_and_preserves_destination(tmp_path, monkeypatch):
    class HangingCommunicate:
        calls = 0

        def __init__(self, **_kwargs):
            type(self).calls += 1

        async def stream(self):
            await asyncio.Event().wait()
            if False:  # pragma: no cover - makes this an async generator
                yield {}

    monkeypatch.setattr(tts_util.edge_tts_sdk, "Communicate", HangingCommunicate)
    monkeypatch.setattr(tts_util, "_REQUEST_DELAY", 0)
    monkeypatch.setattr(tts_util.random, "uniform", lambda *_args: 0)

    destination = tmp_path / "speech.mp3"
    destination.write_bytes(b"existing audio")

    with pytest.raises(TimeoutError, match=r"timed out after 0.01s on all 2 attempts"):
        await tts_util.edge_tts(
            "hello",
            output_path=str(destination),
            retry_count=1,
            retry_base_delay=0,
            attempt_timeout=0.01,
        )

    assert HangingCommunicate.calls == 2
    assert destination.read_bytes() == b"existing audio"
    assert list(tmp_path.glob(".speech.mp3.*.tmp")) == []


@pytest.mark.asyncio
async def test_edge_tts_writes_completed_audio_atomically(tmp_path, monkeypatch):
    class SuccessfulCommunicate:
        def __init__(self, **_kwargs):
            pass

        async def stream(self):
            yield {"type": "audio", "data": b"complete "}
            yield {"type": "audio", "data": b"audio"}

    monkeypatch.setattr(tts_util.edge_tts_sdk, "Communicate", SuccessfulCommunicate)
    monkeypatch.setattr(tts_util, "_REQUEST_DELAY", 0)
    monkeypatch.setattr(tts_util.random, "uniform", lambda *_args: 0)

    destination = tmp_path / "speech.mp3"
    result = await tts_util.edge_tts(
        "hello",
        output_path=str(destination),
        retry_count=0,
        attempt_timeout=1,
    )

    assert result == b"complete audio"
    assert destination.read_bytes() == b"complete audio"
    assert list(tmp_path.glob(".speech.mp3.*.tmp")) == []
