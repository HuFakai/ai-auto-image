# Copyright (C) 2025 AIDC-AI
#
# Licensed under the Apache License, Version 2.0

"""Media generation through configured Grok2API or OpenAI-compatible channels."""

from __future__ import annotations

import asyncio
import os
from pathlib import Path
from typing import Any, Optional

from loguru import logger

from pixelle_video.config import config_manager
from pixelle_video.models.media import MediaResult
from pixelle_video.services.model_routing import ModelRouteExhaustedError, route_attempt_error
from pixelle_video.utils.os_util import get_output_path


class APIProviderMediaService:
    """Route image and video generation through the unified channel registry."""

    def __init__(self, config: dict, core=None):
        self.config = config
        self.core = core

    def list_workflows(self) -> list[dict]:
        """Return enabled image/video models for existing pipeline selectors."""
        models: list[dict] = []
        for channel_id, channel in config_manager.config.model_settings.channels.items():
            if not channel.enabled:
                continue
            for media_type in ("image", "video"):
                for model in getattr(channel.models, media_type):
                    models.append(
                        self._model_info(
                            channel_id,
                            channel.name,
                            channel.api_format,
                            model,
                            media_type,
                        )
                    )
        return models

    def _model_info(
        self,
        channel_id: str,
        channel_name: str,
        api_format: str,
        model: str,
        media_type: str,
    ) -> dict:
        key = f"api/{channel_id}/{model}"
        info = {
            "name": model,
            "display_name": f"{model} - {channel_name}",
            "source": "api",
            "provider": channel_id,
            "model": model,
            "media_type": media_type,
            "path": key,
            "key": key,
            "api_format": api_format,
        }
        if media_type == "video":
            capabilities = self._video_capabilities(channel_id, model)
            info.update(
                capabilities=capabilities,
                ability_type=capabilities["ability_type"],
                ability_types=capabilities["ability_types"],
                adapter_ability_types=capabilities["adapter_ability_types"],
                api_contract_verified=True,
                contract_issues=capabilities["contract_issues"],
            )
        return info

    def resolve_workflow(self, workflow: str) -> dict:
        """Resolve an ``api/channel/model`` selector to registered model metadata."""
        for info in self.list_workflows():
            if info["key"] == workflow:
                return info
        available = ", ".join(info["key"] for info in self.list_workflows()) or "none"
        raise ValueError(f"Media model {workflow!r} is not registered; available: {available}")

    def resolve_media_type(self, workflow: str | None, fallback: str = "image") -> str:
        """Return the registered model capability instead of guessing from a template name."""
        selector = workflow or self._default_model_key(fallback)
        if selector in {"api/default/image", "api/default/video"}:
            selector = self._default_model_key(selector.rsplit("/", 1)[-1])
        return str(self.resolve_workflow(selector)["media_type"])

    async def __call__(
        self,
        prompt: str,
        workflow: Optional[str] = None,
        media_type: str = "image",
        width: Optional[int] = None,
        height: Optional[int] = None,
        duration: Optional[float] = None,
        output_path: Optional[str] = None,
        image_path: Optional[str] = None,
        **params,
    ) -> MediaResult:
        selector = workflow or self._default_model_key(media_type)
        if selector in {"api/default/image", "api/default/video"}:
            selector = self._default_model_key(selector.rsplit("/", 1)[-1])
        info = self.resolve_workflow(selector)
        resolved_type = info["media_type"]
        image_paths = params.pop("image_paths", None)
        reference_image_path = image_path or params.pop("image_path", None)
        routes = self._routes_for_request(selector, resolved_type)
        route_attempts: list[dict[str, object]] = []
        for route in routes:
            try:
                if resolved_type == "image":
                    return await self._generate_image(
                        route=route,
                        prompt=prompt,
                        width=width,
                        height=height,
                        output_path=output_path,
                        image_paths=image_paths,
                    )
                return await self._generate_video(
                    route=route,
                    prompt=prompt,
                    image_path=reference_image_path,
                    output_path=output_path,
                    duration=duration,
                    width=width,
                    height=height,
                    **params,
                )
            except Exception as exc:
                route_id = f"api/{route['channel_id']}/{route['model']}"
                error = route_attempt_error(exc)
                route_attempts.append(
                    {
                        "channel_id": route["channel_id"],
                        "model": route["model"],
                        "attempt": "all",
                        "max_attempts": max(int(route.get("retry_count", 0)), 0) + 1,
                        "error": error,
                    }
                )
                logger.warning(
                    "{} generation route failed after channel retries: route={}, error={}",
                    resolved_type.title(),
                    route_id,
                    error,
                )
        raise ModelRouteExhaustedError(
            f"All {resolved_type} model routes failed.", route_attempts
        )

    def _routes_for_request(self, selector: str, media_type: str) -> list[dict[str, Any]]:
        """Merge the requested primary workflow with configured ordered fallbacks."""
        info = self.resolve_workflow(selector)
        routes = [
            {
                "channel_id": info["provider"],
                "model": info["model"],
                "retry_count": self._require_channel(
                    info["provider"], info["model"], media_type
                ).get("retry_count", 0),
            }
        ]
        seen = {(routes[0]["channel_id"], routes[0]["model"])}
        try:
            configured = config_manager.resolve_model_routes(media_type)
        except RuntimeError as exc:
            logger.warning("Configured media fallback routes unavailable: {}", exc)
            configured = []
        for route in configured:
            key = (route["channel_id"], route["model"])
            if key in seen:
                continue
            seen.add(key)
            routes.append(route)
        return routes

    def _default_model_key(self, media_type: str) -> str:
        selection = config_manager.resolve_model(media_type)
        return f"api/{selection['channel_id']}/{selection['model']}"

    async def _generate_image(
        self,
        route: dict[str, Any],
        prompt: str,
        width: Optional[int],
        height: Optional[int],
        output_path: Optional[str],
        image_paths: Optional[list[str]] = None,
    ) -> MediaResult:
        channel_id = str(route["channel_id"])
        model = str(route["model"])
        channel = self._require_channel(channel_id, model, "image")
        save_dir = self._save_dir(output_path, "api_images")
        logger.info(f"Generating image via channel={channel_id}, model={model}")
        paths = await asyncio.to_thread(
            self._generate_channel_image,
            channel,
            model,
            prompt,
            save_dir,
            image_paths,
            self._ratio(width, height),
            self._resolution(width, height),
        )
        if not paths:
            raise RuntimeError(f"Image channel returned no result: {channel_id}/{model}")
        result_path = paths[0]
        self._require_generated_file(result_path, "image")
        if output_path and os.path.abspath(result_path) != os.path.abspath(output_path):
            Path(output_path).parent.mkdir(parents=True, exist_ok=True)
            os.replace(result_path, output_path)
            result_path = output_path
        self._require_generated_file(result_path, "image")
        return MediaResult(media_type="image", url=result_path)

    async def _generate_video(
        self,
        route: dict[str, Any],
        prompt: str,
        image_path: Optional[str],
        output_path: Optional[str],
        duration: Optional[float],
        width: Optional[int],
        height: Optional[int],
        **params,
    ) -> MediaResult:
        channel_id = str(route["channel_id"])
        model = str(route["model"])
        channel = self._require_channel(channel_id, model, "video")
        if params.get("first_clip_path") or params.get("first_video_path"):
            raise ValueError("Video continuation input is not supported by the unified channel API")
        save_path = output_path or os.path.join(self._save_dir(None, "api_videos"), "video.mp4")
        ratio = params.get("video_ratio") or params.get("ratio") or self._ratio(width, height)
        requested_duration = int(duration or params.get("duration") or 5)
        prompt_to_use = prompt
        max_safety_retries = int(params.get("prompt_safety_retries", 1))
        for attempt in range(max_safety_retries + 1):
            try:
                logger.info(f"Generating video via channel={channel_id}, model={model}")
                safe_duration = self._video_duration(channel_id, model, requested_duration)
                resolution = (
                    params.get("resolution")
                    or self._video_resolution(channel_id, width, height)
                )
                options = self._video_options(channel_id, params, resolution)
                await asyncio.to_thread(
                    self._generate_channel_video,
                    channel,
                    model,
                    prompt_to_use,
                    image_path,
                    save_path,
                    safe_duration,
                    ratio,
                    options,
                )
                break
            except Exception as exc:
                if attempt >= max_safety_retries or not self._is_content_inspection_error(exc):
                    raise
                prompt_to_use = await self._neutralize_video_prompt(prompt_to_use)
        if not os.path.exists(save_path):
            raise RuntimeError(f"Video channel did not create file: {save_path}")
        self._require_generated_file(save_path, "video")
        return MediaResult(media_type="video", url=save_path, duration=safe_duration)

    def _require_channel(self, channel_id: str, model: str, media_type: str) -> dict[str, Any]:
        channel = config_manager.get_model_channel(channel_id)
        if not channel or not channel.get("enabled"):
            raise RuntimeError(f"Model channel is disabled or missing: {channel_id}")
        if model not in channel["models"][media_type]:
            raise RuntimeError(f"Model {model!r} is not registered for {media_type} on {channel_id}")
        return channel

    def _generate_channel_image(
        self,
        channel: dict[str, Any],
        model: str,
        prompt: str,
        save_dir: str,
        image_paths: list[str] | None,
        ratio: str,
        resolution: str,
    ) -> list[str]:
        client = self._configured_media_client(channel)
        try:
            return client.generate_image(
                prompt=prompt,
                image_paths=image_paths,
                model=model,
                save_dir=save_dir,
                video_ratio=ratio,
                resolution=resolution,
            )
        finally:
            client.close()

    def _generate_channel_video(
        self,
        channel: dict[str, Any],
        model: str,
        prompt: str,
        image_path: str | None,
        save_path: str,
        duration: int,
        ratio: str,
        options: dict[str, Any],
    ) -> str:
        client = self._configured_media_client(channel)
        try:
            return client.generate_video(
                prompt=prompt,
                image_path=image_path,
                save_path=save_path,
                model=model,
                duration=duration,
                video_ratio=ratio,
                **options,
            )
        finally:
            client.close()

    def _configured_media_client(self, channel: dict[str, Any]):
        local_proxy = (
            config_manager.config.runtime.local_proxy if channel.get("use_proxy") else None
        )
        options = {
            "api_key": channel.get("api_key") or "",
            "base_url": channel["base_url"],
            "local_proxy": local_proxy or None,
            "job_store_dir": channel.get("job_store_dir") or "data/model_jobs",
            "request_timeout": float(channel.get("request_timeout", 300)),
            "poll_interval": float(channel.get("poll_interval", 5)),
            "poll_timeout": float(channel.get("poll_timeout", 1800)),
        }
        if channel["api_format"] == "grok2api":
            from pixelle_video.services.api_services.grok_client import GrokClient

            return GrokClient(**options, retry_count=int(channel.get("retry_count", 3)))
        from pixelle_video.services.api_services.openai_media_client import (
            OpenAICompatibleMediaClient,
        )

        return OpenAICompatibleMediaClient(
            **options,
            user_agent=channel.get("user_agent") or "",
            retry_count=int(channel.get("retry_count", 3)),
        )

    def _video_capabilities(self, channel_id: str, model: str) -> dict[str, Any]:
        channel = self._require_channel(channel_id, model, "video")
        if channel["api_format"] == "grok2api":
            return {
                "ability_type": "text_to_video",
                "ability_types": ["text_to_video", "image_to_video", "reference_to_video"],
                "adapter_ability_types": ["text_to_video", "first_frame_i2v", "reference_to_video"],
                "duration": {"min": 1, "max": 15, "integer": True, "verified": True},
                "resolutions": ["720p", "480p"],
                "contract_issues": ["Uses the configured grok2api video generation contract."],
            }
        return {
            "ability_type": "text_to_video",
            "ability_types": ["text_to_video", "image_to_video"],
            "adapter_ability_types": ["text_to_video", "first_frame_i2v"],
            "duration": {"allowed_values": [4, 8, 12], "verified": True},
            "resolutions": ["720x1280", "1280x720"],
            "contract_issues": ["Uses the OpenAI SDK Videos API contract."],
        }

    def _video_duration(self, channel_id: str, model: str, duration: int) -> int:
        contract = self._video_capabilities(channel_id, model)["duration"]
        if allowed := contract.get("allowed_values"):
            return min(allowed, key=lambda value: abs(value - duration))
        return min(max(duration, int(contract["min"])), int(contract["max"]))

    def _video_resolution(
        self, channel_id: str, width: Optional[int], height: Optional[int]
    ) -> str:
        channel = config_manager.get_model_channel(channel_id)
        if channel and channel["api_format"] == "grok2api":
            return "720p"
        return "720x1280" if height and width and height > width else "1280x720"

    def _video_options(
        self, channel_id: str, params: dict[str, Any], resolution: str
    ) -> dict[str, Any]:
        channel = config_manager.get_model_channel(channel_id)
        options: dict[str, Any] = {"resolution": resolution}
        if channel and channel["api_format"] == "grok2api":
            references = list(params.get("reference_image_paths") or [])
            if reference := params.get("reference_image_path"):
                references.insert(0, reference)
            options["reference_image_paths"] = references
        return options

    async def _neutralize_video_prompt(self, prompt: str) -> str:
        instruction = (
            "请将下面的视频提示词改写为中性、安全、正向的英文画面描述，只输出提示词：\n"
            + prompt
        )
        try:
            from pixelle_video.services.llm_service import LLMService

            result = await LLMService(config_manager.config.model_dump())(
                instruction, temperature=0.2, max_tokens=500
            )
            cleaned = str(result).strip().strip("`").strip().strip('"').strip("'")
            if cleaned:
                return cleaned
        except Exception as exc:
            logger.warning(f"Prompt safety rewrite failed; using local fallback: {exc}")
        return "A calm, positive, safe public scene with gentle light. " + prompt

    @staticmethod
    def _is_content_inspection_error(exc: Exception) -> bool:
        message = str(exc).lower()
        return any(
            marker in message
            for marker in (
                "datainspectionfailed",
                "inappropriate content",
                "content inspection",
                "safety inspection",
                "risk control",
            )
        )

    @staticmethod
    def _failure(exc: Exception) -> str:
        return route_attempt_error(exc)

    @staticmethod
    def _save_dir(output_path: Optional[str], fallback_name: str) -> str:
        return str(Path(output_path).parent) if output_path else get_output_path(fallback_name)

    @staticmethod
    def _ratio(width: Optional[int], height: Optional[int]) -> str:
        if not width or not height:
            return "16:9"
        if width == height:
            return "1:1"
        return "9:16" if height > width else "16:9"

    @staticmethod
    def _resolution(width: Optional[int], height: Optional[int]) -> str:
        largest = max(width or 0, height or 0)
        if largest >= 3600:
            return "4K"
        if largest >= 2000:
            return "2K"
        return "1080P"


    @staticmethod
    def _require_generated_file(path: str, media_type: str) -> None:
        target = Path(path).expanduser()
        if not target.is_file() or target.stat().st_size <= 0:
            raise RuntimeError(f"Generated {media_type} file is missing or empty: {target}")
        if media_type != "image":
            return
        signature = target.read_bytes()[:16]
        known_image = (
            signature.startswith(b"\x89PNG\r\n\x1a\n")
            or signature.startswith(b"\xff\xd8\xff")
            or signature.startswith((b"GIF87a", b"GIF89a"))
            or (signature.startswith(b"RIFF") and signature[8:12] == b"WEBP")
        )
        if not known_image:
            raise RuntimeError(f"Generated image response is not a supported image file: {target}")
