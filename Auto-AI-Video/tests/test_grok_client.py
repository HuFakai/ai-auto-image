import base64
import json
from pathlib import Path

import httpx
import pytest

from pixelle_video.services.api_media import APIProviderMediaService
from pixelle_video.services.api_services import grok_client
from pixelle_video.services.api_services.grok_client import GrokClient


def make_client(tmp_path: Path, handler, **overrides) -> GrokClient:
    options = {
        "api_key": "g2a_test_secret",
        "base_url": "https://grok.example.com/v1",
        "job_store_dir": str(tmp_path / "jobs"),
        "poll_interval": 0,
        "poll_timeout": 1,
        "retry_count": 1,
        "transport": httpx.MockTransport(handler),
    }
    options.update(overrides)
    return GrokClient(**options)


def test_generate_image_uses_grok_contract_and_writes_base64(tmp_path):
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["path"] = request.url.path
        seen["authorization"] = request.headers["authorization"]
        seen["body"] = json.loads(request.content)
        encoded = base64.b64encode(b"png-bytes").decode("ascii")
        return httpx.Response(200, json={"data": [{"b64_json": encoded}]})

    client = make_client(tmp_path, handler)
    paths = client.generate_image(
        prompt="minimal stick figure",
        model="grok-imagine-image-quality",
        save_dir=str(tmp_path / "images"),
        video_ratio="9:16",
        resolution="2K",
    )

    assert seen["path"] == "/v1/images/generations"
    assert seen["authorization"] == "Bearer g2a_test_secret"
    assert seen["body"] == {
        "model": "grok-imagine-image-quality",
        "prompt": "minimal stick figure",
        "n": 1,
        "aspect_ratio": "9:16",
        "resolution": "2k",
        "response_format": "url",
    }
    assert Path(paths[0]).read_bytes() == b"png-bytes"


def test_generate_image_edit_wraps_local_reference_as_url_object(tmp_path):
    reference = tmp_path / "reference.png"
    reference.write_bytes(b"reference-image")

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/v1/images/edits"
        body = json.loads(request.content)
        assert list(body["image"]) == ["url"]
        assert body["image"]["url"].startswith("data:image/png;base64,")
        encoded = base64.b64encode(b"edited-image").decode("ascii")
        return httpx.Response(200, json={"data": [{"b64_json": encoded}]})

    client = make_client(tmp_path, handler)
    paths = client.generate_image(
        prompt="keep the character, change the pose",
        image_paths=[str(reference)],
        save_dir=str(tmp_path / "images"),
    )
    assert Path(paths[0]).read_bytes() == b"edited-image"


def test_video_request_id_is_persisted_and_resumed_without_resubmission(tmp_path):
    output = tmp_path / "output" / "scene-01.mp4"
    first_frame = tmp_path / "first-frame.png"
    first_frame.write_bytes(b"first-frame-image")
    first_calls = {"submit": 0, "poll": 0}

    def pending_handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/v1/videos/generations":
            first_calls["submit"] += 1
            submitted = json.loads(request.content)
            assert list(submitted["image"]) == ["url"]
            assert submitted["image"]["url"].startswith("data:image/png;base64,")
            return httpx.Response(200, json={"request_id": "video_resume_me"})
        if request.url.path == "/v1/videos/video_resume_me":
            first_calls["poll"] += 1
            return httpx.Response(200, json={"status": "pending", "progress": 37})
        raise AssertionError(f"Unexpected request: {request.method} {request.url}")

    first_client = make_client(
        tmp_path,
        pending_handler,
        poll_interval=0.01,
        poll_timeout=0.03,
    )
    with pytest.raises(TimeoutError, match="was persisted and will resume"):
        first_client.generate_video(
            prompt="a stick figure opens a door",
            image_path=str(first_frame),
            save_path=str(output),
            duration=8,
            video_ratio="9:16",
        )

    assert first_calls["submit"] == 1
    job_files = list((tmp_path / "jobs").glob("*.json"))
    assert len(job_files) == 1
    persisted = job_files[0].read_text(encoding="utf-8")
    assert '"request_id": "video_resume_me"' in persisted
    assert "g2a_test_secret" not in persisted
    assert "base64," not in persisted

    resumed_calls = {"submit": 0, "poll": 0, "content": 0}

    def completed_handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/v1/videos/generations":
            resumed_calls["submit"] += 1
            return httpx.Response(500, json={"error": "must not resubmit"})
        if request.url.path == "/v1/videos/video_resume_me":
            resumed_calls["poll"] += 1
            return httpx.Response(
                200,
                json={"status": "done", "progress": 100, "video": {"duration": 8}},
            )
        if request.url.path == "/v1/videos/video_resume_me/content":
            resumed_calls["content"] += 1
            return httpx.Response(200, content=b"mp4-video-bytes")
        raise AssertionError(f"Unexpected request: {request.method} {request.url}")

    resumed_client = make_client(tmp_path, completed_handler)
    result = resumed_client.generate_video(
        prompt="a differently worded prompt after top-level task recovery",
        image_path=None,
        save_path=str(output),
        duration=8,
        video_ratio="9:16",
    )

    assert result == str(output.resolve())
    assert output.read_bytes() == b"mp4-video-bytes"
    assert resumed_calls == {"submit": 0, "poll": 1, "content": 1}
    completed = json.loads(job_files[0].read_text(encoding="utf-8"))
    assert completed["status"] == "completed"
    assert completed["progress"] == 100


def test_resume_pending_jobs_scans_persisted_request_ids(tmp_path):
    output = (tmp_path / "output" / "pending.mp4").resolve()

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/v1/videos/persisted_id":
            return httpx.Response(200, json={"status": "done", "progress": 100})
        if request.url.path == "/v1/videos/persisted_id/content":
            return httpx.Response(200, content=b"resumed-video")
        raise AssertionError(f"Unexpected request: {request.method} {request.url}")

    client = make_client(tmp_path, handler)
    client.job_store.save(
        "persisted-job",
        {
            "job_key": "persisted-job",
            "request_id": "persisted_id",
            "status": "pending",
            "output_path": str(output),
            "created_at": "2026-08-12T00:00:00+00:00",
        },
    )

    assert client.resume_pending_jobs() == [
        {
            "job_key": "persisted-job",
            "status": "completed",
            "output_path": str(output),
        }
    ]
    assert output.read_bytes() == b"resumed-video"


def test_base_url_without_v1_gets_exactly_one_v1_prefix(tmp_path):
    seen_paths = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen_paths.append(request.url.path)
        encoded = base64.b64encode(b"image").decode("ascii")
        return httpx.Response(200, json={"data": [{"b64_json": encoded}]})

    client = make_client(tmp_path, handler, base_url="https://grok.example.com")
    client.generate_image(prompt="test", save_dir=str(tmp_path / "images"))
    assert seen_paths == ["/v1/images/generations"]


def test_transient_http_status_is_retried(tmp_path, monkeypatch):
    attempts = 0
    monkeypatch.setattr(grok_client.time, "sleep", lambda _seconds: None)

    def handler(_request: httpx.Request) -> httpx.Response:
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            return httpx.Response(429, json={"error": {"message": "busy"}})
        encoded = base64.b64encode(b"image-after-retry").decode("ascii")
        return httpx.Response(200, json={"data": [{"b64_json": encoded}]})

    client = make_client(tmp_path, handler, retry_count=2)
    paths = client.generate_image(prompt="retry", save_dir=str(tmp_path / "images"))
    assert attempts == 2
    assert Path(paths[0]).read_bytes() == b"image-after-retry"


def test_client_does_not_inherit_environment_proxy(tmp_path, monkeypatch):
    seen = {}

    class RecordingClient:
        def __init__(self, **kwargs):
            seen.update(kwargs)

        def close(self):
            return None

    monkeypatch.setattr(grok_client.httpx, "Client", RecordingClient)
    GrokClient(
        api_key="g2a_test_secret",
        base_url="https://grok.example.com",
        job_store_dir=str(tmp_path / "jobs"),
    )

    assert seen["trust_env"] is False
    assert "proxy" not in seen


def test_grok_video_resolution_falls_back_from_1080p():
    assert GrokClient._video_resolution("480p") == "480p"
    assert GrokClient._video_resolution("720p") == "720p"
    assert GrokClient._video_resolution("1080p") == "720p"
    assert APIProviderMediaService({})._video_resolution("grok", 512, 288) == "720p"
