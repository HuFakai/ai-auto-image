from argparse import Namespace
from types import SimpleNamespace

from scripts.run_channel_gray_test import (
    _build_request,
    _load_or_create_report,
    _retry_entry,
    _summarize,
    _write_report,
)


def test_gray_request_can_force_hyperframes_without_mutating_source(tmp_path):
    base = {
        "text": "原始选题",
        "title": "原始标题",
        "production_mode": "native_image_html",
        "render_engine": "native_image_html",
        "renderer_version": "native-image-html-v2",
        "media_workflow": "api/example/image-model",
        "hyperframes": {"strictness": "strict", "fallback_to_native": True},
        "_production": {"channel_id": "demo"},
    }
    channel = SimpleNamespace(name="测试频道", topic=SimpleNamespace(seeds=["选题一"]))

    request = _build_request(
        base,
        channel,
        3,
        "hyperframes",
        False,
        "api/image-channel/image-model",
    )

    assert request["text"] == "选题一（灰度样本 03）"
    assert request["render_engine"] == "hyperframes"
    assert request["renderer_version"] == "0.8.4"
    assert request["media_workflow"] == "api/image-channel/image-model"
    assert request["hyperframes"]["fallback_to_native"] is False
    assert base["render_engine"] == "native_image_html"
    assert base["hyperframes"]["fallback_to_native"] is True

    report_path = tmp_path / "gray" / "report.json"
    _write_report(report_path, {"request": request})
    assert report_path.is_file()
    assert not report_path.with_suffix(".tmp").exists()


def test_gray_summary_distinguishes_fallback_from_engine_pass():
    tasks = [
        {
            "status": "completed",
            "requested_engine": "hyperframes",
            "actual_engine": "hyperframes",
            "fallback_reason": None,
        },
        {
            "status": "completed",
            "requested_engine": "hyperframes",
            "actual_engine": "native_image_html",
            "fallback_reason": "strict check failed",
        },
    ]

    continuous = _summarize(tasks, Namespace(count=2, require_engine=False))
    strict = _summarize(tasks, Namespace(count=2, require_engine=True))

    assert continuous["passed"] is True
    assert continuous["native_fallbacks"] == 1
    assert strict["passed"] is False
    assert strict["engine_mismatches"] == 1


def test_gray_report_resume_preserves_tasks_and_updates_runtime_limits(tmp_path):
    path = tmp_path / "report.json"
    existing = {
        "run_id": "run-1",
        "channel_id": "demo",
        "requested_engine": "hyperframes",
        "require_engine": True,
        "count": 20,
        "max_in_flight": 1,
        "started_at": "2026-08-20T00:00:00+00:00",
        "completed_at": None,
        "status": "interrupted",
        "tasks": [{"sample": 1, "task_id": "task-1", "status": "running"}],
        "summary": {},
    }
    _write_report(path, existing)
    args = Namespace(
        resume=True,
        engine="hyperframes",
        require_engine=True,
        count=20,
        max_in_flight=4,
        max_task_retries=2,
    )

    resumed = _load_or_create_report(path, "run-1", "demo", args)

    assert resumed["status"] == "running"
    assert resumed["started_at"] == existing["started_at"]
    assert resumed["tasks"] == existing["tasks"]
    assert resumed["max_in_flight"] == 4
    assert resumed["max_task_retries"] == 2


def test_gray_retry_reuses_same_task_id_and_checkpoint():
    class Response:
        def raise_for_status(self):
            return None

        def json(self):
            return {"status": "pending"}

    class Client:
        def __init__(self):
            self.paths = []

        def post(self, path):
            self.paths.append(path)
            return Response()

    client = Client()
    entry = {
        "task_id": "task-1",
        "status": "failed",
        "retry_count": 0,
        "error": "invalid json",
    }

    assert _retry_entry(client, entry, Namespace(max_task_retries=2)) is True
    assert client.paths == ["/api/tasks/task-1/retry"]
    assert entry["retry_count"] == 1
    assert entry["status"] == "pending"
    assert entry["error"] is None
