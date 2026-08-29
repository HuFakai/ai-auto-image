"""Lifecycle manager for the bundled HyperFrames renderer service."""

from __future__ import annotations

import asyncio
import os
import shutil
from pathlib import Path
from typing import IO

from loguru import logger

from pixelle_video.services.hyperframes_renderer import (
    HyperFramesRendererAdapter,
    HyperFramesRendererError,
)


class HyperFramesProcessManager:
    """Start the local Node renderer on demand and stop only owned processes."""

    def __init__(self) -> None:
        self._lock = asyncio.Lock()
        self._process: asyncio.subprocess.Process | None = None
        self._log_handle: IO[bytes] | None = None

    async def ensure_started(self) -> dict:
        async with self._lock:
            ready = await self._readiness()
            if ready is not None:
                return ready
            if self._process and self._process.returncode is None:
                return await self._wait_until_ready()
            if os.getenv("HYPERFRAMES_RENDERER_URL"):
                raise HyperFramesRendererError(
                    "Configured HyperFrames renderer is unavailable; check HYPERFRAMES_RENDERER_URL"
                )
            if os.getenv("PIXELLE_HYPERFRAMES_AUTOSTART", "true").lower() in {
                "0",
                "false",
                "no",
                "off",
            }:
                raise HyperFramesRendererError(
                    "HyperFrames renderer is unavailable and automatic startup is disabled"
                )

            repository_root = Path(__file__).resolve().parents[2]
            service_root = repository_root / "services" / "hyperframes-renderer"
            entry = service_root / "scripts" / "server.mjs"
            node = shutil.which("node")
            if not node or not entry.is_file():
                raise HyperFramesRendererError(
                    "Bundled HyperFrames service is incomplete; install Node.js 22+ and renderer dependencies"
                )
            logs_dir = repository_root / "data" / "logs"
            logs_dir.mkdir(parents=True, exist_ok=True)
            self._log_handle = (logs_dir / "hyperframes-renderer.log").open("ab")
            environment = os.environ.copy()
            environment.setdefault("HYPERFRAMES_PROJECTS_ROOT", str(repository_root))
            # Keep mutable renderer state out of the source tree.  On Windows,
            # source indexing/AV can lock the bundled runtime file while the
            # renderer is updating progress, and manually started renderers can
            # otherwise collide with the API-owned renderer's state file.
            environment.setdefault(
                "HYPERFRAMES_RUNTIME_DIR",
                str(repository_root / "data" / "hyperframes-renderer-runtime"),
            )
            # The renderer's /ready check runs `ffmpeg -version`; make sure the
            # project-local Windows portable build is on PATH for this process.
            from pixelle_video.utils.os_util import ensure_local_ffmpeg_on_path

            ensure_local_ffmpeg_on_path()
            environment["PATH"] = os.environ.get("PATH", "")
            self._process = await asyncio.create_subprocess_exec(
                node,
                str(entry),
                cwd=str(service_root),
                env=environment,
                stdout=self._log_handle,
                stderr=asyncio.subprocess.STDOUT,
            )
            logger.info("HyperFrames renderer started on demand (pid={})", self._process.pid)
            try:
                return await self._wait_until_ready()
            except Exception:
                await self._stop_owned_process()
                raise

    async def stop(self) -> None:
        async with self._lock:
            await self._stop_owned_process()

    async def _readiness(self) -> dict | None:
        try:
            return await HyperFramesRendererAdapter(request_timeout=0.8).ready()
        except Exception:
            return None

    async def _wait_until_ready(self) -> dict:
        loop = asyncio.get_running_loop()
        deadline = loop.time() + 25
        last_error = "renderer did not become ready"
        while loop.time() < deadline:
            if self._process and self._process.returncode is not None:
                raise HyperFramesRendererError(
                    f"Bundled HyperFrames renderer exited with code {self._process.returncode}; "
                    "see data/logs/hyperframes-renderer.log"
                )
            try:
                return await HyperFramesRendererAdapter(request_timeout=1).ready()
            except Exception as exc:
                last_error = str(exc)
                await asyncio.sleep(0.35)
        raise HyperFramesRendererError(
            f"Bundled HyperFrames renderer startup timed out: {last_error}; "
            "see data/logs/hyperframes-renderer.log"
        )

    async def _stop_owned_process(self) -> None:
        process = self._process
        self._process = None
        if process and process.returncode is None:
            process.terminate()
            try:
                await asyncio.wait_for(process.wait(), timeout=5)
            except TimeoutError:
                process.kill()
                await process.wait()
        if self._log_handle:
            self._log_handle.close()
            self._log_handle = None


hyperframes_process_manager = HyperFramesProcessManager()
