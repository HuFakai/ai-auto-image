"""Shared bookkeeping for preferred and fallback model routes."""

from __future__ import annotations

from typing import Any


class ModelRouteExhaustedError(RuntimeError):
    """Raised after every preferred and fallback route has exhausted retries."""

    def __init__(self, message: str, attempts: list[dict[str, Any]]):
        self.attempts = attempts
        summary = "; ".join(
            f"{attempt['channel_id']}/{attempt['model']}"
            f" attempt {attempt['attempt']}/{attempt['max_attempts']}: {attempt['error']}"
            for attempt in attempts
        )
        super().__init__(f"{message} Route attempts: {summary}")


def route_attempt_error(exc: Exception) -> str:
    """Return a compact, user-visible provider error."""
    return " ".join(str(exc).split()) or exc.__class__.__name__


def route_id(channel_id: str, model: str) -> str:
    return f"api/{channel_id}/{model}"
