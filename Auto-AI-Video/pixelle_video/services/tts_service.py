# Copyright (C) 2025 AIDC-AI
#
# Licensed under the Apache License, Version 2.0

"""Edge TTS service used by the Grok-first production pipeline."""

import uuid
from pathlib import Path
from typing import Optional

from loguru import logger

from pixelle_video.tts_voices import speed_to_rate
from pixelle_video.utils.tts_util import edge_tts


class TTSService:
    """Generate narration locally through Edge TTS only."""

    def __init__(self, config: dict, core=None):
        del core
        self.config = config.get("tts") or {}
        self.provider = str(self.config.get("provider") or "edge")
        if self.provider != "edge":
            raise ValueError(f"Unsupported TTS provider: {self.provider}")

    async def __call__(
        self,
        text: str,
        voice: Optional[str] = None,
        voice_id: Optional[str] = None,
        speed: Optional[float] = None,
        output_path: Optional[str] = None,
        voice_volume: Optional[float] = None,
        **_params,
    ) -> str:
        """Convert text to speech with Edge TTS."""
        final_voice = voice or voice_id or self.config.get("voice") or "zh-CN-YunjianNeural"
        final_speed = speed if speed is not None else float(self.config.get("speed", 1.2))
        rate = speed_to_rate(final_speed)
        raw_volume = (
            voice_volume
            if voice_volume is not None
            else self.config.get("voice_volume", self.config.get("volume", 1.0))
        )
        try:
            final_volume = float(raw_volume)
        except (TypeError, ValueError) as exc:
            raise ValueError("voice_volume must be a number") from exc
        if not 0 <= final_volume <= 1.5:
            raise ValueError("voice_volume must be between 0 and 1.5")
        # Edge TTS expresses volume as a percentage around the original level:
        # 1.0 is +0%, 0.75 is -25%, and 1.5 is +50%.
        volume = f"{round((final_volume - 1) * 100):+d}%"

        if not output_path:
            output_path = f"output/{uuid.uuid4().hex}.mp3"
        output = Path(output_path)
        output.parent.mkdir(parents=True, exist_ok=True)

        logger.info(
            "Generating Edge TTS narration: voice={}, speed={}x, output={}",
            final_voice,
            final_speed,
            output,
        )
        await edge_tts(
            text=text,
            voice=final_voice,
            rate=rate,
            volume=volume,
            output_path=str(output),
        )
        return str(output)
