"""Operational readiness, consistent backups, and durable webhook delivery."""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import sqlite3
import tempfile
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import httpx

from .models import RunnerConfig, load_runner_config
from .store import ProductionStore


def inspect_operational_health(config_path: str | Path) -> dict[str, Any]:
    """Inspect dependencies without mutating the production ledger."""
    checked_at = datetime.now(timezone.utc)
    checks: list[dict[str, Any]] = []
    try:
        config = load_runner_config(config_path)
        checks.append(_check("configuration", "pass", f"{len(config.channels)} channels loaded"))
    except Exception as exc:
        return {
            "status": "not_ready",
            "ready": False,
            "checked_at": checked_at.isoformat(),
            "checks": [_check("configuration", "fail", str(exc))],
        }

    database = Path(config.database_path)
    if not database.is_file():
        checks.append(_check("database", "fail", f"Missing database: {database}"))
    else:
        try:
            connection = sqlite3.connect(f"file:{database}?mode=ro", uri=True, timeout=10)
            try:
                integrity = connection.execute("PRAGMA quick_check").fetchone()[0]
                try:
                    notification_counts = {
                        row[0]: row[1]
                        for row in connection.execute(
                            "SELECT status, COUNT(*) FROM production_notification_events GROUP BY status"
                        ).fetchall()
                    }
                except sqlite3.OperationalError as exc:
                    if "no such table" not in str(exc).lower():
                        raise
                    notification_counts = {}
            finally:
                connection.close()
            checks.append(
                _check(
                    "database",
                    "pass" if integrity == "ok" else "fail",
                    integrity,
                    {"path": str(database), "notification_counts": notification_counts},
                )
            )
        except (OSError, sqlite3.Error) as exc:
            checks.append(_check("database", "fail", str(exc), {"path": str(database)}))

    disk = shutil.disk_usage(database.parent)
    free_gb = disk.free / (1024**3)
    checks.append(
        _check(
            "disk",
            "pass" if free_gb >= config.operations.minimum_free_gb else "fail",
            f"{free_gb:.2f} GiB free",
            {
                "free_bytes": disk.free,
                "minimum_free_gb": config.operations.minimum_free_gb,
            },
        )
    )
    for command in ("ffmpeg", "ffprobe"):
        executable = shutil.which(command)
        checks.append(
            _check(command, "pass" if executable else "fail", executable or "not found")
        )

    backup_dir = Path(config.operations.backups_dir)
    backups = sorted(
        (item for item in backup_dir.glob("pixelle-*") if item.is_dir()),
        key=lambda item: item.stat().st_mtime,
        reverse=True,
    ) if backup_dir.is_dir() else []
    if backups:
        age_hours = (checked_at.timestamp() - backups[0].stat().st_mtime) / 3600
        status = "pass" if age_hours <= config.operations.backup_warning_hours else "warn"
        checks.append(
            _check(
                "backup",
                status,
                f"latest backup is {age_hours:.1f} hours old",
                {"path": str(backups[0]), "age_hours": round(age_hours, 2)},
            )
        )
    else:
        checks.append(_check("backup", "warn", "no completed backup found"))

    ready = not any(check["status"] == "fail" for check in checks)
    return {
        "status": "ready" if ready else "not_ready",
        "ready": ready,
        "checked_at": checked_at.isoformat(),
        "checks": checks,
    }


def create_production_backup(
    config_path: str | Path,
    app_config_path: str | Path | None = None,
) -> dict[str, Any]:
    """Create an atomic SQLite/config snapshot with hashes and restrictive permissions."""
    runner_path = Path(config_path).expanduser().resolve()
    config = load_runner_config(runner_path)
    backup_root = Path(config.operations.backups_dir)
    backup_root.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(backup_root, 0o700)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    name = f"pixelle-{stamp}-{uuid.uuid4().hex[:8]}"
    temporary = backup_root / f".{name}.tmp"
    target = backup_root / name
    temporary.mkdir(mode=0o700)
    try:
        database_target = temporary / "production.db"
        source = sqlite3.connect(f"file:{config.database_path}?mode=ro", uri=True, timeout=30)
        destination = sqlite3.connect(database_target)
        try:
            source.backup(destination)
        finally:
            destination.close()
            source.close()
        os.chmod(database_target, 0o600)

        config_dir = temporary / "config"
        config_dir.mkdir(mode=0o700)
        _copy_private(runner_path, config_dir / "runner.yaml")
        channels_dir = config_dir / "channels"
        channels_dir.mkdir(mode=0o700)
        for channel_path in sorted(Path(config.channels_dir).glob("*.y*ml")):
            _copy_private(channel_path, channels_dir / channel_path.name)
        resolved_app_config = (
            Path(app_config_path).expanduser().resolve()
            if app_config_path
            else runner_path.parent.parent / "config.yaml"
        )
        if resolved_app_config.is_file():
            _copy_private(resolved_app_config, config_dir / "config.yaml")

        entries = []
        for file_path in sorted(path for path in temporary.rglob("*") if path.is_file()):
            entries.append(
                {
                    "path": str(file_path.relative_to(temporary)),
                    "size_bytes": file_path.stat().st_size,
                    "sha256": _sha256(file_path),
                }
            )
        manifest = {
            "format": 1,
            "created_at": datetime.now(timezone.utc).isoformat(),
            "source_database": str(config.database_path),
            "files": entries,
        }
        manifest_path = temporary / "manifest.json"
        manifest_path.write_text(
            json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        os.chmod(manifest_path, 0o600)
        temporary.rename(target)
        return {"backup": str(target), **manifest}
    except Exception:
        shutil.rmtree(temporary, ignore_errors=True)
        raise


def verify_production_backup(path: str | Path) -> dict[str, Any]:
    """Verify manifest hashes and the copied SQLite database."""
    backup = Path(path).expanduser().resolve()
    manifest_path = backup / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    failures = []
    for entry in manifest.get("files") or []:
        file_path = backup / entry["path"]
        if not file_path.is_file():
            failures.append({"path": entry["path"], "reason": "missing"})
        elif _sha256(file_path) != entry["sha256"]:
            failures.append({"path": entry["path"], "reason": "sha256 mismatch"})
    database = backup / "production.db"
    if database.is_file():
        connection = sqlite3.connect(f"file:{database}?mode=ro", uri=True)
        try:
            integrity = connection.execute("PRAGMA quick_check").fetchone()[0]
        finally:
            connection.close()
        if integrity != "ok":
            failures.append({"path": "production.db", "reason": integrity})
    return {"backup": str(backup), "valid": not failures, "failures": failures}


def rehearse_production_restore(path: str | Path) -> dict[str, Any]:
    """Restore a backup into an isolated temporary database and inspect it."""
    verification = verify_production_backup(path)
    if not verification["valid"]:
        return {**verification, "rehearsed": False, "counts": {}}
    backup = Path(path).expanduser().resolve()
    with tempfile.TemporaryDirectory(prefix="pixelle-restore-rehearsal-") as directory:
        target = Path(directory) / "production.db"
        shutil.copy2(backup / "production.db", target)
        connection = sqlite3.connect(target)
        try:
            integrity = connection.execute("PRAGMA integrity_check").fetchone()[0]
            tables = {
                row[0]
                for row in connection.execute(
                    "SELECT name FROM sqlite_master WHERE type='table'"
                ).fetchall()
            }
            counts = {}
            for table in (
                "production_jobs",
                "production_projects",
                "production_revisions",
                "production_artifacts",
                "production_topic_candidates",
            ):
                counts[table] = (
                    connection.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
                    if table in tables
                    else 0
                )
        finally:
            connection.close()
    return {
        **verification,
        "rehearsed": integrity == "ok",
        "integrity": integrity,
        "counts": counts,
        "production_database_untouched": True,
    }


class WebhookNotifier:
    """Persist first, then deliver configured webhook events with bounded retries."""

    def __init__(
        self,
        config: RunnerConfig,
        store: ProductionStore,
        transport: httpx.BaseTransport | None = None,
    ):
        self.config = config.notifications
        self.store = store
        self.transport = transport

    def emit(self, event_type: str, event_key: str, payload: dict[str, Any]) -> None:
        if not self.config.enabled or event_type not in self.config.events:
            return
        self.store.enqueue_notification(event_key, event_type, payload)

    def flush(self, limit: int = 20) -> dict[str, int]:
        if not self.config.enabled or not self.config.webhook_url:
            return {"sent": 0, "failed": 0}
        sent = failed = 0
        token = os.getenv("PIXELLE_NOTIFICATION_WEBHOOK_TOKEN", "").strip()
        headers = {"Content-Type": "application/json"}
        if token:
            headers["Authorization"] = f"Bearer {token}"
        with httpx.Client(
            timeout=self.config.timeout_seconds,
            trust_env=False,
            follow_redirects=False,
            transport=self.transport,
        ) as client:
            for event in self.store.list_pending_notifications(limit=limit):
                body = {
                    "event": event["event_type"],
                    "event_id": event["id"],
                    "created_at": event["created_at"],
                    "data": event["payload"],
                }
                try:
                    response = client.post(self.config.webhook_url, json=body, headers=headers)
                    response.raise_for_status()
                    self.store.complete_notification(event["id"])
                    sent += 1
                except Exception as exc:
                    self.store.complete_notification(event["id"], str(exc)[:2000])
                    failed += 1
        return {"sent": sent, "failed": failed}


def _check(
    name: str,
    status: str,
    detail: str,
    metadata: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return {"name": name, "status": status, "detail": detail, **(metadata or {})}


def _copy_private(source: Path, target: Path) -> None:
    shutil.copy2(source, target)
    os.chmod(target, 0o600)


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()
