# Copyright (C) 2025 AIDC-AI
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#     http://www.apache.org/licenses/LICENSE-2.0
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

"""
Configuration Manager - Singleton pattern

Provides unified access to configuration with automatic validation.
"""

import os
from pathlib import Path
from typing import Any, Optional

from loguru import logger

from .loader import load_config_dict, save_config_dict
from .schema import PixelleVideoConfig


class ConfigManager:
    """
    Configuration Manager (Singleton)

    Provides unified access to configuration with automatic validation.
    """

    _instance: Optional["ConfigManager"] = None

    def __new__(cls, config_path: str = "config.yaml"):
        if cls._instance is None:
            cls._instance = super().__new__(cls)
        return cls._instance

    def __init__(self, config_path: str = "config.yaml"):
        # Only initialize once
        if hasattr(self, "_initialized"):
            return

        self.config_path = Path(os.getenv("PIXELLE_CONFIG_PATH", config_path))
        self.config: PixelleVideoConfig = self._load()
        self._initialized = True

    def _load(self) -> PixelleVideoConfig:
        """Load configuration from file"""
        data = load_config_dict(str(self.config_path))
        config = PixelleVideoConfig(**data)

        # Validate template path exists
        self._validate_template(config.template.default_template)

        return config

    def _validate_template(self, template_path: str):
        """Validate that the configured template exists"""
        from pixelle_video.utils.template_util import resolve_template_path

        try:
            # Try to resolve the template path
            resolved_path = resolve_template_path(template_path)
            logger.debug(f"Template validation passed: {template_path} -> {resolved_path}")
        except FileNotFoundError as e:
            logger.warning(
                f"Configured default template '{template_path}' not found. "
                f"Will fall back to '1080x1920/default.html' if needed. Error: {e}"
            )

    def reload(self):
        """Reload configuration from file"""
        self.config = self._load()
        logger.info("Configuration reloaded")

    def save(self):
        """Save current configuration to file"""
        save_config_dict(self.config.to_dict(), str(self.config_path))

    def update(self, updates: dict):
        """
        Update configuration with new values

        Args:
            updates: Dictionary of updates (e.g., {"llm": {"api_key": "xxx"}})
        """
        current = self.config.to_dict()

        # Deep merge
        def deep_merge(base: dict, updates: dict) -> dict:
            for key, value in updates.items():
                if key in base and isinstance(base[key], dict) and isinstance(value, dict):
                    deep_merge(base[key], value)
                else:
                    base[key] = value
            return base

        merged = deep_merge(current, updates)
        self.config = PixelleVideoConfig(**merged)

    def validate(self) -> bool:
        """Validate configuration completeness"""
        return self.config.validate_required()

    def resolve_model(self, capability: str) -> dict[str, Any]:
        """Resolve one active capability without exposing credentials to callers."""
        if capability not in {"text", "image", "video"}:
            raise ValueError(f"Unsupported model capability: {capability}")
        selection = getattr(self.config.model_settings.routing, capability)
        if not selection.channel_id or not selection.model:
            raise RuntimeError(f"No active {capability} model is configured")
        channel = self.config.model_settings.channels.get(selection.channel_id)
        if channel is None or not channel.enabled:
            raise RuntimeError(f"Active {capability} model channel is unavailable")
        if selection.model not in getattr(channel.models, capability):
            raise RuntimeError(f"Active {capability} model is no longer registered")
        return {
            "channel_id": selection.channel_id,
            "model": selection.model,
            "reasoning_effort": selection.reasoning_effort,
            **channel.model_dump(),
        }

    def resolve_model_routes(self, capability: str) -> list[dict[str, Any]]:
        """Resolve the preferred route and ordered fallbacks for one capability."""
        if capability not in {"text", "image", "video"}:
            raise ValueError(f"Unsupported model capability: {capability}")
        selection = getattr(self.config.model_settings.routing, capability)
        candidates = [selection, *selection.fallbacks]
        routes: list[dict[str, Any]] = []
        seen: set[tuple[str, str]] = set()
        for candidate in candidates:
            key = (candidate.channel_id, candidate.model)
            if not candidate.channel_id or not candidate.model or key in seen:
                continue
            channel = self.config.model_settings.channels.get(candidate.channel_id)
            if channel is None or not channel.enabled:
                raise RuntimeError(f"{capability.title()} model channel is unavailable: {candidate.channel_id}")
            if candidate.model not in getattr(channel.models, capability):
                raise RuntimeError(
                    f"{capability.title()} model is no longer registered: {candidate.channel_id}/{candidate.model}"
                )
            seen.add(key)
            routes.append(
                {
                    "channel_id": candidate.channel_id,
                    "model": candidate.model,
                    "reasoning_effort": candidate.reasoning_effort,
                    **channel.model_dump(),
                }
            )
        if not routes:
            raise RuntimeError(f"No active {capability} model is configured")
        return routes

    def get_model_channel(self, channel_id: str) -> dict[str, Any] | None:
        """Return a configured model channel for runtime provider adapters."""
        channel = self.config.model_settings.channels.get(channel_id)
        if channel is None:
            return None
        return {"channel_id": channel_id, **channel.model_dump()}
