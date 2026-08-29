import asyncio
import json
import threading
from pathlib import Path

import pytest

from pixelle_video.production.runner_control import ProductionRunnerManager


def _write_runner_config(tmp_path: Path) -> Path:
    channels = tmp_path / "channels"
    channels.mkdir()
    (channels / "test.yaml").write_text(
        """id: test
name: Test
enabled: false
topic:
  strategy: seed
  seeds: [test]
video:
  frame_template: 1080x1920/video_default.html
  media_workflow: api/default/image
""",
        encoding="utf-8",
    )
    config = tmp_path / "runner.yaml"
    config.write_text(
        f"database_path: {tmp_path / 'production.db'}\n"
        f"channels_dir: {channels}\n"
        "poll_interval_seconds: 1\n",
        encoding="utf-8",
    )
    return config


class _FakeRunner:
    def __init__(self, started: threading.Event) -> None:
        self.started = started

    def run_forever(self, stop_event: threading.Event | None = None) -> None:
        assert stop_event is not None
        self.started.set()
        stop_event.wait(2)


@pytest.mark.asyncio
async def test_runner_manager_persists_switch_and_stops_thread(tmp_path: Path):
    started = threading.Event()
    state_path = tmp_path / "runner-control.json"
    manager = ProductionRunnerManager(
        _write_runner_config(tmp_path),
        state_path,
        runner_factory=lambda _config: _FakeRunner(started),
    )

    starting = await manager.start()
    assert starting["enabled"] is True
    assert await asyncio.to_thread(started.wait, 1)
    assert manager.status()["running"] is True
    assert json.loads(state_path.read_text(encoding="utf-8"))["enabled"] is True

    stopped = await manager.stop()
    assert stopped["enabled"] is False
    assert stopped["state"] == "stopped"
    assert json.loads(state_path.read_text(encoding="utf-8"))["enabled"] is False


@pytest.mark.asyncio
async def test_runner_manager_restores_enabled_state_on_api_start(tmp_path: Path):
    started = threading.Event()
    state_path = tmp_path / "runner-control.json"
    state_path.write_text('{"enabled": true}\n', encoding="utf-8")
    manager = ProductionRunnerManager(
        _write_runner_config(tmp_path),
        state_path,
        runner_factory=lambda _config: _FakeRunner(started),
    )

    await manager.startup()
    assert await asyncio.to_thread(started.wait, 1)
    assert manager.status()["enabled"] is True
    await manager.stop(persist=False)
    assert json.loads(state_path.read_text(encoding="utf-8"))["enabled"] is True
