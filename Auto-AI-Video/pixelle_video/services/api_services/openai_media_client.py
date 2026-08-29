"""OpenAI-compatible image and Videos API client with durable video polling."""

from __future__ import annotations

import base64
import hashlib
import mimetypes
import os
import time
import uuid
from pathlib import Path
from typing import Any
from urllib.parse import urljoin

import httpx
from openai import OpenAI

from pixelle_video.services.api_services.grok_client import GrokJobStore, _utc_now


class OpenAICompatibleMediaClient:
    """Generate media through the official OpenAI SDK surface."""

    def __init__(
        self,
        api_key: str,
        base_url: str,
        local_proxy: str | None = None,
        user_agent: str = "",
        job_store_dir: str = "data/model_jobs/openai",
        request_timeout: float = 300,
        poll_interval: float = 5,
        poll_timeout: float = 1800,
        retry_count: int = 3,
    ):
        default_headers = {"User-Agent": user_agent} if user_agent.strip() else None
        headers = {"Authorization": f"Bearer {api_key or 'local-channel'}"}
        if user_agent.strip():
            headers["User-Agent"] = user_agent
        http_client = httpx.Client(
            base_url=base_url,
            headers=headers,
            proxy=local_proxy or None,
            timeout=request_timeout,
            trust_env=False,
        )
        self.client = OpenAI(
            api_key=api_key or "local-channel",
            base_url=base_url,
            default_headers=default_headers,
            http_client=http_client,
            max_retries=max(int(retry_count), 0),
        )
        self.http_client = http_client
        self.base_url = base_url.rstrip("/") + "/"
        self.poll_interval = max(float(poll_interval), 0)
        self.poll_timeout = max(float(poll_timeout), 1)
        self.job_store = GrokJobStore(job_store_dir)

    def close(self) -> None:
        self.client.close()

    def generate_image(
        self,
        prompt: str,
        model: str,
        save_dir: str,
        image_paths: list[str] | None = None,
        video_ratio: str = "1:1",
        resolution: str = "2K",
    ) -> list[str]:
        size = self._image_size(video_ratio)
        common_options: dict[str, Any] = {
            "model": model,
            "prompt": prompt,
            "n": 1,
            "size": size,
            "quality": "high" if str(resolution).upper() in {"2K", "4K"} else "auto",
            "response_format": "b64_json",
        }
        if image_paths:
            uploads = [
                self._image_upload(value, index) for index, value in enumerate(image_paths[:6])
            ]
            response = self.client.images.edit(
                **common_options,
                image=uploads[0] if len(uploads) == 1 else uploads,
                input_fidelity="high",
            )
        else:
            response = self.client.images.generate(**common_options)
        destination = Path(save_dir).expanduser().resolve()
        destination.mkdir(parents=True, exist_ok=True)
        paths: list[str] = []
        for index, item in enumerate(response.data or []):
            target = destination / f"openai_{int(time.time())}_{index}.png"
            if item.b64_json:
                self._write_bytes(target, base64.b64decode(item.b64_json.split(",", 1)[-1]))
            elif item.url:
                result = self.http_client.get(urljoin(self.base_url, item.url))
                result.raise_for_status()
                self._write_bytes(target, result.content)
            else:
                continue
            paths.append(str(target))
        if not paths:
            raise RuntimeError("OpenAI-compatible image endpoint returned no media")
        return paths

    def generate_video(
        self,
        prompt: str,
        image_path: str | None,
        save_path: str,
        model: str,
        duration: int = 8,
        video_ratio: str = "9:16",
        **_options,
    ) -> str:
        target = Path(save_path).expanduser().resolve()
        seconds = str(min((4, 8, 12), key=lambda value: abs(value - int(duration))))
        size = "720x1280" if video_ratio in {"9:16", "3:4", "2:3"} else "1280x720"
        identity = {
            "model": model,
            "prompt": prompt,
            "seconds": seconds,
            "size": size,
            "image": self._fingerprint(image_path),
            "output_path": str(target),
        }
        job_key = self.job_store.make_key(identity)
        job = self.job_store.load(job_key) or self.job_store.find_resumable_by_output(str(target))
        if job and job.get("status") == "completed" and target.is_file():
            return str(target)
        if not job and target.is_file() and target.stat().st_size:
            return str(target)
        if job and job.get("status") == "failed":
            raise RuntimeError(job.get("error") or "Persisted video job failed")

        if not job or not job.get("request_id"):
            create_options: dict[str, Any] = {
                "prompt": prompt,
                "model": model,
                "seconds": seconds,
                "size": size,
            }
            image_file = None
            if image_path:
                image_file = Path(image_path).expanduser().open("rb")
                create_options["input_reference"] = image_file
            try:
                created = self.client.videos.create(**create_options)
            finally:
                if image_file:
                    image_file.close()
            job = self.job_store.save(
                job_key,
                {
                    "job_key": job_key,
                    "provider": "openai",
                    "model": model,
                    "request_id": created.id,
                    "status": created.status,
                    "progress": created.progress,
                    "output_path": str(target),
                    "request": identity,
                    "created_at": _utc_now(),
                },
            )

        started = time.monotonic()
        while time.monotonic() - started < self.poll_timeout:
            video = self.client.videos.retrieve(job["request_id"])
            job["status"] = video.status
            job["progress"] = video.progress
            self.job_store.save(job_key, job)
            if video.status == "completed":
                content = self.client.videos.download_content(video.id).content
                if not content:
                    raise RuntimeError("OpenAI-compatible Videos API returned empty content")
                self._write_bytes(target, content)
                job.update(status="completed", progress=100, completed_at=_utc_now())
                self.job_store.save(job_key, job)
                return str(target)
            if video.status == "failed":
                error = getattr(video.error, "message", None) or "Video generation failed"
                job.update(status="failed", error=error)
                self.job_store.save(job_key, job)
                raise RuntimeError(error)
            time.sleep(self.poll_interval)
        raise TimeoutError(
            f"Video polling timed out; request_id={job['request_id']} is persisted for recovery"
        )

    @staticmethod
    def _image_size(ratio: str) -> str:
        if ratio in {"9:16", "3:4", "2:3"}:
            return "1024x1536"
        if ratio in {"16:9", "4:3", "3:2"}:
            return "1536x1024"
        return "1024x1024"

    def _image_upload(self, value: str, index: int) -> tuple[str, bytes, str]:
        if value.startswith(("http://", "https://")):
            response = self.http_client.get(value)
            response.raise_for_status()
            mime = response.headers.get("content-type", "image/png").split(";", 1)[0]
            return f"reference-{index}.{self._mime_extension(mime)}", response.content, mime
        if value.startswith("data:"):
            header, encoded = value.split(",", 1)
            mime = header[5:].split(";", 1)[0] or "image/png"
            return (
                f"reference-{index}.{self._mime_extension(mime)}",
                base64.b64decode(encoded),
                mime,
            )
        path = Path(value).expanduser().resolve()
        mime = mimetypes.guess_type(path.name)[0] or "image/png"
        return path.name, path.read_bytes(), mime

    @staticmethod
    def _mime_extension(mime: str) -> str:
        return {"image/jpeg": "jpg", "image/webp": "webp"}.get(mime, "png")

    @staticmethod
    def _fingerprint(value: str | None) -> str | None:
        if not value:
            return None
        path = Path(value).expanduser()
        if path.is_file():
            return hashlib.sha256(path.read_bytes()).hexdigest()
        return hashlib.sha256(value.encode()).hexdigest()

    @staticmethod
    def _write_bytes(target: Path, content: bytes) -> None:
        target.parent.mkdir(parents=True, exist_ok=True)
        temporary = target.with_suffix(f"{target.suffix}.{os.getpid()}.{uuid.uuid4().hex}.part")
        try:
            temporary.write_bytes(content)
            os.replace(temporary, target)
        finally:
            if temporary.exists():
                temporary.unlink()
