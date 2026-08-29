"""HTTP adapter for the isolated HyperFrames Producer service."""

from __future__ import annotations

import asyncio
import os
from dataclasses import dataclass
from typing import Any, Callable

import httpx


@dataclass(frozen=True)
class HyperFramesRenderResult:
    render_id: str
    output_path: str
    duration: float | None
    size_bytes: int
    total_frames: int | None
    warnings: list[dict[str, Any]]
    perf_summary: dict[str, Any] | None
    check_report_path: str | None


class HyperFramesRendererError(RuntimeError):
    """Structured renderer failure carrying the producer stage."""

    def __init__(self, message: str, *, stage: str | None = None):
        super().__init__(message)
        self.stage = stage


class HyperFramesRendererAdapter:
    """Submit, observe and cancel one durable HyperFrames render."""

    def __init__(
        self,
        base_url: str | None = None,
        *,
        request_timeout: float = 30,
        poll_interval: float = 1,
        render_timeout: float = 1800,
        transport: httpx.AsyncBaseTransport | None = None,
    ):
        self.base_url = (
            base_url
            or os.getenv("HYPERFRAMES_RENDERER_URL")
            or "http://127.0.0.1:8788"
        ).rstrip("/")
        self.request_timeout = request_timeout
        self.poll_interval = poll_interval
        self.render_timeout = render_timeout
        self.transport = transport

    async def ready(self) -> dict[str, Any]:
        async with self._client() as client:
            response = await client.get("/ready")
        payload = self._payload(response)
        if response.status_code != 200 or not payload.get("ready"):
            raise HyperFramesRendererError("HyperFrames renderer is not ready")
        return payload

    async def submit(
        self,
        project_dir: str,
        *,
        output_path: str | None = None,
        fps: int = 30,
        quality: str = "standard",
        strictness: str = "strict",
        workers: int | None = None,
        use_gpu: bool = True,
        entry_file: str = "index.html",
    ) -> dict[str, Any]:
        body = {
            "project_dir": project_dir,
            "output_path": output_path,
            "fps": fps,
            "quality": quality,
            "strictness": strictness,
            "workers": workers,
            "use_gpu": use_gpu,
            "entry_file": entry_file,
        }
        async with self._client() as client:
            response = await client.post(
                "/renders", json={key: value for key, value in body.items() if value is not None}
            )
        payload = self._payload(response)
        if response.status_code != 202:
            raise HyperFramesRendererError(
                str(payload.get("error") or "HyperFrames render submission failed")
            )
        return payload

    async def get(self, render_id: str) -> dict[str, Any]:
        async with self._client() as client:
            response = await client.get(f"/renders/{render_id}")
        payload = self._payload(response)
        if response.status_code != 200:
            raise HyperFramesRendererError(str(payload.get("error") or "Render not found"))
        return payload

    async def cancel(self, render_id: str) -> dict[str, Any]:
        async with self._client() as client:
            response = await client.post(f"/renders/{render_id}/cancel")
        payload = self._payload(response)
        if response.status_code not in {200, 409}:
            raise HyperFramesRendererError(str(payload.get("error") or "Cancel failed"))
        return payload

    async def wait(
        self,
        render_id: str,
        progress_callback: Callable[[float, str, str], None] | None = None,
    ) -> HyperFramesRenderResult:
        async with asyncio.timeout(self.render_timeout):
            while True:
                job = await self.get(render_id)
                if progress_callback:
                    progress_callback(
                        float(job.get("progress") or 0),
                        str(job.get("stage") or "unknown"),
                        str(job.get("message") or ""),
                    )
                status = job.get("status")
                if status == "completed":
                    result = job.get("result") or {}
                    return HyperFramesRenderResult(
                        render_id=render_id,
                        output_path=str(result["output_path"]),
                        duration=(
                            float(result["duration"])
                            if result.get("duration") is not None
                            else None
                        ),
                        size_bytes=int(result.get("size_bytes") or 0),
                        total_frames=(
                            int(result["total_frames"])
                            if result.get("total_frames") is not None
                            else None
                        ),
                        warnings=list(result.get("warnings") or []),
                        perf_summary=result.get("perf_summary"),
                        check_report_path=result.get("check_report_path"),
                    )
                if status in {"failed", "cancelled"}:
                    raise HyperFramesRendererError(
                        str(job.get("error") or job.get("message") or status),
                        stage=str(job.get("failed_stage") or job.get("stage") or "unknown"),
                    )
                await asyncio.sleep(self.poll_interval)

    def _client(self) -> httpx.AsyncClient:
        return httpx.AsyncClient(
            base_url=self.base_url,
            timeout=self.request_timeout,
            trust_env=False,
            transport=self.transport,
        )

    @staticmethod
    def _payload(response: httpx.Response) -> dict[str, Any]:
        try:
            value = response.json()
        except ValueError as exc:
            raise HyperFramesRendererError(
                f"Renderer returned non-JSON HTTP {response.status_code}"
            ) from exc
        return value if isinstance(value, dict) else {}
