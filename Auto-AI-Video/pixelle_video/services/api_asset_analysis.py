# Copyright (C) 2025 AIDC-AI
#
# Licensed under the Apache License, Version 2.0

"""Image and video understanding through a configured text-model channel."""

from __future__ import annotations

import asyncio
import base64
import mimetypes
import subprocess
import tempfile
from pathlib import Path
from typing import Optional

import httpx
from loguru import logger
from openai import AsyncOpenAI

from pixelle_video.config import config_manager


class APIAssetAnalysisService:
    """Analyze uploaded assets through OpenAI-compatible multimodal chat."""

    IMAGE_PROMPT = """请分析这些素材画面，用中文给出适合短视频脚本创作的简洁描述。
重点说明主体、场景、动作、可用叙事信息、风格与氛围。输出 2-5 句话，不要编造。"""
    VIDEO_PROMPT = """请根据这些按时间顺序抽取的视频关键帧，用中文概括视频内容。
重点说明主体、场景、动作变化、叙事信息、整体风格与节奏。输出 3-6 句话，不要编造。"""

    def __init__(self, config: dict, core=None):
        self.config = config
        self.core = core

    def list_models(self, configured_only: bool = True) -> list[dict]:
        """Return text-channel models that users may select for vision analysis."""
        models: list[dict] = []
        for channel_id, channel in config_manager.config.model_settings.channels.items():
            if configured_only and (not channel.enabled or not channel.api_key):
                continue
            for model in channel.models.text:
                key = f"api/{channel_id}/{model}"
                models.append(
                    {
                        "key": key,
                        "name": model,
                        "display_name": f"{model} - {channel.name}",
                        "source": "api",
                        "provider": channel_id,
                        "model": model,
                        "media_type": "asset_analysis",
                        "ability_type": "multimodal_asset_analysis",
                        "ability_types": ["multimodal_asset_analysis"],
                    }
                )
        return models

    async def analyze_image(
        self,
        image_path: str,
        model: Optional[str] = None,
        prompt: Optional[str] = None,
        **_: object,
    ) -> str:
        image_file = Path(image_path)
        if not image_file.is_file():
            raise FileNotFoundError(f"Image file not found: {image_path}")
        return await self._query(prompt or self.IMAGE_PROMPT, [image_file], model)

    async def analyze_video(
        self,
        video_path: str,
        model: Optional[str] = None,
        prompt: Optional[str] = None,
        **_: object,
    ) -> str:
        video_file = Path(video_path)
        if not video_file.is_file():
            raise FileNotFoundError(f"Video file not found: {video_path}")
        with tempfile.TemporaryDirectory(prefix="pixelle-video-frames-") as directory:
            pattern = str(Path(directory) / "frame-%02d.jpg")
            await asyncio.to_thread(
                subprocess.run,
                [
                    "ffmpeg",
                    "-hide_banner",
                    "-loglevel",
                    "error",
                    "-i",
                    str(video_file),
                    "-vf",
                    "fps=1/5,scale='min(1280,iw)':-2",
                    "-frames:v",
                    "6",
                    "-y",
                    pattern,
                ],
                check=True,
                capture_output=True,
            )
            frames = sorted(Path(directory).glob("frame-*.jpg"))
            if not frames:
                raise RuntimeError("Video analysis could not extract any keyframes")
            return await self._query(prompt or self.VIDEO_PROMPT, frames, model)

    async def __call__(self, asset_path: str, asset_type: Optional[str] = None, **kwargs) -> str:
        path = Path(asset_path)
        resolved_type = asset_type or self._get_asset_type(path)
        if resolved_type == "image":
            return await self.analyze_image(asset_path, **kwargs)
        if resolved_type == "video":
            return await self.analyze_video(asset_path, **kwargs)
        raise ValueError(f"Unsupported asset type: {asset_path}")

    async def _query(self, prompt: str, image_paths: list[Path], selector: Optional[str]) -> str:
        channel, model = self._resolve_model(selector)
        proxy = config_manager.config.runtime.local_proxy if channel.get("use_proxy") else None
        http_client = httpx.AsyncClient(
            proxy=proxy or None,
            timeout=float(channel.get("request_timeout", 300)),
            trust_env=False,
        )
        client = AsyncOpenAI(
            api_key=channel.get("api_key") or "local-channel",
            base_url=channel["base_url"],
            default_headers=(
                {"User-Agent": channel["user_agent"]} if channel.get("user_agent") else None
            ),
            http_client=http_client,
            max_retries=max(int(channel.get("retry_count", 3)), 0),
        )
        content: list[dict] = [{"type": "text", "text": prompt}]
        content.extend(
            {
                "type": "image_url",
                "image_url": {"url": self._data_url(path), "detail": "low"},
            }
            for path in image_paths
        )
        logger.info(
            f"Analyzing asset via channel={channel['channel_id']}, model={model}, "
            f"frames={len(image_paths)}"
        )
        try:
            response = await client.chat.completions.create(
                model=model,
                messages=[{"role": "user", "content": content}],
                temperature=0.2,
                max_tokens=800,
            )
        finally:
            await client.close()
        result = response.choices[0].message.content if response.choices else ""
        description = str(result or "").strip()
        if not description:
            raise RuntimeError("Asset analysis returned an empty description")
        return description

    def _resolve_model(self, selector: Optional[str]) -> tuple[dict, str]:
        value = (selector or "").strip()
        if not value:
            selection = config_manager.resolve_model("text")
            return selection, selection["model"]
        parts = value.split("/", 2)
        if len(parts) == 3 and parts[0] == "api":
            channel = config_manager.get_model_channel(parts[1])
            model = parts[2]
            if channel and channel.get("enabled") and model in channel["models"]["text"]:
                return channel, model
            raise RuntimeError(f"Asset analysis model is unavailable: {value}")
        for channel_id, item in config_manager.config.model_settings.channels.items():
            if item.enabled and value in item.models.text:
                channel = config_manager.get_model_channel(channel_id)
                if channel:
                    return channel, value
        raise RuntimeError(f"Asset analysis model is not registered: {value}")

    @staticmethod
    def _data_url(path: Path) -> str:
        mime = mimetypes.guess_type(path.name)[0] or "image/jpeg"
        encoded = base64.b64encode(path.read_bytes()).decode("ascii")
        return f"data:{mime};base64,{encoded}"

    @staticmethod
    def _get_asset_type(path: Path) -> str:
        if path.suffix.lower() in {".jpg", ".jpeg", ".png", ".gif", ".webp"}:
            return "image"
        if path.suffix.lower() in {".mp4", ".mov", ".avi", ".mkv", ".webm"}:
            return "video"
        return "unknown"
