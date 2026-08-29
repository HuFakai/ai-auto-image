import os
import plistlib
from pathlib import Path

import httpx

from pixelle_video.production import ProductionStore, load_runner_config
from pixelle_video.production.ops import (
    WebhookNotifier,
    create_production_backup,
    inspect_operational_health,
    verify_production_backup,
)
from scripts.render_launchd import render


def _write_config(tmp_path: Path, notifications: bool = False) -> Path:
    channels = tmp_path / "channels"
    channels.mkdir()
    (channels / "science.yaml").write_text(
        """id: science
name: Science
topic:
  strategy: seed
  seeds: [space]
video:
  frame_template: 1080x1920/video_default.html
  media_workflow: api/default/video
""",
        encoding="utf-8",
    )
    config = tmp_path / "runner.yaml"
    config.write_text(
        f"database_path: {tmp_path / 'production.db'}\n"
        f"channels_dir: {channels}\n"
        "operations:\n"
        f"  backups_dir: {tmp_path / 'backups'}\n"
        "  minimum_free_gb: 0.1\n"
        "notifications:\n"
        f"  enabled: {'true' if notifications else 'false'}\n"
        "  webhook_url: https://notify.example.test/events\n",
        encoding="utf-8",
    )
    return config


def test_backup_is_consistent_private_and_verifiable(tmp_path: Path):
    config_path = _write_config(tmp_path)
    app_config = tmp_path / "config.yaml"
    app_config.write_text("secret: test-only\n", encoding="utf-8")
    config = load_runner_config(config_path)
    with ProductionStore(config.database_path) as store:
        job = store.create_job("science", "space", "Space", {})

    backup = create_production_backup(config_path, app_config)
    verification = verify_production_backup(backup["backup"])
    backup_path = Path(backup["backup"])
    assert verification["valid"] is True
    assert (backup_path / "config/config.yaml").is_file()
    assert (backup_path / "config/channels/science.yaml").is_file()
    if os.name != "nt":
        assert backup_path.stat().st_mode & 0o777 == 0o700
        assert (backup_path / "production.db").stat().st_mode & 0o777 == 0o600
    with ProductionStore(str(backup_path / "production.db")) as copied:
        assert copied.get_job(job["id"])["title"] == "Space"


def test_readiness_reports_database_disk_tools_and_backup_warning(tmp_path: Path):
    config_path = _write_config(tmp_path)
    config = load_runner_config(config_path)
    with ProductionStore(config.database_path):
        pass
    result = inspect_operational_health(config_path)
    names = {check["name"]: check for check in result["checks"]}
    assert result["ready"] is True
    assert names["database"]["status"] == "pass"
    assert names["disk"]["status"] == "pass"
    assert names["backup"]["status"] == "warn"


def test_webhook_events_are_deduplicated_and_audited(tmp_path: Path):
    config = load_runner_config(_write_config(tmp_path, notifications=True))
    requests = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(204)

    with ProductionStore(config.database_path) as store:
        notifier = WebhookNotifier(config, store, httpx.MockTransport(handler))
        notifier.emit("job_failed", "job-failed:one:0", {"job_id": "one"})
        notifier.emit("job_failed", "job-failed:one:0", {"job_id": "one"})
        assert notifier.flush() == {"sent": 1, "failed": 0}
        assert notifier.flush() == {"sent": 0, "failed": 0}
        assert store.list_pending_notifications() == []
    assert len(requests) == 1


def test_launchd_renderer_uses_current_project_paths(tmp_path: Path):
    root = tmp_path / "project"
    (root / ".venv/bin").mkdir(parents=True)
    (root / "studio").mkdir()
    paths = render(root, tmp_path / "launchd")
    assert len(paths) == 4
    runner = plistlib.loads((tmp_path / "launchd/com.pixelle.runner.plist").read_bytes())
    backup = plistlib.loads((tmp_path / "launchd/com.pixelle.backup.plist").read_bytes())
    assert runner["KeepAlive"] is True
    assert runner["WorkingDirectory"] == str(root.resolve())
    assert backup["StartCalendarInterval"] == {"Hour": 3, "Minute": 10}
