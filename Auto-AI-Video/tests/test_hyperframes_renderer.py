import json

import httpx
import pytest

from pixelle_video.services.hyperframes_renderer import (
    HyperFramesRendererAdapter,
    HyperFramesRendererError,
)


@pytest.mark.asyncio
async def test_hyperframes_adapter_submit_wait_and_progress():
    polls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal polls
        if request.method == "POST" and request.url.path == "/renders":
            body = json.loads(request.content)
            assert body["project_dir"] == "/project/task"
            return httpx.Response(202, json={"id": "render-1", "status": "queued"})
        if request.url.path == "/renders/render-1":
            polls += 1
            if polls == 1:
                return httpx.Response(
                    200,
                    json={
                        "id": "render-1",
                        "status": "running",
                        "stage": "capture",
                        "progress": 42,
                        "message": "capturing frames",
                    },
                )
            return httpx.Response(
                200,
                json={
                    "id": "render-1",
                    "status": "completed",
                    "stage": "complete",
                    "progress": 100,
                    "message": "done",
                    "result": {
                        "output_path": "/project/task/final.mp4",
                        "duration": 8,
                        "size_bytes": 1200,
                        "total_frames": 240,
                        "warnings": [],
                        "perf_summary": {"workers": 1},
                        "check_report_path": "/project/task/check-report.json",
                    },
                },
            )
        raise AssertionError(f"Unexpected request: {request.method} {request.url.path}")

    adapter = HyperFramesRendererAdapter(
        transport=httpx.MockTransport(handler), poll_interval=0, render_timeout=2
    )
    submitted = await adapter.submit("/project/task")
    events = []
    result = await adapter.wait(
        submitted["id"], lambda progress, stage, message: events.append((progress, stage, message))
    )

    assert result.output_path == "/project/task/final.mp4"
    assert result.total_frames == 240
    assert result.check_report_path == "/project/task/check-report.json"
    assert events[0] == (42, "capture", "capturing frames")
    assert events[-1][0] == 100


@pytest.mark.asyncio
async def test_hyperframes_adapter_preserves_failed_stage():
    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "id": "render-2",
                "status": "failed",
                "stage": "capture",
                "failed_stage": "capture",
                "error": "browser exited",
            },
        )

    adapter = HyperFramesRendererAdapter(
        transport=httpx.MockTransport(handler), poll_interval=0, render_timeout=2
    )
    with pytest.raises(HyperFramesRendererError, match="browser exited") as exc_info:
        await adapter.wait("render-2")
    assert exc_info.value.stage == "capture"
