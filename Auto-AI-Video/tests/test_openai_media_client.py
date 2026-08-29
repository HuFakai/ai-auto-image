import base64
from pathlib import Path
from types import SimpleNamespace

from pixelle_video.services.api_services import openai_media_client
from pixelle_video.services.api_services.openai_media_client import (
    OpenAICompatibleMediaClient,
)


def _client(tmp_path: Path, monkeypatch):
    calls = {"images": [], "videos": []}

    class FakeHTTPClient:
        def __init__(self, **options):
            calls["http"] = options

        def get(self, url):
            calls["download_url"] = str(url)
            return SimpleNamespace(content=b"downloaded-png", raise_for_status=lambda: None)

        def close(self):
            pass

    class FakeImages:
        def generate(self, **options):
            calls["images"].append(options)
            encoded = base64.b64encode(b"png-bytes").decode()
            return SimpleNamespace(data=[SimpleNamespace(b64_json=encoded, url=None)])

        def edit(self, **options):
            calls["image_edits"] = options
            encoded = base64.b64encode(b"edited-png-bytes").decode()
            return SimpleNamespace(data=[SimpleNamespace(b64_json=encoded, url=None)])

    class FakeVideos:
        def create(self, **options):
            calls["videos"].append(("create", options))
            return SimpleNamespace(id="video-1", status="queued", progress=0)

        def retrieve(self, video_id):
            calls["videos"].append(("retrieve", video_id))
            return SimpleNamespace(
                id=video_id,
                status="completed",
                progress=100,
                error=None,
            )

        def download_content(self, video_id):
            calls["videos"].append(("download", video_id))
            return SimpleNamespace(content=b"mp4-bytes")

    class FakeOpenAI:
        def __init__(self, **options):
            calls["openai"] = options
            self.images = FakeImages()
            self.videos = FakeVideos()

        def close(self):
            pass

    monkeypatch.setattr(openai_media_client.httpx, "Client", FakeHTTPClient)
    monkeypatch.setattr(openai_media_client, "OpenAI", FakeOpenAI)
    client = OpenAICompatibleMediaClient(
        api_key="secret",
        base_url="https://openai.example.com/v1",
        user_agent="Pixelle-Test",
        job_store_dir=str(tmp_path / "jobs"),
        poll_interval=0,
        retry_count=4,
    )
    return client, calls


def test_openai_compatible_image_generation(tmp_path: Path, monkeypatch):
    client, calls = _client(tmp_path, monkeypatch)

    paths = client.generate_image(
        prompt="a clean illustration",
        model="image-model",
        save_dir=str(tmp_path / "images"),
        video_ratio="9:16",
    )

    assert Path(paths[0]).read_bytes() == b"png-bytes"
    assert calls["images"][0]["model"] == "image-model"
    assert calls["images"][0]["size"] == "1024x1536"
    assert calls["openai"]["max_retries"] == 4
    assert calls["openai"]["default_headers"] == {"User-Agent": "Pixelle-Test"}
    assert calls["http"]["base_url"] == "https://openai.example.com/v1"
    assert calls["http"]["headers"]["Authorization"] == "Bearer secret"


def test_openai_compatible_image_edit_uses_official_multipart_api(tmp_path: Path, monkeypatch):
    client, calls = _client(tmp_path, monkeypatch)
    reference = tmp_path / "reference.png"
    reference.write_bytes(b"reference-bytes")

    paths = client.generate_image(
        prompt="preserve the subject",
        model="image-model",
        save_dir=str(tmp_path / "images"),
        image_paths=[str(reference)],
    )

    assert Path(paths[0]).read_bytes() == b"edited-png-bytes"
    assert calls["image_edits"]["image"] == (
        "reference.png",
        b"reference-bytes",
        "image/png",
    )
    assert calls["image_edits"]["input_fidelity"] == "high"


def test_openai_compatible_image_download_resolves_relative_url(tmp_path: Path, monkeypatch):
    client, calls = _client(tmp_path, monkeypatch)
    client.client.images.generate = lambda **_options: SimpleNamespace(
        data=[SimpleNamespace(b64_json=None, url="files/generated.png")]
    )

    paths = client.generate_image(
        prompt="download the image",
        model="image-model",
        save_dir=str(tmp_path / "images"),
    )

    assert Path(paths[0]).read_bytes() == b"downloaded-png"
    assert calls["download_url"] == "https://openai.example.com/v1/files/generated.png"


def test_openai_compatible_video_generation_persists_and_downloads(tmp_path: Path, monkeypatch):
    client, calls = _client(tmp_path, monkeypatch)
    target = tmp_path / "videos" / "result.mp4"

    result = client.generate_video(
        prompt="gentle camera movement",
        image_path=None,
        save_path=str(target),
        model="video-model",
        duration=7,
        video_ratio="9:16",
    )

    assert result == str(target.resolve())
    assert target.read_bytes() == b"mp4-bytes"
    create = calls["videos"][0][1]
    assert create == {
        "prompt": "gentle camera movement",
        "model": "video-model",
        "seconds": "8",
        "size": "720x1280",
    }
    jobs = list((tmp_path / "jobs").glob("*.json"))
    assert len(jobs) == 1
    assert "secret" not in jobs[0].read_text(encoding="utf-8")
