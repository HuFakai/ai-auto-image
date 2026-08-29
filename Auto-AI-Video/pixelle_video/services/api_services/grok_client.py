"""grok2api image/video client with durable asynchronous video jobs."""

from __future__ import annotations

import base64
import hashlib
import json
import mimetypes
import os
import threading
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional
from urllib.parse import urljoin, urlsplit

import httpx

TRANSIENT_STATUS_CODES = {429, 500, 502, 503, 504}


class GrokAPIError(RuntimeError):
    """Error returned by grok2api with the upstream status preserved."""

    def __init__(self, status_code: int, message: str, code: str = ""):
        self.status_code = status_code
        self.code = code
        prefix = f"Grok API HTTP {status_code}"
        if code:
            prefix += f" ({code})"
        super().__init__(f"{prefix}: {message}")


class GrokJobStore:
    """Small atomic JSON store used to resume grok2api video request IDs."""

    def __init__(self, root_dir: str):
        self.root = Path(root_dir).expanduser().resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()

    @staticmethod
    def make_key(value: dict[str, Any]) -> str:
        raw = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        return hashlib.sha256(raw.encode("utf-8")).hexdigest()

    def load(self, job_key: str) -> Optional[dict[str, Any]]:
        path = self.root / f"{job_key}.json"
        with self._lock:
            if not path.exists():
                return None
            with path.open("r", encoding="utf-8") as file:
                return json.load(file)

    def save(self, job_key: str, job: dict[str, Any]) -> dict[str, Any]:
        path = self.root / f"{job_key}.json"
        temp_path = path.with_suffix(f".json.{os.getpid()}.{uuid.uuid4().hex}.tmp")
        job = {**job, "updated_at": _utc_now()}
        with self._lock:
            with temp_path.open("w", encoding="utf-8") as file:
                json.dump(job, file, ensure_ascii=False, indent=2, sort_keys=True)
                file.flush()
                os.fsync(file.fileno())
            os.replace(temp_path, path)
        return job

    def list_jobs(self) -> list[dict[str, Any]]:
        """Return all readable job records sorted by creation time."""
        jobs: list[dict[str, Any]] = []
        with self._lock:
            for path in self.root.glob("*.json"):
                try:
                    with path.open("r", encoding="utf-8") as file:
                        jobs.append(json.load(file))
                except (OSError, json.JSONDecodeError):
                    continue
        return sorted(jobs, key=lambda job: job.get("created_at", ""))

    def find_resumable_by_output(self, output_path: str) -> Optional[dict[str, Any]]:
        """Find the latest submitted non-terminal job targeting one output file."""
        terminal = {"completed", "failed", "cancelled"}
        matches = [
            job
            for job in self.list_jobs()
            if job.get("output_path") == output_path
            and job.get("request_id")
            and job.get("status") not in terminal
        ]
        return matches[-1] if matches else None


class GrokClient:
    """Client for grok2api's image and asynchronous video endpoints.

    The video method intentionally has the same blocking contract as Pixelle's
    existing provider clients. The difference is that the upstream request ID is
    persisted before polling. Re-running the same scene/output path resumes the
    existing request instead of submitting another generation.
    """

    def __init__(
        self,
        api_key: str,
        base_url: str,
        local_proxy: Optional[str] = None,
        job_store_dir: str = "data/grok_jobs",
        request_timeout: float = 300.0,
        poll_interval: float = 5.0,
        poll_timeout: float = 1800.0,
        retry_count: int = 3,
        transport: Optional[httpx.BaseTransport] = None,
    ):
        if not api_key:
            raise RuntimeError("GROK_API_KEY not set. Configure the Grok API media provider first.")
        if not base_url:
            raise RuntimeError("GROK_BASE_URL not set. Configure the grok2api base URL first.")

        self.api_key = api_key
        self.base_url = base_url.rstrip("/")
        self.poll_interval = max(float(poll_interval), 0.0)
        self.poll_timeout = max(float(poll_timeout), 0.01)
        self.retry_count = max(int(retry_count), 1)
        self.job_store = GrokJobStore(job_store_dir)

        client_options: dict[str, Any] = {
            "headers": {"Authorization": f"Bearer {api_key}"},
            "timeout": request_timeout,
            # Provider proxying is explicit. Do not accidentally inherit a
            # desktop/global HTTP(S)_PROXY when use_proxy is disabled.
            "trust_env": False,
        }
        if local_proxy:
            client_options["proxy"] = local_proxy
        if transport is not None:
            client_options["transport"] = transport
        self._client = httpx.Client(**client_options)

    def close(self) -> None:
        self._client.close()

    def generate_image(
        self,
        prompt: str,
        image_paths: Optional[list[str]] = None,
        model: str = "grok-imagine-image-quality",
        save_dir: Optional[str] = None,
        session_id: Optional[str] = None,
        video_ratio: str = "16:9",
        resolution: str = "2K",
    ) -> list[str]:
        del session_id
        references = [self._image_input(path) for path in (image_paths or [])[:8]]
        payload: dict[str, Any] = {
            "model": model,
            "prompt": prompt,
            "n": 1,
            "aspect_ratio": video_ratio,
            "resolution": self._image_resolution(resolution),
            "response_format": "url",
        }

        endpoint = "images/generations"
        if references:
            endpoint = "images/edits"
            if len(references) == 1:
                payload["image"] = references[0]
            else:
                payload["images"] = references

        response = self._request("POST", endpoint, json=payload)
        body = response.json()
        items = body.get("data") or []
        if not items:
            raise RuntimeError("Grok image generation returned no data")

        destination = Path(save_dir or "output/grok_images")
        destination.mkdir(parents=True, exist_ok=True)
        paths: list[str] = []
        for index, item in enumerate(items):
            target = destination / f"grok_{int(time.time())}_{uuid.uuid4().hex[:8]}_{index}.png"
            if item.get("b64_json"):
                encoded = item["b64_json"].split(",", 1)[-1]
                self._write_bytes(target, base64.b64decode(encoded))
            elif item.get("url"):
                self._download(item["url"], target)
            else:
                continue
            paths.append(str(target.resolve()))

        if not paths:
            raise RuntimeError("Grok image response had no url or b64_json result")
        return paths

    def generate_video(
        self,
        prompt: str,
        image_path: Optional[str],
        save_path: str,
        model: str = "grok-imagine-video",
        duration: int = 8,
        video_ratio: str = "16:9",
        resolution: str = "720p",
        reference_image_paths: Optional[list[str]] = None,
    ) -> str:
        target = Path(save_path).expanduser().resolve()
        references = list(reference_image_paths or [])[:8]
        identity = {
            "model": model,
            "prompt": prompt,
            "duration": min(max(int(duration), 1), 15),
            "aspect_ratio": video_ratio,
            "resolution": self._video_resolution(resolution),
            "image": self._asset_fingerprint(image_path),
            "reference_images": [self._asset_fingerprint(path) for path in references],
            "output_path": str(target),
        }
        job_key = self.job_store.make_key(identity)
        job = self.job_store.load(job_key)

        # A recovered top-level Pixelle task may regenerate LLM prompts while
        # keeping the same deterministic scene output path. Prefer the already
        # submitted upstream request for that path instead of spending another
        # account slot on a duplicate generation.
        if not job:
            resumable = self.job_store.find_resumable_by_output(str(target))
            if resumable:
                return self._poll_and_download(resumable["job_key"], resumable, target)

        if job and job.get("status") == "completed" and target.exists():
            return str(target)
        if not job and target.exists() and target.stat().st_size > 0:
            return str(target)
        if job and job.get("status") == "failed":
            raise RuntimeError(f"Persisted Grok video job failed: {job.get('error', 'unknown error')}")

        if not job or not job.get("request_id"):
            payload: dict[str, Any] = {
                "model": model,
                "prompt": prompt,
                "duration": identity["duration"],
                "aspect_ratio": video_ratio,
                "resolution": identity["resolution"],
            }
            if image_path:
                payload["image"] = self._image_input(image_path)
            if references:
                payload["reference_images"] = [self._image_input(path) for path in references]

            job = self.job_store.save(
                job_key,
                {
                    "job_key": job_key,
                    "provider": "grok",
                    "model": model,
                    "status": "submitting",
                    "request_id": None,
                    "output_path": str(target),
                    "request": identity,
                    "created_at": _utc_now(),
                    "progress": 0,
                },
            )
            try:
                submitted = self._request("POST", "videos/generations", json=payload).json()
                request_id = submitted.get("request_id") or submitted.get("id")
                if not request_id:
                    data = submitted.get("data") or []
                    request_id = data[0].get("id") if data and isinstance(data[0], dict) else None
                if not request_id:
                    raise RuntimeError(f"Grok video submission returned no request_id: {submitted}")
                job["request_id"] = request_id
                job["status"] = "pending"
                job = self.job_store.save(job_key, job)
            except Exception as exc:
                job["status"] = "submission_failed"
                job["error"] = str(exc)
                self.job_store.save(job_key, job)
                raise

        return self._poll_and_download(job_key, job, target)

    def resume_job(self, job_key: str) -> str:
        """Resume polling/downloading for one previously submitted video job."""
        job = self.job_store.load(job_key)
        if not job:
            raise KeyError(f"Grok video job not found: {job_key}")
        if job.get("status") == "failed":
            raise RuntimeError(f"Grok video job is terminally failed: {job.get('error', 'unknown error')}")
        if not job.get("request_id"):
            raise RuntimeError(f"Grok video job has no request_id and cannot be resumed: {job_key}")

        target = Path(job["output_path"]).expanduser().resolve()
        if job.get("status") == "completed" and target.exists() and target.stat().st_size > 0:
            return str(target)
        return self._poll_and_download(job_key, job, target)

    def resume_pending_jobs(self) -> list[dict[str, str]]:
        """Resume every non-terminal job that already has an upstream request ID."""
        results: list[dict[str, str]] = []
        terminal = {"completed", "failed", "cancelled"}
        for job in self.job_store.list_jobs():
            if job.get("status") in terminal or not job.get("request_id"):
                continue
            job_key = job["job_key"]
            try:
                output_path = self.resume_job(job_key)
                results.append({"job_key": job_key, "status": "completed", "output_path": output_path})
            except Exception as exc:
                results.append({"job_key": job_key, "status": "error", "error": str(exc)})
        return results

    def _poll_and_download(self, job_key: str, job: dict[str, Any], target: Path) -> str:
        request_id = job["request_id"]
        started = time.monotonic()
        while time.monotonic() - started < self.poll_timeout:
            try:
                body = self._request("GET", f"videos/{request_id}").json()
                status = str(body.get("status") or "pending").lower()
                job["status"] = status
                job["progress"] = body.get("progress", job.get("progress", 0))
                job.pop("last_poll_error", None)
                job = self.job_store.save(job_key, job)

                if status in {"done", "success", "completed"}:
                    target.parent.mkdir(parents=True, exist_ok=True)
                    try:
                        content = self._request("GET", f"videos/{request_id}/content").content
                        if not content:
                            raise RuntimeError("Grok video content endpoint returned an empty body")
                        self._write_bytes(target, content)
                    except Exception:
                        video_url = self._video_url(body)
                        if not video_url:
                            raise
                        self._download(video_url, target)

                    job["status"] = "completed"
                    job["progress"] = 100
                    job["completed_at"] = _utc_now()
                    job["bytes"] = target.stat().st_size
                    self.job_store.save(job_key, job)
                    return str(target)

                if status in {"failed", "error", "cancelled"}:
                    error = body.get("error") or "Grok video generation failed"
                    if isinstance(error, dict):
                        error = error.get("message") or json.dumps(error, ensure_ascii=False)
                    job["status"] = "failed"
                    job["error"] = str(error)
                    self.job_store.save(job_key, job)
                    raise RuntimeError(str(error))
            except httpx.RequestError as exc:
                job["last_poll_error"] = str(exc)
                job = self.job_store.save(job_key, job)
            except GrokAPIError as exc:
                if exc.status_code not in TRANSIENT_STATUS_CODES:
                    job["status"] = "failed"
                    job["error"] = str(exc)
                    self.job_store.save(job_key, job)
                    raise
                job["last_poll_error"] = str(exc)
                job = self.job_store.save(job_key, job)

            time.sleep(self.poll_interval)

        job["status"] = "pending"
        job["last_poll_error"] = f"Polling timed out after {self.poll_timeout}s"
        self.job_store.save(job_key, job)
        raise TimeoutError(
            f"Grok video polling timed out; request_id={request_id} was persisted and will resume"
        )

    def _request(self, method: str, path: str, **kwargs: Any) -> httpx.Response:
        last_error: Optional[Exception] = None
        for attempt in range(self.retry_count):
            try:
                response = self._client.request(method, self._api_url(path), **kwargs)
                if response.status_code in TRANSIENT_STATUS_CODES and attempt + 1 < self.retry_count:
                    time.sleep(2**attempt)
                    continue
                if response.is_error:
                    raise self._response_error(response)
                return response
            except httpx.RequestError as exc:
                last_error = exc
                if attempt + 1 >= self.retry_count:
                    raise
                time.sleep(2**attempt)
        if last_error:
            raise last_error
        raise RuntimeError("Grok request failed without a response")

    def _response_error(self, response: httpx.Response) -> GrokAPIError:
        try:
            body = response.json()
        except ValueError:
            body = {}
        error = body.get("error", body)
        if isinstance(error, dict):
            message = error.get("message") or response.text
            code = str(error.get("code") or "")
        else:
            message = str(error or response.text)
            code = ""
        return GrokAPIError(response.status_code, message, code)

    def _api_url(self, path: str) -> str:
        suffix = path.lstrip("/")
        if suffix.startswith("v1/"):
            suffix = suffix[3:]
        if self.base_url.endswith("/v1"):
            return f"{self.base_url}/{suffix}"
        return f"{self.base_url}/v1/{suffix}"

    def _image_input(self, path_or_url: str) -> dict[str, str]:
        if path_or_url.startswith(("http://", "https://", "data:")):
            return {"url": path_or_url}
        path = Path(path_or_url).expanduser().resolve()
        if not path.exists():
            raise FileNotFoundError(f"Reference image not found: {path}")
        mime_type = mimetypes.guess_type(path.name)[0] or "image/png"
        encoded = base64.b64encode(path.read_bytes()).decode("ascii")
        return {"url": f"data:{mime_type};base64,{encoded}"}

    def _asset_fingerprint(self, path_or_url: Optional[str]) -> Optional[str]:
        if not path_or_url:
            return None
        if path_or_url.startswith("data:"):
            return hashlib.sha256(path_or_url.encode("utf-8")).hexdigest()
        path = Path(path_or_url).expanduser()
        if path.exists() and path.is_file():
            digest = hashlib.sha256()
            with path.open("rb") as file:
                for chunk in iter(lambda: file.read(1024 * 1024), b""):
                    digest.update(chunk)
            return digest.hexdigest()
        return hashlib.sha256(path_or_url.encode("utf-8")).hexdigest()

    def _download(self, url: str, target: Path) -> None:
        target.parent.mkdir(parents=True, exist_ok=True)
        url = urljoin(self.base_url.rstrip("/") + "/", url)
        base = urlsplit(self.base_url)
        remote = urlsplit(url)
        if (base.scheme, base.netloc) == (remote.scheme, remote.netloc):
            response = self._client.get(url)
        else:
            with httpx.Client(timeout=self._client.timeout, trust_env=False) as client:
                response = client.get(url)
        response.raise_for_status()
        self._write_bytes(target, response.content)

    @staticmethod
    def _write_bytes(target: Path, content: bytes) -> None:
        """Write an asset atomically so interrupted downloads never look complete."""
        target.parent.mkdir(parents=True, exist_ok=True)
        temp_path = target.with_suffix(f"{target.suffix}.{os.getpid()}.{uuid.uuid4().hex}.part")
        try:
            with temp_path.open("wb") as file:
                file.write(content)
                file.flush()
                os.fsync(file.fileno())
            os.replace(temp_path, target)
        finally:
            if temp_path.exists():
                temp_path.unlink()

    @staticmethod
    def _video_url(body: dict[str, Any]) -> Optional[str]:
        video = body.get("video")
        if isinstance(video, dict):
            return video.get("url")
        if isinstance(video, list) and video:
            item = video[0]
            return item.get("url") if isinstance(item, dict) else str(item)
        return None

    @staticmethod
    def _image_resolution(resolution: str) -> str:
        return "2k" if str(resolution).lower() in {"2k", "4k"} else "1k"

    @staticmethod
    def _video_resolution(resolution: str) -> str:
        value = str(resolution or "720p").lower()
        return value if value in {"480p", "720p"} else "720p"


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()
