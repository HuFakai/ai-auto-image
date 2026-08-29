"""API-owned lifecycle control for the continuous production runner."""

from __future__ import annotations

import asyncio
import json
import os
import threading
from collections.abc import Callable
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from loguru import logger

from .models import RunnerConfig, load_runner_config
from .runner import ProductionRunner

RunnerFactory = Callable[[RunnerConfig], ProductionRunner]


class ProductionRunnerManager:
    """Run one stoppable ProductionRunner thread owned by the API process."""

    def __init__(
        self,
        config_path: str | Path | None = None,
        state_path: str | Path | None = None,
        runner_factory: RunnerFactory = ProductionRunner,
    ) -> None:
        repository_root = Path(__file__).resolve().parents[2]
        configured = Path(
            config_path
            or os.getenv("PIXELLE_PRODUCTION_CONFIG_PATH", "production/runner.yaml")
        ).expanduser()
        state = Path(
            state_path
            or os.getenv(
                "PIXELLE_RUNNER_CONTROL_STATE_PATH",
                "data/production-runner-control.json",
            )
        ).expanduser()
        self.config_path = (
            configured if configured.is_absolute() else repository_root / configured
        ).resolve()
        self.state_path = (state if state.is_absolute() else repository_root / state).resolve()
        self.runner_factory = runner_factory
        self._lock = threading.RLock()
        self._thread: threading.Thread | None = None
        self._stop_event: threading.Event | None = None
        self._state = "stopped"
        self._desired_enabled = self._load_enabled()
        self._started_at: str | None = None
        self._stopped_at: str | None = None
        self._last_error: str | None = None

    async def startup(self) -> dict[str, Any]:
        """Restore the persisted switch state when the API starts."""
        if self._desired_enabled:
            return await self.start(persist=False)
        return self.status()

    async def start(self, *, persist: bool = True) -> dict[str, Any]:
        with self._lock:
            if self._thread and self._thread.is_alive():
                # A stopping thread must finish before another runner can own
                # the same SQLite lease. The Studio keeps polling and enables
                # the switch again once the state reaches ``stopped``.
                if self._state == "stopping":
                    return self.status()
                if persist and not self._desired_enabled:
                    self._set_enabled(True)
                return self.status()
            if persist:
                self._set_enabled(True)
            elif not self._desired_enabled:
                return self.status()

            stop_event = threading.Event()
            thread = threading.Thread(
                target=self._run,
                args=(stop_event,),
                name="pixelle-production-runner",
                daemon=True,
            )
            self._stop_event = stop_event
            self._thread = thread
            self._state = "starting"
            self._last_error = None
            self._stopped_at = None
            thread.start()
            return self.status()

    async def stop(
        self,
        *,
        persist: bool = True,
        timeout_seconds: float = 10,
    ) -> dict[str, Any]:
        with self._lock:
            if persist:
                self._set_enabled(False)
            thread = self._thread
            stop_event = self._stop_event
            if not thread or not thread.is_alive():
                self._state = "stopped"
                self._stopped_at = self._stopped_at or _now()
                return self.status()
            self._state = "stopping"
            if stop_event:
                stop_event.set()

        await asyncio.to_thread(thread.join, timeout_seconds)
        with self._lock:
            if thread.is_alive():
                self._state = "stopping"
            return self.status()

    def status(self) -> dict[str, Any]:
        with self._lock:
            thread_alive = bool(self._thread and self._thread.is_alive())
            return {
                "enabled": self._desired_enabled,
                "state": self._state,
                "running": thread_alive and self._state == "running",
                "started_at": self._started_at,
                "stopped_at": self._stopped_at,
                "last_error": self._last_error,
                "config_path": str(self.config_path),
            }

    def _run(self, stop_event: threading.Event) -> None:
        current = threading.current_thread()
        try:
            runner = self.runner_factory(load_runner_config(self.config_path))
            with self._lock:
                self._state = "stopping" if stop_event.is_set() else "running"
                self._started_at = _now()
            runner.run_forever(stop_event)
        except Exception as exc:
            logger.exception("API-managed production runner stopped unexpectedly")
            with self._lock:
                self._last_error = f"{type(exc).__name__}: {exc}"
                self._state = "failed" if self._desired_enabled else "stopped"
        finally:
            with self._lock:
                if self._thread is current:
                    self._thread = None
                    self._stop_event = None
                if self._state != "failed":
                    self._state = "stopped"
                self._stopped_at = _now()

    def _load_enabled(self) -> bool:
        try:
            payload = json.loads(self.state_path.read_text(encoding="utf-8"))
            return bool(payload.get("enabled")) if isinstance(payload, dict) else False
        except FileNotFoundError:
            return False
        except Exception as exc:
            logger.warning("Ignoring invalid runner control state {}: {}", self.state_path, exc)
            return False

    def _set_enabled(self, enabled: bool) -> None:
        self.state_path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.state_path.with_name(
            f"{self.state_path.name}.{os.getpid()}.{threading.get_ident()}.tmp"
        )
        payload = {
            "enabled": enabled,
            "updated_at": _now(),
        }
        temporary.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        os.replace(temporary, self.state_path)
        self._desired_enabled = enabled


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


production_runner_manager = ProductionRunnerManager()
