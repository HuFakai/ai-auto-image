"""SQLite production ledger and single-runner lease."""

from __future__ import annotations

import hashlib
import json
import sqlite3
import threading
import time
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterable

from pixelle_video.rendering_versions import (
    HYPERFRAMES_RENDERER_VERSION,
    NATIVE_RENDERER_VERSION,
    WHITEBOARD_RENDERER_VERSION,
)
from pixelle_video.whiteboard.templates import WhiteboardTemplateRegistry

JOB_STATUSES = {
    "planned",
    "planning",
    "awaiting_storyboard",
    "submitting",
    "pending",
    "running",
    "ready",
    "failed",
    "published",
    "cancelled",
}

REVIEW_STATUSES = {"not_ready", "pending", "approved", "rejected"}


class ProductionStore:
    """Small durable catalog shared by runner invocations on one machine."""

    def __init__(self, path: str):
        self.path = Path(path).expanduser().resolve()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self._connection = sqlite3.connect(self.path, timeout=30, check_same_thread=False)
        self._connection.row_factory = sqlite3.Row
        self._connection.execute("PRAGMA journal_mode=WAL")
        self._connection.execute("PRAGMA busy_timeout=30000")
        self._migrate()

    def close(self) -> None:
        with self._lock:
            self._connection.close()

    def __enter__(self) -> "ProductionStore":
        return self

    def __exit__(self, *_exc_info: object) -> None:
        self.close()

    def _migrate(self) -> None:
        with self._lock, self._connection:
            self._connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS production_jobs (
                    id TEXT PRIMARY KEY,
                    channel_id TEXT NOT NULL,
                    topic TEXT NOT NULL,
                    title TEXT,
                    status TEXT NOT NULL,
                    api_task_id TEXT,
                    request_json TEXT NOT NULL,
                    result_json TEXT,
                    error TEXT,
                    retries INTEGER NOT NULL DEFAULT 0,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    completed_at TEXT,
                    completed_bucket TEXT,
                    published_at TEXT,
                    review_status TEXT NOT NULL DEFAULT 'not_ready',
                    review_note TEXT,
                    reviewed_at TEXT,
                    storyboard_task_id TEXT,
                    storyboard_json TEXT,
                    storyboard_status TEXT NOT NULL DEFAULT 'not_planned',
                    content_checks_json TEXT,
                    content_gate_status TEXT,
                    storyboard_reviewed_at TEXT
                );
                CREATE INDEX IF NOT EXISTS idx_production_jobs_channel_status
                    ON production_jobs(channel_id, status);
                CREATE INDEX IF NOT EXISTS idx_production_jobs_api_task
                    ON production_jobs(api_task_id);
                CREATE TABLE IF NOT EXISTS production_leases (
                    name TEXT PRIMARY KEY,
                    holder TEXT NOT NULL,
                    expires_at REAL NOT NULL
                );
                CREATE TABLE IF NOT EXISTS production_channel_state (
                    channel_id TEXT PRIMARY KEY,
                    paused INTEGER NOT NULL DEFAULT 0,
                    updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS production_presets (
                    id TEXT PRIMARY KEY,
                    kind TEXT NOT NULL CHECK(kind IN ('brand_kit', 'recipe')),
                    name TEXT NOT NULL,
                    current_version_id TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS production_preset_versions (
                    id TEXT PRIMARY KEY,
                    preset_id TEXT NOT NULL,
                    version INTEGER NOT NULL,
                    config_json TEXT NOT NULL,
                    note TEXT,
                    created_at TEXT NOT NULL,
                    UNIQUE(preset_id, version),
                    FOREIGN KEY(preset_id) REFERENCES production_presets(id)
                );
                CREATE INDEX IF NOT EXISTS idx_production_presets_kind
                    ON production_presets(kind, updated_at);
                CREATE INDEX IF NOT EXISTS idx_production_preset_versions_preset
                    ON production_preset_versions(preset_id, version);
                CREATE TABLE IF NOT EXISTS production_topic_candidates (
                    id TEXT PRIMARY KEY,
                    channel_id TEXT NOT NULL,
                    title TEXT NOT NULL,
                    topic TEXT NOT NULL,
                    cover_copy TEXT NOT NULL DEFAULT '',
                    platform_description TEXT NOT NULL DEFAULT '',
                    tags_json TEXT NOT NULL,
                    source_type TEXT NOT NULL,
                    source_label TEXT,
                    status TEXT NOT NULL,
                    score_json TEXT NOT NULL,
                    score_reasons_json TEXT NOT NULL,
                    semantic_terms_json TEXT NOT NULL DEFAULT '[]',
                    semantic_vector_json TEXT NOT NULL DEFAULT '[]',
                    title_variants_json TEXT NOT NULL DEFAULT '[]',
                    selected_title_id TEXT,
                    experiment_json TEXT NOT NULL DEFAULT '{}',
                    fingerprint TEXT NOT NULL,
                    duplicate_of TEXT,
                    decision_note TEXT,
                    consumed_job_id TEXT,
                    deferred_until TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    UNIQUE(channel_id, fingerprint),
                    FOREIGN KEY(consumed_job_id) REFERENCES production_jobs(id)
                );
                CREATE INDEX IF NOT EXISTS idx_topic_candidates_channel_status
                    ON production_topic_candidates(channel_id, status, created_at);
                CREATE TABLE IF NOT EXISTS production_content_sources (
                    id TEXT PRIMARY KEY,
                    channel_id TEXT NOT NULL,
                    name TEXT NOT NULL,
                    kind TEXT NOT NULL CHECK(kind IN ('url', 'rss')),
                    url TEXT NOT NULL,
                    enabled INTEGER NOT NULL DEFAULT 1,
                    poll_interval_minutes INTEGER NOT NULL DEFAULT 360,
                    items_per_poll INTEGER NOT NULL DEFAULT 5,
                    candidates_per_item INTEGER NOT NULL DEFAULT 2,
                    state TEXT NOT NULL DEFAULT 'idle',
                    last_task_id TEXT,
                    last_polled_at TEXT,
                    last_success_at TEXT,
                    next_poll_at TEXT,
                    last_error TEXT,
                    last_result_json TEXT NOT NULL DEFAULT '{}',
                    etag TEXT,
                    last_modified TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_content_sources_due
                    ON production_content_sources(enabled, state, next_poll_at);
                CREATE TABLE IF NOT EXISTS production_source_items (
                    id TEXT PRIMARY KEY,
                    source_id TEXT NOT NULL,
                    external_id TEXT,
                    title TEXT NOT NULL,
                    url TEXT,
                    content_excerpt TEXT NOT NULL,
                    fingerprint TEXT NOT NULL,
                    published_at TEXT,
                    candidate_ids_json TEXT NOT NULL DEFAULT '[]',
                    created_at TEXT NOT NULL,
                    UNIQUE(source_id, fingerprint),
                    FOREIGN KEY(source_id) REFERENCES production_content_sources(id)
                );
                CREATE INDEX IF NOT EXISTS idx_source_items_source
                    ON production_source_items(source_id, created_at);
                CREATE TABLE IF NOT EXISTS production_assistant_threads (
                    id TEXT PRIMARY KEY,
                    title TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS production_assistant_messages (
                    id TEXT PRIMARY KEY,
                    thread_id TEXT NOT NULL,
                    role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system')),
                    content TEXT NOT NULL,
                    payload_json TEXT NOT NULL DEFAULT '{}',
                    created_at TEXT NOT NULL,
                    FOREIGN KEY(thread_id) REFERENCES production_assistant_threads(id)
                );
                CREATE INDEX IF NOT EXISTS idx_assistant_messages_thread
                    ON production_assistant_messages(thread_id, created_at);
                CREATE TABLE IF NOT EXISTS production_assistant_plans (
                    id TEXT PRIMARY KEY,
                    thread_id TEXT NOT NULL,
                    request_message_id TEXT NOT NULL,
                    status TEXT NOT NULL,
                    summary TEXT NOT NULL,
                    actions_json TEXT NOT NULL,
                    result_json TEXT NOT NULL DEFAULT '{}',
                    error TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    executed_at TEXT,
                    FOREIGN KEY(thread_id) REFERENCES production_assistant_threads(id)
                );
                CREATE INDEX IF NOT EXISTS idx_assistant_plans_thread
                    ON production_assistant_plans(thread_id, created_at);
                CREATE TABLE IF NOT EXISTS production_notification_events (
                    id TEXT PRIMARY KEY,
                    event_key TEXT NOT NULL UNIQUE,
                    event_type TEXT NOT NULL,
                    payload_json TEXT NOT NULL,
                    status TEXT NOT NULL DEFAULT 'pending',
                    attempts INTEGER NOT NULL DEFAULT 0,
                    last_error TEXT,
                    created_at TEXT NOT NULL,
                    sent_at TEXT
                );
                CREATE INDEX IF NOT EXISTS idx_notification_events_status
                    ON production_notification_events(status, created_at);
                CREATE TABLE IF NOT EXISTS production_projects (
                    id TEXT PRIMARY KEY,
                    channel_id TEXT NOT NULL,
                    job_id TEXT NOT NULL UNIQUE,
                    title TEXT NOT NULL,
                    topic TEXT NOT NULL,
                    current_revision_id TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS production_revisions (
                    id TEXT PRIMARY KEY,
                    project_id TEXT NOT NULL,
                    number INTEGER NOT NULL,
                    parent_revision_id TEXT,
                    source_task_id TEXT,
                    status TEXT NOT NULL,
                    note TEXT,
                    config_json TEXT NOT NULL,
                    quality_status TEXT NOT NULL DEFAULT 'pending',
                    repair_task_id TEXT,
                    repair_status TEXT NOT NULL DEFAULT 'idle',
                    repair_plan_json TEXT,
                    repair_error TEXT,
                    repaired_at TEXT,
                    render_task_id TEXT,
                    render_status TEXT NOT NULL DEFAULT 'idle',
                    render_engine TEXT,
                    render_error TEXT,
                    rendered_at TEXT,
                    created_at TEXT NOT NULL,
                    activated_at TEXT,
                    UNIQUE(project_id, number),
                    FOREIGN KEY(project_id) REFERENCES production_projects(id)
                );
                CREATE TABLE IF NOT EXISTS production_scenes (
                    id TEXT PRIMARY KEY,
                    revision_id TEXT NOT NULL,
                    position INTEGER NOT NULL,
                    narration TEXT NOT NULL,
                    visual_prompt TEXT NOT NULL,
                    image_motion TEXT NOT NULL DEFAULT 'none',
                    transition TEXT NOT NULL DEFAULT 'crossfade',
                    transition_duration REAL NOT NULL DEFAULT 0.35,
                    direction_reason TEXT,
                    subtitle_effect TEXT,
                    subtitle_effect_applied TEXT,
                    subtitle_effect_fallback_reason TEXT,
                    subtitle_keywords_json TEXT NOT NULL DEFAULT '[]',
                    subtitle_start_offset REAL NOT NULL DEFAULT 0,
                    subtitle_end_offset REAL NOT NULL DEFAULT 0,
                    focus_x REAL,
                    focus_y REAL,
                    focus_confidence REAL,
                    focus_source TEXT,
                    locked INTEGER NOT NULL DEFAULT 0,
                    duration REAL NOT NULL DEFAULT 0,
                    audio_path TEXT,
                    media_path TEXT,
                    segment_path TEXT,
                    regeneration_task_id TEXT,
                    regeneration_status TEXT NOT NULL DEFAULT 'idle',
                    regeneration_scope TEXT,
                    regeneration_error TEXT,
                    regenerated_at TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    UNIQUE(revision_id, position),
                    FOREIGN KEY(revision_id) REFERENCES production_revisions(id)
                );
                CREATE TABLE IF NOT EXISTS production_artifacts (
                    id TEXT PRIMARY KEY,
                    revision_id TEXT NOT NULL,
                    scene_id TEXT,
                    kind TEXT NOT NULL,
                    path TEXT NOT NULL,
                    sha256 TEXT,
                    media_type TEXT,
                    model TEXT,
                    params_json TEXT NOT NULL,
                    size_bytes INTEGER NOT NULL DEFAULT 0,
                    duration REAL NOT NULL DEFAULT 0,
                    created_at TEXT NOT NULL,
                    UNIQUE(revision_id, scene_id, kind),
                    FOREIGN KEY(revision_id) REFERENCES production_revisions(id),
                    FOREIGN KEY(scene_id) REFERENCES production_scenes(id)
                );
                CREATE TABLE IF NOT EXISTS production_quality_checks (
                    id TEXT PRIMARY KEY,
                    revision_id TEXT NOT NULL,
                    check_name TEXT NOT NULL,
                    status TEXT NOT NULL,
                    detail_json TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    UNIQUE(revision_id, check_name),
                    FOREIGN KEY(revision_id) REFERENCES production_revisions(id)
                );
                CREATE TABLE IF NOT EXISTS production_task_events (
                    id TEXT PRIMARY KEY,
                    job_id TEXT NOT NULL,
                    task_id TEXT,
                    task_type TEXT,
                    stage TEXT NOT NULL,
                    event_kind TEXT NOT NULL,
                    status TEXT,
                    started_at TEXT,
                    ended_at TEXT,
                    duration_ms INTEGER,
                    model TEXT,
                    reuse TEXT,
                    artifacts_json TEXT NOT NULL DEFAULT '[]',
                    recovery_json TEXT NOT NULL DEFAULT '[]',
                    detail_json TEXT NOT NULL DEFAULT '{}',
                    created_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_projects_channel
                    ON production_projects(channel_id, updated_at);
                CREATE INDEX IF NOT EXISTS idx_revisions_project
                    ON production_revisions(project_id, number);
                CREATE INDEX IF NOT EXISTS idx_scenes_revision
                    ON production_scenes(revision_id, position);
                CREATE INDEX IF NOT EXISTS idx_task_events_job
                    ON production_task_events(job_id, created_at);
                CREATE INDEX IF NOT EXISTS idx_task_events_open
                    ON production_task_events(job_id, task_id, status);
                """
            )

            columns = {
                row["name"]
                for row in self._connection.execute("PRAGMA table_info(production_jobs)").fetchall()
            }
            migrations = {
                "review_status": (
                    "ALTER TABLE production_jobs ADD COLUMN "
                    "review_status TEXT NOT NULL DEFAULT 'not_ready'"
                ),
                "review_note": "ALTER TABLE production_jobs ADD COLUMN review_note TEXT",
                "reviewed_at": "ALTER TABLE production_jobs ADD COLUMN reviewed_at TEXT",
                "storyboard_task_id": (
                    "ALTER TABLE production_jobs ADD COLUMN storyboard_task_id TEXT"
                ),
                "storyboard_json": ("ALTER TABLE production_jobs ADD COLUMN storyboard_json TEXT"),
                "storyboard_status": (
                    "ALTER TABLE production_jobs ADD COLUMN storyboard_status "
                    "TEXT NOT NULL DEFAULT 'not_planned'"
                ),
                "content_checks_json": (
                    "ALTER TABLE production_jobs ADD COLUMN content_checks_json TEXT"
                ),
                "content_gate_status": (
                    "ALTER TABLE production_jobs ADD COLUMN content_gate_status TEXT"
                ),
                "storyboard_reviewed_at": (
                    "ALTER TABLE production_jobs ADD COLUMN storyboard_reviewed_at TEXT"
                ),
            }
            self._apply_column_migrations(columns, migrations)
            topic_columns = {
                row["name"]
                for row in self._connection.execute(
                    "PRAGMA table_info(production_topic_candidates)"
                ).fetchall()
            }
            topic_migrations = {
                "semantic_terms_json": (
                    "ALTER TABLE production_topic_candidates ADD COLUMN "
                    "semantic_terms_json TEXT NOT NULL DEFAULT '[]'"
                ),
                "semantic_vector_json": (
                    "ALTER TABLE production_topic_candidates ADD COLUMN "
                    "semantic_vector_json TEXT NOT NULL DEFAULT '[]'"
                ),
                "title_variants_json": (
                    "ALTER TABLE production_topic_candidates ADD COLUMN "
                    "title_variants_json TEXT NOT NULL DEFAULT '[]'"
                ),
                "selected_title_id": (
                    "ALTER TABLE production_topic_candidates ADD COLUMN selected_title_id TEXT"
                ),
                "experiment_json": (
                    "ALTER TABLE production_topic_candidates ADD COLUMN "
                    "experiment_json TEXT NOT NULL DEFAULT '{}'"
                ),
            }
            self._apply_column_migrations(topic_columns, topic_migrations)
            scene_columns = {
                row["name"]
                for row in self._connection.execute(
                    "PRAGMA table_info(production_scenes)"
                ).fetchall()
            }
            scene_migrations = {
                "image_motion": (
                    "ALTER TABLE production_scenes ADD COLUMN "
                    "image_motion TEXT NOT NULL DEFAULT 'none'"
                ),
                "transition": (
                    "ALTER TABLE production_scenes ADD COLUMN "
                    "transition TEXT NOT NULL DEFAULT 'crossfade'"
                ),
                "transition_duration": (
                    "ALTER TABLE production_scenes ADD COLUMN "
                    "transition_duration REAL NOT NULL DEFAULT 0.35"
                ),
                "direction_reason": (
                    "ALTER TABLE production_scenes ADD COLUMN direction_reason TEXT"
                ),
                "subtitle_effect": (
                    "ALTER TABLE production_scenes ADD COLUMN subtitle_effect TEXT"
                ),
                "subtitle_effect_applied": (
                    "ALTER TABLE production_scenes ADD COLUMN subtitle_effect_applied TEXT"
                ),
                "subtitle_effect_fallback_reason": (
                    "ALTER TABLE production_scenes ADD COLUMN "
                    "subtitle_effect_fallback_reason TEXT"
                ),
                "subtitle_keywords_json": (
                    "ALTER TABLE production_scenes ADD COLUMN "
                    "subtitle_keywords_json TEXT NOT NULL DEFAULT '[]'"
                ),
                "subtitle_start_offset": (
                    "ALTER TABLE production_scenes ADD COLUMN "
                    "subtitle_start_offset REAL NOT NULL DEFAULT 0"
                ),
                "subtitle_end_offset": (
                    "ALTER TABLE production_scenes ADD COLUMN "
                    "subtitle_end_offset REAL NOT NULL DEFAULT 0"
                ),
                "focus_x": "ALTER TABLE production_scenes ADD COLUMN focus_x REAL",
                "focus_y": "ALTER TABLE production_scenes ADD COLUMN focus_y REAL",
                "focus_confidence": (
                    "ALTER TABLE production_scenes ADD COLUMN focus_confidence REAL"
                ),
                "focus_source": "ALTER TABLE production_scenes ADD COLUMN focus_source TEXT",
                "regeneration_task_id": (
                    "ALTER TABLE production_scenes ADD COLUMN regeneration_task_id TEXT"
                ),
                "regeneration_status": (
                    "ALTER TABLE production_scenes ADD COLUMN regeneration_status "
                    "TEXT NOT NULL DEFAULT 'idle'"
                ),
                "regeneration_scope": (
                    "ALTER TABLE production_scenes ADD COLUMN regeneration_scope TEXT"
                ),
                "regeneration_error": (
                    "ALTER TABLE production_scenes ADD COLUMN regeneration_error TEXT"
                ),
                "regenerated_at": ("ALTER TABLE production_scenes ADD COLUMN regenerated_at TEXT"),
            }
            self._apply_column_migrations(scene_columns, scene_migrations)
            revision_columns = {
                row["name"]
                for row in self._connection.execute(
                    "PRAGMA table_info(production_revisions)"
                ).fetchall()
            }
            revision_migrations = {
                "repair_task_id": (
                    "ALTER TABLE production_revisions ADD COLUMN repair_task_id TEXT"
                ),
                "repair_status": (
                    "ALTER TABLE production_revisions ADD COLUMN repair_status "
                    "TEXT NOT NULL DEFAULT 'idle'"
                ),
                "repair_plan_json": (
                    "ALTER TABLE production_revisions ADD COLUMN repair_plan_json TEXT"
                ),
                "repair_error": ("ALTER TABLE production_revisions ADD COLUMN repair_error TEXT"),
                "repaired_at": ("ALTER TABLE production_revisions ADD COLUMN repaired_at TEXT"),
                "render_task_id": (
                    "ALTER TABLE production_revisions ADD COLUMN render_task_id TEXT"
                ),
                "render_status": (
                    "ALTER TABLE production_revisions ADD COLUMN render_status "
                    "TEXT NOT NULL DEFAULT 'idle'"
                ),
                "render_engine": ("ALTER TABLE production_revisions ADD COLUMN render_engine TEXT"),
                "render_error": ("ALTER TABLE production_revisions ADD COLUMN render_error TEXT"),
                "rendered_at": ("ALTER TABLE production_revisions ADD COLUMN rendered_at TEXT"),
            }
            self._apply_column_migrations(revision_columns, revision_migrations)
            self._connection.execute(
                """
                UPDATE production_jobs
                SET review_status = CASE
                    WHEN status = 'published' THEN 'approved'
                    WHEN status = 'ready' THEN 'pending'
                    ELSE review_status
                END
                WHERE review_status = 'not_ready'
                """
            )

    def _apply_column_migrations(
        self,
        existing: set[str],
        migrations: dict[str, str],
    ) -> None:
        """Apply additive migrations safely when multiple API requests start together."""
        for column, statement in migrations.items():
            if column in existing:
                continue
            try:
                self._connection.execute(statement)
            except sqlite3.OperationalError as exc:
                # Another connection or process can add the column after our
                # PRAGMA snapshot. The desired schema is already in place.
                if "duplicate column name" not in str(exc).lower():
                    raise

    def create_preset(
        self,
        kind: str,
        name: str,
        config: dict[str, Any],
        note: str | None = None,
    ) -> dict[str, Any]:
        """Create a preset and its immutable V1."""
        _validate_preset_kind(kind)
        now = _utc_now()
        preset_id = str(uuid.uuid4())
        version_id = f"{kind}:{preset_id}:v1"
        with self._lock, self._connection:
            self._connection.execute(
                """
                INSERT INTO production_presets (
                    id, kind, name, current_version_id, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?)
                """,
                (preset_id, kind, name.strip(), version_id, now, now),
            )
            self._connection.execute(
                """
                INSERT INTO production_preset_versions (
                    id, preset_id, version, config_json, note, created_at
                ) VALUES (?, ?, 1, ?, ?, ?)
                """,
                (version_id, preset_id, _json(config), note, now),
            )
        return self.get_preset(preset_id)

    def create_preset_version(
        self,
        preset_id: str,
        config: dict[str, Any],
        note: str | None = None,
        kind: str | None = None,
    ) -> dict[str, Any]:
        """Append an immutable version and atomically make it current."""
        if kind is not None:
            _validate_preset_kind(kind)
        now = _utc_now()
        with self._lock, self._connection:
            preset = self._connection.execute(
                "SELECT kind FROM production_presets WHERE id = ?", (preset_id,)
            ).fetchone()
            if preset is None:
                raise KeyError(preset_id)
            if kind is not None and preset["kind"] != kind:
                raise KeyError(preset_id)
            row = self._connection.execute(
                """
                SELECT COALESCE(MAX(version), 0) AS version
                FROM production_preset_versions WHERE preset_id = ?
                """,
                (preset_id,),
            ).fetchone()
            version = int(row["version"]) + 1
            version_id = f"{preset['kind']}:{preset_id}:v{version}"
            self._connection.execute(
                """
                INSERT INTO production_preset_versions (
                    id, preset_id, version, config_json, note, created_at
                ) VALUES (?, ?, ?, ?, ?, ?)
                """,
                (version_id, preset_id, version, _json(config), note, now),
            )
            self._connection.execute(
                """
                UPDATE production_presets
                SET current_version_id = ?, updated_at = ? WHERE id = ?
                """,
                (version_id, now, preset_id),
            )
        return self.get_preset(preset_id)

    def get_preset(self, preset_id: str) -> dict[str, Any]:
        with self._lock:
            preset = self._connection.execute(
                "SELECT * FROM production_presets WHERE id = ?", (preset_id,)
            ).fetchone()
            versions = self._connection.execute(
                """
                SELECT * FROM production_preset_versions
                WHERE preset_id = ? ORDER BY version DESC
                """,
                (preset_id,),
            ).fetchall()
        if preset is None:
            raise KeyError(preset_id)
        result = dict(preset)
        result["versions"] = [_row_to_preset_version(row, result) for row in versions]
        result["current_version"] = next(
            version
            for version in result["versions"]
            if version["id"] == result["current_version_id"]
        )
        return result

    def list_presets(self, kind: str) -> list[dict[str, Any]]:
        _validate_preset_kind(kind)
        with self._lock:
            rows = self._connection.execute(
                """
                SELECT id FROM production_presets
                WHERE kind = ? ORDER BY updated_at DESC, created_at DESC
                """,
                (kind,),
            ).fetchall()
        return [self.get_preset(row["id"]) for row in rows]

    def delete_preset(self, preset_id: str) -> dict[str, Any]:
        preset = self.get_preset(preset_id)
        with self._lock, self._connection:
            count = self._connection.execute(
                "SELECT COUNT(*) AS count FROM production_preset_versions WHERE preset_id = ?",
                (preset_id,),
            ).fetchone()["count"]
            self._connection.execute(
                "DELETE FROM production_preset_versions WHERE preset_id = ?",
                (preset_id,),
            )
            self._connection.execute("DELETE FROM production_presets WHERE id = ?", (preset_id,))
        return {
            "preset": preset,
            "counts": {"presets": 1, "preset_versions": int(count)},
        }

    def get_preset_version(
        self,
        version_id: str,
        kind: str | None = None,
    ) -> dict[str, Any]:
        if kind is not None:
            _validate_preset_kind(kind)
        with self._lock:
            row = self._connection.execute(
                """
                SELECT version.*, preset.kind, preset.name AS preset_name
                FROM production_preset_versions AS version
                JOIN production_presets AS preset ON preset.id = version.preset_id
                WHERE version.id = ?
                """,
                (version_id,),
            ).fetchone()
        if row is None or (kind is not None and row["kind"] != kind):
            raise KeyError(version_id)
        return _row_to_preset_version(row)

    def create_job(
        self,
        channel_id: str,
        topic: str,
        title: str,
        request: dict[str, Any],
        *,
        allow_duplicate: bool = False,
    ) -> dict[str, Any]:
        now = _utc_now()
        job_id = str(uuid.uuid4())
        with self._lock:
            self._connection.execute("BEGIN IMMEDIATE")
            try:
                if not allow_duplicate:
                    duplicate = self._find_duplicate_job(channel_id, topic, title)
                    if duplicate is not None:
                        raise ValueError(
                            f"Duplicate topic already exists in job {duplicate['id']}"
                        )
                self._connection.execute(
                    """
                    INSERT INTO production_jobs (
                        id, channel_id, topic, title, status, request_json,
                        created_at, updated_at
                    ) VALUES (?, ?, ?, ?, 'planned', ?, ?, ?)
                    """,
                    (job_id, channel_id, topic, title, _json(request), now, now),
                )
                self._connection.commit()
            except Exception:
                self._connection.rollback()
                raise
        job = self.get_job(job_id)
        self._record_created_job_event(job_id, channel_id, topic, title)
        return job

    def _record_created_job_event(self, job_id: str, channel_id: str, topic: str, title: str) -> None:
        self.begin_job_event(
            job_id,
            "queue",
            detail={
                "channel_id": channel_id,
                "topic": topic,
                "title": title,
            },
        )

    def topic_already_queued(
        self,
        channel_id: str,
        topic: str,
        title: str = "",
    ) -> dict[str, Any] | None:
        """Return the existing non-cancelled job with the same canonical topic."""
        with self._lock:
            row = self._find_duplicate_job(channel_id, topic, title)
        return _row_to_job(row) if row is not None else None

    def _find_duplicate_job(
        self,
        channel_id: str,
        topic: str,
        title: str,
    ) -> sqlite3.Row | None:
        identity = _topic_identity(topic or title)
        if not identity:
            return None
        rows = self._connection.execute(
            """
            SELECT * FROM production_jobs
            WHERE channel_id = ? AND status != 'cancelled'
            ORDER BY created_at DESC
            """,
            (channel_id,),
        ).fetchall()
        return next(
            (
                row
                for row in rows
                if identity
                in {
                    _topic_identity(str(row["topic"] or "")),
                    _topic_identity(str(row["title"] or "")),
                }
            ),
            None,
        )

    def create_job_from_topic_candidate(
        self,
        candidate_id: str,
        request: dict[str, Any],
    ) -> dict[str, Any]:
        """Create a job and consume its approved candidate in one transaction."""
        now = _utc_now()
        job_id = str(uuid.uuid4())
        with self._lock:
            self._connection.execute("BEGIN IMMEDIATE")
            try:
                candidate = self._connection.execute(
                    """
                    SELECT channel_id, topic, title FROM production_topic_candidates
                    WHERE id = ? AND status IN ('pinned', 'approved')
                    """,
                    (candidate_id,),
                ).fetchone()
                if candidate is None:
                    raise ValueError("Topic candidate is no longer available")
                duplicate = self._find_duplicate_job(
                    candidate["channel_id"], candidate["topic"], candidate["title"]
                )
                if duplicate is not None:
                    raise ValueError(
                        f"Duplicate topic already exists in job {duplicate['id']}"
                    )
                self._connection.execute(
                    """
                    INSERT INTO production_jobs (
                        id, channel_id, topic, title, status, request_json,
                        created_at, updated_at
                    ) VALUES (?, ?, ?, ?, 'planned', ?, ?, ?)
                    """,
                    (
                        job_id,
                        candidate["channel_id"],
                        candidate["topic"],
                        candidate["title"],
                        _json(request),
                        now,
                        now,
                    ),
                )
                self._connection.execute(
                    """
                    UPDATE production_topic_candidates
                    SET status = 'consumed', consumed_job_id = ?, updated_at = ?
                    WHERE id = ?
                    """,
                    (job_id, now, candidate_id),
                )
                self._connection.commit()
            except Exception:
                self._connection.rollback()
                raise
        job = self.get_job(job_id)
        self._record_created_job_event(
            job_id,
            candidate["channel_id"],
            candidate["topic"],
            candidate["title"],
        )
        return job

    def get_job(
        self,
        job_id: str,
        *,
        with_timeline: bool = False,
    ) -> dict[str, Any]:
        with self._lock:
            row = self._connection.execute(
                "SELECT * FROM production_jobs WHERE id = ?", (job_id,)
            ).fetchone()
        if row is None:
            raise KeyError(job_id)
        job = _row_to_job(row)
        if with_timeline:
            job["timeline"] = self.get_job_timeline(job_id)
        return job

    def update_job(self, job_id: str, **updates: Any) -> dict[str, Any]:
        allowed = {
            "status",
            "api_task_id",
            "result_json",
            "error",
            "retries",
            "completed_at",
            "completed_bucket",
            "published_at",
            "review_status",
            "review_note",
            "reviewed_at",
            "title",
            "request_json",
            "storyboard_task_id",
            "storyboard_json",
            "storyboard_status",
            "content_checks_json",
            "content_gate_status",
            "storyboard_reviewed_at",
        }
        unknown = set(updates) - allowed
        if unknown:
            raise ValueError(f"Unsupported job fields: {sorted(unknown)}")
        if "status" in updates and updates["status"] not in JOB_STATUSES:
            raise ValueError(f"Invalid job status: {updates['status']}")
        if "review_status" in updates and updates["review_status"] not in REVIEW_STATUSES:
            raise ValueError(f"Invalid review status: {updates['review_status']}")
        if "result_json" in updates and isinstance(updates["result_json"], (dict, list)):
            updates["result_json"] = _json(updates["result_json"])
        for field in ("request_json", "storyboard_json", "content_checks_json"):
            if field in updates and isinstance(updates[field], (dict, list)):
                updates[field] = _json(updates[field])
        updates["updated_at"] = _utc_now()
        assignments = ", ".join(f"{key} = ?" for key in updates)
        values = list(updates.values()) + [job_id]
        with self._lock, self._connection:
            previous = self._connection.execute(
                "SELECT status, api_task_id FROM production_jobs WHERE id = ?", (job_id,)
            ).fetchone()
            self._connection.execute(
                f"UPDATE production_jobs SET {assignments} WHERE id = ?", values
            )
        job = self.get_job(job_id)
        if previous is not None and previous["status"] != job["status"]:
            self._record_job_status_events(job, previous["status"])
        return job

    def update_job_requests_batch(
        self,
        requests: dict[str, dict[str, Any]],
    ) -> list[dict[str, Any]]:
        """Atomically replace request payloads after an external preflight."""
        now = _utc_now()
        with self._lock:
            self._connection.execute("BEGIN IMMEDIATE")
            try:
                rows = self._connection.execute(
                    f"SELECT id FROM production_jobs WHERE id IN ({','.join('?' for _ in requests)})",
                    tuple(requests),
                ).fetchall()
                if {row["id"] for row in rows} != set(requests):
                    raise KeyError("one or more production jobs no longer exist")
                for job_id, request in requests.items():
                    self._connection.execute(
                        "UPDATE production_jobs SET request_json = ?, updated_at = ? WHERE id = ?",
                        (_json(request), now, job_id),
                    )
                self._connection.commit()
            except Exception:
                self._connection.rollback()
                raise
        return [self.get_job(job_id) for job_id in requests]

    def begin_job_event(
        self,
        job_id: str,
        stage: str,
        *,
        task_id: str | None = None,
        task_type: str | None = None,
        model: str | None = None,
        reuse: str | None = None,
        detail: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Open a timeline event; repeated calls for the same stage/task merge."""
        now = _utc_now()
        with self._lock, self._connection:
            open_row = self._connection.execute(
                """
                SELECT * FROM production_task_events
                WHERE job_id = ? AND stage = ? AND status = 'running' AND ended_at IS NULL
                  AND IFNULL(task_id, '') = IFNULL(?, '')
                ORDER BY created_at DESC LIMIT 1
                """,
                (job_id, stage, task_id),
            ).fetchone()
            if open_row is not None:
                event = dict(open_row)
                if model is not None or reuse is not None or detail is not None:
                    merged = dict(event)
                    existing_detail = json.loads(event.get("detail_json") or "{}")
                    if model is not None:
                        merged["model"] = model
                    if reuse is not None:
                        merged["reuse"] = reuse
                    merged["detail"] = existing_detail
                    if detail is not None:
                        merged["detail"] = {**existing_detail, **detail}
                    self._connection.execute(
                        """
                        UPDATE production_task_events
                        SET model = ?, reuse = ?, detail_json = ?, task_type = IFNULL(?, task_type)
                        WHERE id = ?
                        """,
                        (
                            merged["model"],
                            merged["reuse"],
                            _json(merged["detail"]),
                            task_type,
                            event["id"],
                        ),
                    )
                    event = dict(
                        self._connection.execute(
                            "SELECT * FROM production_task_events WHERE id = ?",
                            (event["id"],),
                        ).fetchone()
                    )
                return _row_to_task_event(event)
            event_id = f"evt:{job_id}:{uuid.uuid4().hex}"
            self._connection.execute(
                """
                INSERT INTO production_task_events(
                    id, job_id, task_id, task_type, stage, event_kind, status,
                    started_at, model, reuse, detail_json, created_at
                ) VALUES (?, ?, ?, ?, ?, 'started', 'running', ?, ?, ?, ?, ?)
                """,
                (
                    event_id,
                    job_id,
                    task_id,
                    task_type,
                    stage,
                    now,
                    model,
                    reuse,
                    _json(detail or {}),
                    now,
                ),
            )
        return self.get_job_event(event_id)

    def get_job_event(self, event_id: str) -> dict[str, Any]:
        with self._lock:
            row = self._connection.execute(
                "SELECT * FROM production_task_events WHERE id = ?", (event_id,)
            ).fetchone()
        if row is None:
            raise KeyError(event_id)
        return _row_to_task_event(row)

    def finish_job_event(
        self,
        job_id: str,
        stage: str,
        *,
        task_id: str | None = None,
        task_type: str | None = None,
        event_kind: str = "completed",
        status: str | None = None,
        model: str | None = None,
        reuse: str | None = None,
        artifacts: list[dict[str, Any]] | None = None,
        recovery: list[str] | None = None,
        detail: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Close the matching open timeline event with duration and outcomes."""
        now = _utc_now()
        with self._lock, self._connection:
            open_row = self._connection.execute(
                """
                SELECT * FROM production_task_events
                WHERE job_id = ? AND stage = ? AND status = 'running' AND ended_at IS NULL
                  AND IFNULL(task_id, '') = IFNULL(?, '')
                ORDER BY created_at DESC LIMIT 1
                """,
                (job_id, stage, task_id),
            ).fetchone()
            if open_row is None:
                event_id = f"evt:{job_id}:{uuid.uuid4().hex}"
                self._connection.execute(
                    """
                    INSERT INTO production_task_events(
                        id, job_id, task_id, task_type, stage, event_kind, status,
                        started_at, ended_at, duration_ms, model, reuse,
                        artifacts_json, recovery_json, detail_json, created_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        event_id,
                        job_id,
                        task_id,
                        task_type,
                        stage,
                        event_kind,
                        status or ("failed" if event_kind == "failed" else "completed"),
                        now,
                        now,
                        model,
                        reuse,
                        _json(artifacts or []),
                        _json(recovery or []),
                        _json(detail or {}),
                        now,
                    ),
                )
                row = self._connection.execute(
                    "SELECT * FROM production_task_events WHERE id = ?", (event_id,)
                ).fetchone()
            else:
                happened_at = open_row["started_at"] or now
                started = _parse_iso_millis(happened_at)
                ended = _parse_iso_millis(now)
                duration_ms = (
                    round((ended - started) * 1000) if started is not None and ended >= started else 0
                )
                current = dict(open_row)
                final_detail = {
                    **(json.loads(current.get("detail_json") or "{}")),
                    **(detail or {}),
                }
                self._connection.execute(
                    """
                    UPDATE production_task_events
                    SET task_type = IFNULL(?, task_type),
                        event_kind = ?, status = ?, ended_at = ?, duration_ms = ?,
                        model = IFNULL(?, model), reuse = IFNULL(?, reuse),
                        artifacts_json = ?, recovery_json = ?, detail_json = ?
                    WHERE id = ?
                    """,
                    (
                        task_type,
                        event_kind,
                        status or ("failed" if event_kind == "failed" else "completed"),
                        now,
                        duration_ms,
                        model,
                        reuse,
                        _json(artifacts or []),
                        _json(recovery or []),
                        _json(final_detail),
                        open_row["id"],
                    ),
                )
                row = self._connection.execute(
                    "SELECT * FROM production_task_events WHERE id = ?", (open_row["id"],)
                ).fetchone()
        return _row_to_task_event(row)

    def append_job_event(
        self,
        job_id: str,
        stage: str,
        event_kind: str,
        *,
        task_id: str | None = None,
        task_type: str | None = None,
        status: str | None = None,
        model: str | None = None,
        reuse: str | None = None,
        artifacts: list[dict[str, Any]] | None = None,
        recovery: list[str] | None = None,
        detail: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Append an explicit one-shot timeline entry (retry, fallback, publish...)."""
        now = _utc_now()
        event_id = f"evt:{job_id}:{uuid.uuid4().hex}"
        with self._lock, self._connection:
            self._connection.execute(
                """
                INSERT INTO production_task_events(
                    id, job_id, task_id, task_type, stage, event_kind, status,
                    started_at, ended_at, duration_ms, model, reuse,
                    artifacts_json, recovery_json, detail_json, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)
                """,
                (
                    event_id,
                    job_id,
                    task_id,
                    task_type,
                    stage,
                    event_kind,
                    status,
                    now,
                    now,
                    model,
                    reuse,
                    _json(artifacts or []),
                    _json(recovery or []),
                    _json(detail or {}),
                    now,
                ),
            )
            row = self._connection.execute(
                "SELECT * FROM production_task_events WHERE id = ?", (event_id,)
            ).fetchone()
        return _row_to_task_event(row)

    def sync_job_progress_stage(
        self,
        job_id: str,
        task_id: str,
        task_type: str,
        stage: str,
        *,
        message: str | None = None,
        detail: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Close the task's previous running event and open the newly observed stage."""
        with self._lock:
            open_row = self._connection.execute(
                """
                SELECT * FROM production_task_events
                WHERE job_id = ? AND task_id = ? AND status = 'running' AND ended_at IS NULL
                ORDER BY created_at DESC LIMIT 1
                """,
                (job_id, task_id),
            ).fetchone()
            if open_row is not None and open_row["stage"] != stage:
                happened_at = open_row["started_at"] or _utc_now()
                ended = _utc_now()
                started = _parse_iso_millis(happened_at)
                ended_at = _parse_iso_millis(ended)
                duration_ms = (
                    round((ended_at - started) * 1000)
                    if started is not None and ended_at >= started
                    else 0
                )
                current_detail = json.loads(open_row["detail_json"] or "{}")
                self._connection.execute(
                    """
                    UPDATE production_task_events
                    SET event_kind = 'completed', status = 'completed',
                        ended_at = ?, duration_ms = ?,
                        detail_json = ?
                    WHERE id = ?
                    """,
                    (
                        ended,
                        duration_ms,
                        _json({**current_detail, "next_stage": stage}),
                        open_row["id"],
                    ),
                )
                return self.begin_job_event(
                    job_id,
                    stage,
                    task_id=task_id,
                    task_type=task_type,
                    detail={**(detail or {}), "message": message} if message else detail,
                )
            if open_row is not None:
                if message or detail:
                    current_detail = json.loads(open_row["detail_json"] or "{}")
                    self._connection.execute(
                        "UPDATE production_task_events SET detail_json = ? WHERE id = ?",
                        (
                            _json(
                                {
                                    **current_detail,
                                    **(detail or {}),
                                    **({"message": message} if message else {}),
                                }
                            ),
                            open_row["id"],
                        ),
                    )
                row = self._connection.execute(
                    "SELECT * FROM production_task_events WHERE id = ?", (open_row["id"],)
                ).fetchone()
                return _row_to_task_event(row)
        return self.begin_job_event(
            job_id,
            stage,
            task_id=task_id,
            task_type=task_type,
            detail={**(detail or {}), "message": message} if message else detail,
        )

    def get_job_timeline(
        self,
        job_id: str,
        limit: int = 500,
    ) -> list[dict[str, Any]]:
        """Return durable structured production events ordered by start time."""
        timelines = self.get_job_timelines([job_id], limit=limit)
        return timelines.get(job_id, [])

    def get_job_timelines(
        self,
        job_ids: Iterable[str],
        limit: int = 500,
    ) -> dict[str, list[dict[str, Any]]]:
        """Return timelines for many jobs in a single query (avoids N+1 lookups)."""
        ids = list(dict.fromkeys(job_id for job_id in job_ids if job_id))
        if not ids:
            return {}
        grouped: dict[str, list[dict[str, Any]]] = {job_id: [] for job_id in ids}
        if limit <= 0:
            return grouped

        # Stay below SQLite builds that retain the traditional 999-variable
        # limit. A windowed per-job limit also avoids materializing every old
        # event when the dashboard requests hundreds of jobs at once.
        with self._lock:
            for offset in range(0, len(ids), 900):
                chunk = ids[offset : offset + 900]
                placeholders = ",".join("?" for _ in chunk)
                rows = self._connection.execute(
                    f"""
                    WITH ranked AS (
                        SELECT *, ROW_NUMBER() OVER (
                            PARTITION BY job_id
                            ORDER BY COALESCE(started_at, created_at) ASC, created_at ASC
                        ) AS timeline_rank
                        FROM production_task_events
                        WHERE job_id IN ({placeholders})
                    )
                    SELECT * FROM ranked
                    WHERE timeline_rank <= ?
                    ORDER BY job_id, timeline_rank
                    """,
                    [*chunk, limit],
                ).fetchall()
                for row in rows:
                    grouped[row["job_id"]].append(_row_to_task_event(row))
        return grouped

    def attach_artifacts_manifest(
        self,
        job_id: str,
        revision_id: str,
        path: str,
        *,
        detail: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Persist the generated artifacts.json and close the finalize timeline event."""
        now = _utc_now()
        file_path = Path(path)
        with self._lock, self._connection:
            self._connection.execute(
                """
                INSERT INTO production_artifacts(
                    id, revision_id, scene_id, kind, path, sha256, media_type, model,
                    params_json, size_bytes, duration, created_at
                ) VALUES (?, ?, NULL, 'artifacts_manifest', ?, ?, 'application/json', NULL, ?, ?, 0, ?)
                ON CONFLICT(id) DO UPDATE SET
                    path = excluded.path,
                    sha256 = excluded.sha256,
                    params_json = excluded.params_json,
                    size_bytes = excluded.size_bytes
                """,
                (
                    f"artifact:{revision_id}:project:artifacts_manifest",
                    revision_id,
                    path,
                    _sha256(file_path),
                    _json({"format": 1}),
                    file_path.stat().st_size if file_path.is_file() else 0,
                    now,
                ),
            )
        return self.finish_job_event(
            job_id,
            "artifacts",
            task_id=None,
            event_kind="completed",
            artifacts=[{"kind": "artifacts_manifest", "path": path, "sha256": _sha256(file_path)}],
            detail=detail,
        )

    def _record_job_status_events(
        self,
        job: dict[str, Any],
        previous_status: str,
    ) -> None:
        """Mirror durable terminal status transitions into the timeline."""
        job_id = job["id"]
        status = job["status"]
        artifacts = _paths_as_event_artifacts(_generated_paths_from_job(job))
        model = _job_event_model(job)
        if status == "ready":
            self.finish_job_event(
                job_id,
                "generation",
                task_id=job.get("api_task_id"),
                task_type="video_generation",
                event_kind="completed",
                model=model,
                artifacts=artifacts,
                detail={"result_status": "completed"},
            )
            self.begin_job_event(
                job_id,
                "quality",
                task_id=job.get("api_task_id"),
                task_type="quality",
                model=model,
            )
        elif status in {"failed", "cancelled"}:
            self.finish_job_event(
                job_id,
                "generation",
                task_id=job.get("api_task_id"),
                task_type="video_generation",
                event_kind=status,
                status=status,
                model=model,
                artifacts=artifacts,
                recovery=["retry", "manual_review"],
                detail={"error": job.get("error"), "previous_status": previous_status},
            )
        elif status == "published":
            self.append_job_event(
                job_id,
                "publish",
                "completed",
                status="completed",
                artifacts=artifacts,
                detail={"published_at": job.get("published_at")},
            )

    def inspect_job_deletion(self, job_id: str) -> dict[str, Any]:
        """Describe every ledger object and generated path owned by one job."""
        job = self.get_job(job_id)
        with self._lock:
            project = self._connection.execute(
                "SELECT id FROM production_projects WHERE job_id = ?", (job_id,)
            ).fetchone()
            revision_ids: list[str] = []
            scene_ids: list[str] = []
            artifact_rows: list[sqlite3.Row] = []
            revision_generated_paths: set[str] = set()
            repair_task_ids: list[str] = []
            regeneration_task_ids: list[str] = []
            if project is not None:
                revision_rows = self._connection.execute(
                    "SELECT id, repair_task_id, config_json FROM production_revisions WHERE project_id = ?",
                    (project["id"],),
                ).fetchall()
                revision_ids = [row["id"] for row in revision_rows]
                for row in revision_rows:
                    try:
                        revision_config = json.loads(row["config_json"] or "{}")
                    except json.JSONDecodeError:
                        revision_config = {}
                    revision_generated_paths.update(_hyperframes_generated_paths(revision_config))
                repair_task_ids = [
                    row["repair_task_id"] for row in revision_rows if row["repair_task_id"]
                ]
                if revision_ids:
                    placeholders = ",".join("?" for _ in revision_ids)
                    scene_rows = self._connection.execute(
                        f"SELECT id, regeneration_task_id FROM production_scenes "
                        f"WHERE revision_id IN ({placeholders})",
                        revision_ids,
                    ).fetchall()
                    scene_ids = [row["id"] for row in scene_rows]
                    regeneration_task_ids = [
                        row["regeneration_task_id"]
                        for row in scene_rows
                        if row["regeneration_task_id"]
                    ]
                    artifact_rows = self._connection.execute(
                        f"SELECT path, size_bytes FROM production_artifacts "
                        f"WHERE revision_id IN ({placeholders})",
                        revision_ids,
                    ).fetchall()
            consumed = self._connection.execute(
                "SELECT COUNT(*) AS count FROM production_topic_candidates "
                "WHERE consumed_job_id = ?",
                (job_id,),
            ).fetchone()["count"]
        paths = {str(row["path"]) for row in artifact_rows if row["path"]}
        paths.update(revision_generated_paths)
        paths.update(_generated_paths_from_job(job))
        task_ids = {
            value
            for value in (
                job.get("api_task_id"),
                job.get("storyboard_task_id"),
                *repair_task_ids,
                *regeneration_task_ids,
            )
            if value
        }
        return {
            "job": job,
            "project_id": project["id"] if project is not None else None,
            "revision_ids": revision_ids,
            "scene_ids": scene_ids,
            "paths": sorted(paths),
            "task_ids": sorted(task_ids),
            "counts": {
                "jobs": 1,
                "projects": int(project is not None),
                "revisions": len(revision_ids),
                "scenes": len(scene_ids),
                "artifacts": len(artifact_rows),
                "restored_topics": int(consumed),
            },
        }

    def delete_job(self, job_id: str) -> dict[str, Any]:
        """Delete a terminal job and its editable project graph atomically."""
        result = self.delete_jobs_batch([job_id])
        return result["items"][0]

    def delete_jobs_batch(self, job_ids: list[str]) -> dict[str, Any]:
        """Atomically delete terminal jobs and every owned ledger record."""
        if not job_ids or len(set(job_ids)) != len(job_ids):
            raise ValueError("job_ids must be a non-empty unique list")
        contexts = [self.inspect_job_deletion(job_id) for job_id in job_ids]
        active = [
            context["job"]["id"]
            for context in contexts
            if context["job"]["status"]
            in {
                "planned",
                "planning",
                "awaiting_storyboard",
                "submitting",
                "pending",
                "running",
            }
        ]
        if active:
            raise ValueError(f"Active jobs must be cancelled before deletion: {', '.join(active)}")

        with self._lock, self._connection:
            for context in contexts:
                job = context["job"]
                revision_ids = context["revision_ids"]
                if revision_ids:
                    placeholders = ",".join("?" for _ in revision_ids)
                    self._connection.execute(
                        f"DELETE FROM production_quality_checks WHERE revision_id IN ({placeholders})",
                        revision_ids,
                    )
                    self._connection.execute(
                        f"DELETE FROM production_artifacts WHERE revision_id IN ({placeholders})",
                        revision_ids,
                    )
                    self._connection.execute(
                        f"DELETE FROM production_scenes WHERE revision_id IN ({placeholders})",
                        revision_ids,
                    )
                    self._connection.execute(
                        f"DELETE FROM production_revisions WHERE id IN ({placeholders})",
                        revision_ids,
                    )
                if context["project_id"]:
                    self._connection.execute(
                        "DELETE FROM production_projects WHERE id = ?",
                        (context["project_id"],),
                    )
                self._connection.execute(
                    """
                    UPDATE production_topic_candidates
                    SET status = 'approved', consumed_job_id = NULL, updated_at = ?
                    WHERE consumed_job_id = ?
                    """,
                    (_utc_now(), job["id"]),
                )
                self._connection.execute("DELETE FROM production_jobs WHERE id = ?", (job["id"],))

        paths = sorted({path for context in contexts for path in context["paths"]})
        paths = [path for path in paths if not self.artifact_path_in_use(path)]
        task_ids = sorted({task for context in contexts for task in context["task_ids"]})
        counts: dict[str, int] = {}
        for context in contexts:
            context["paths"] = [path for path in context["paths"] if path in paths]
            for key, value in context["counts"].items():
                counts[key] = counts.get(key, 0) + int(value)
        return {
            "items": contexts,
            "paths": paths,
            "task_ids": task_ids,
            "counts": counts,
        }

    def artifact_path_in_use(self, path: str) -> bool:
        with self._lock:
            row = self._connection.execute(
                "SELECT 1 FROM production_artifacts WHERE path = ? LIMIT 1", (path,)
            ).fetchone()
        return row is not None

    def list_jobs(
        self,
        channel_id: str | None = None,
        statuses: Iterable[str] | None = None,
        limit: int = 1000,
    ) -> list[dict[str, Any]]:
        clauses: list[str] = []
        values: list[Any] = []
        if channel_id:
            clauses.append("channel_id = ?")
            values.append(channel_id)
        if statuses:
            status_list = list(statuses)
            clauses.append(f"status IN ({','.join('?' for _ in status_list)})")
            values.extend(status_list)
        where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
        values.append(limit)
        with self._lock:
            rows = self._connection.execute(
                f"SELECT * FROM production_jobs {where} ORDER BY created_at DESC LIMIT ?",
                values,
            ).fetchall()
        return [_row_to_job(row) for row in rows]

    def snapshot(self, channel_id: str, completed_bucket: str) -> dict[str, int | bool]:
        with self._lock:
            status_rows = self._connection.execute(
                """
                SELECT status, COUNT(*) AS count
                FROM production_jobs
                WHERE channel_id = ?
                GROUP BY status
                """,
                (channel_id,),
            ).fetchall()
            daily = self._connection.execute(
                """
                SELECT COUNT(*) AS count
                FROM production_jobs
                WHERE channel_id = ? AND completed_bucket = ?
                  AND (
                    status = 'published'
                    OR (status = 'ready' AND review_status IN ('pending', 'approved'))
                  )
                """,
                (channel_id, completed_bucket),
            ).fetchone()["count"]
            review_rows = self._connection.execute(
                """
                SELECT review_status, COUNT(*) AS count
                FROM production_jobs
                WHERE channel_id = ? AND status = 'ready'
                GROUP BY review_status
                """,
                (channel_id,),
            ).fetchall()
        counts = {row["status"]: row["count"] for row in status_rows}
        review_counts = {row["review_status"]: row["count"] for row in review_rows}
        usable_ready = int(review_counts.get("pending", 0)) + int(review_counts.get("approved", 0))
        return {
            **{status: int(counts.get(status, 0)) for status in JOB_STATUSES},
            "ready": usable_ready,
            "in_flight": sum(
                int(counts.get(status, 0))
                for status in (
                    "planned",
                    "planning",
                    "awaiting_storyboard",
                    "submitting",
                    "pending",
                    "running",
                )
            ),
            "completed_today": int(daily),
            "review_pending": int(review_counts.get("pending", 0)),
            "approved": int(review_counts.get("approved", 0)),
            "rejected": int(review_counts.get("rejected", 0)),
            "paused": self.is_channel_paused(channel_id),
        }

    def recent_topics(self, channel_id: str, limit: int) -> list[str]:
        if limit <= 0:
            return []
        with self._lock:
            rows = self._connection.execute(
                """
                SELECT topic FROM production_jobs
                WHERE channel_id = ?
                ORDER BY created_at DESC LIMIT ?
                """,
                (channel_id, limit),
            ).fetchall()
        return [row["topic"] for row in rows]

    def create_topic_candidate(
        self,
        channel_id: str,
        title: str,
        topic: str,
        metadata: dict[str, Any],
    ) -> dict[str, Any]:
        """Insert one scored candidate; return the existing row on exact duplicates."""
        now = _utc_now()
        candidate_id = str(uuid.uuid4())
        values = (
            candidate_id,
            channel_id,
            title.strip(),
            topic.strip(),
            str(metadata.get("cover_copy") or "").strip(),
            str(metadata.get("platform_description") or "").strip(),
            _json(metadata.get("tags") or []),
            str(metadata.get("source_type") or "manual"),
            metadata.get("source_label"),
            str(metadata.get("status") or "new"),
            _json(metadata.get("scores") or {}),
            _json(metadata.get("reasons") or {}),
            _json(metadata.get("semantic_terms") or []),
            _json(metadata.get("semantic_vector") or []),
            _json(metadata.get("title_variants") or []),
            metadata.get("selected_title_id") or "control",
            _json(metadata.get("experiment") or {}),
            str(metadata["fingerprint"]),
            metadata.get("duplicate_of"),
            now,
            now,
        )
        with self._lock, self._connection:
            try:
                self._connection.execute(
                    """
                    INSERT INTO production_topic_candidates (
                        id, channel_id, title, topic, cover_copy,
                        platform_description, tags_json, source_type, source_label,
                        status, score_json, score_reasons_json, semantic_terms_json,
                        semantic_vector_json, title_variants_json, selected_title_id,
                        experiment_json, fingerprint, duplicate_of, created_at, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    values,
                )
            except sqlite3.IntegrityError:
                row = self._connection.execute(
                    """
                    SELECT id FROM production_topic_candidates
                    WHERE channel_id = ? AND fingerprint = ?
                    """,
                    (channel_id, metadata["fingerprint"]),
                ).fetchone()
                if row is None:
                    raise
                candidate_id = row["id"]
        return self.get_topic_candidate(candidate_id)

    def get_topic_candidate(self, candidate_id: str) -> dict[str, Any]:
        with self._lock:
            row = self._connection.execute(
                "SELECT * FROM production_topic_candidates WHERE id = ?",
                (candidate_id,),
            ).fetchone()
        if row is None:
            raise KeyError(candidate_id)
        return _row_to_topic_candidate(row)

    def list_topic_candidates(
        self,
        channel_id: str | None = None,
        statuses: Iterable[str] | None = None,
        limit: int = 200,
    ) -> list[dict[str, Any]]:
        allowed = {"new", "pinned", "approved", "deferred", "discarded", "consumed"}
        clauses: list[str] = []
        values: list[Any] = []
        if channel_id:
            clauses.append("channel_id = ?")
            values.append(channel_id)
        if statuses:
            status_list = list(statuses)
            unknown = set(status_list) - allowed
            if unknown:
                raise ValueError(f"Invalid topic candidate statuses: {sorted(unknown)}")
            clauses.append(f"status IN ({','.join('?' for _ in status_list)})")
            values.extend(status_list)
        where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
        values.append(limit)
        with self._lock:
            rows = self._connection.execute(
                f"""
                SELECT * FROM production_topic_candidates {where}
                ORDER BY CASE status WHEN 'pinned' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END,
                         created_at DESC LIMIT ?
                """,
                values,
            ).fetchall()
        return [_row_to_topic_candidate(row) for row in rows]

    def update_topic_candidate(
        self,
        candidate_id: str,
        status: str,
        decision_note: str | None = None,
        deferred_until: str | None = None,
    ) -> dict[str, Any]:
        allowed = {"new", "pinned", "approved", "deferred", "discarded", "consumed"}
        if status not in allowed:
            raise ValueError(f"Invalid topic candidate status: {status}")
        candidate = self.get_topic_candidate(candidate_id)
        if candidate["status"] == "consumed":
            raise ValueError("Consumed topic candidates cannot be changed")
        with self._lock, self._connection:
            self._connection.execute(
                """
                UPDATE production_topic_candidates
                SET status = ?, decision_note = ?, deferred_until = ?, updated_at = ?
                WHERE id = ?
                """,
                (status, decision_note, deferred_until, _utc_now(), candidate_id),
            )
        return self.get_topic_candidate(candidate_id)

    def delete_topic_candidate(self, candidate_id: str) -> dict[str, Any]:
        candidate = self.get_topic_candidate(candidate_id)
        if candidate["status"] == "consumed" or candidate.get("consumed_job_id"):
            raise ValueError("Delete the generated video before deleting its consumed topic")
        with self._lock, self._connection:
            self._connection.execute(
                "UPDATE production_topic_candidates SET duplicate_of = NULL WHERE duplicate_of = ?",
                (candidate_id,),
            )
            self._connection.execute(
                "DELETE FROM production_topic_candidates WHERE id = ?",
                (candidate_id,),
            )
        return {"candidate": candidate, "counts": {"topics": 1}}

    def select_topic_title(
        self,
        candidate_id: str,
        variant_id: str,
    ) -> dict[str, Any]:
        """Select one immutable experiment variant as the production title."""
        candidate = self.get_topic_candidate(candidate_id)
        if candidate["status"] == "consumed":
            raise ValueError("Consumed topic candidates cannot change title")
        selected = next(
            (item for item in candidate["title_variants"] if item["id"] == variant_id),
            None,
        )
        if selected is None:
            raise ValueError("Title variant not found")
        variants = [
            {**item, "selected": item["id"] == variant_id} for item in candidate["title_variants"]
        ]
        experiment = {
            **candidate["experiment"],
            "selected_title_id": variant_id,
            "selected_at": _utc_now(),
        }
        with self._lock, self._connection:
            self._connection.execute(
                """
                UPDATE production_topic_candidates
                SET title = ?, title_variants_json = ?, selected_title_id = ?,
                    experiment_json = ?, updated_at = ? WHERE id = ?
                """,
                (
                    selected["title"],
                    _json(variants),
                    variant_id,
                    _json(experiment),
                    _utc_now(),
                    candidate_id,
                ),
            )
        return self.get_topic_candidate(candidate_id)

    def next_topic_candidate(
        self,
        channel_id: str,
    ) -> dict[str, Any] | None:
        """Return the oldest pinned candidate, then the best approved one."""
        with self._lock:
            row = self._connection.execute(
                """
                SELECT id FROM production_topic_candidates
                WHERE channel_id = ?
                  AND status IN ('pinned', 'approved')
                  AND (deferred_until IS NULL OR deferred_until <= ?)
                ORDER BY CASE status WHEN 'pinned' THEN 0 ELSE 1 END,
                         CAST(json_extract(score_json, '$.overall') AS INTEGER) DESC,
                         created_at ASC
                LIMIT 1
                """,
                (channel_id, _utc_now()),
            ).fetchone()
        return self.get_topic_candidate(row["id"]) if row is not None else None

    def topic_references(self, channel_id: str, limit: int = 200) -> list[dict[str, Any]]:
        with self._lock:
            rows = self._connection.execute(
                """
                SELECT id, topic, NULL AS semantic_terms_json,
                       NULL AS semantic_vector_json
                FROM production_jobs WHERE channel_id = ?
                UNION ALL
                SELECT id, topic, semantic_terms_json, semantic_vector_json
                FROM production_topic_candidates
                WHERE channel_id = ? AND status != 'discarded'
                LIMIT ?
                """,
                (channel_id, channel_id, limit),
            ).fetchall()
        return [
            {
                "id": row["id"],
                "topic": row["topic"],
                "semantic_terms": json.loads(row["semantic_terms_json"] or "[]"),
                "semantic_vector": json.loads(row["semantic_vector_json"] or "[]"),
            }
            for row in rows
        ]

    def create_content_source(
        self,
        channel_id: str,
        name: str,
        kind: str,
        url: str,
        poll_interval_minutes: int = 360,
        items_per_poll: int = 5,
        candidates_per_item: int = 2,
        enabled: bool = True,
    ) -> dict[str, Any]:
        """Create a scheduled editorial source without fetching it inline."""
        _validate_content_source_kind(kind)
        now = _utc_now()
        source_id = str(uuid.uuid4())
        with self._lock, self._connection:
            self._connection.execute(
                """
                INSERT INTO production_content_sources (
                    id, channel_id, name, kind, url, enabled,
                    poll_interval_minutes, items_per_poll, candidates_per_item,
                    next_poll_at, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    source_id,
                    channel_id,
                    name.strip(),
                    kind,
                    url.strip(),
                    int(enabled),
                    poll_interval_minutes,
                    items_per_poll,
                    candidates_per_item,
                    now if enabled else None,
                    now,
                    now,
                ),
            )
        return self.get_content_source(source_id)

    def get_content_source(self, source_id: str) -> dict[str, Any]:
        with self._lock:
            row = self._connection.execute(
                """
                SELECT s.*, COUNT(i.id) AS item_count
                FROM production_content_sources s
                LEFT JOIN production_source_items i ON i.source_id = s.id
                WHERE s.id = ? GROUP BY s.id
                """,
                (source_id,),
            ).fetchone()
        if row is None:
            raise KeyError(source_id)
        return _row_to_content_source(row)

    def list_content_sources(
        self,
        channel_id: str | None = None,
        limit: int = 200,
    ) -> list[dict[str, Any]]:
        where = "WHERE s.channel_id = ?" if channel_id else ""
        values: list[Any] = [channel_id] if channel_id else []
        values.append(limit)
        with self._lock:
            rows = self._connection.execute(
                f"""
                SELECT s.*, COUNT(i.id) AS item_count
                FROM production_content_sources s
                LEFT JOIN production_source_items i ON i.source_id = s.id
                {where}
                GROUP BY s.id ORDER BY s.updated_at DESC LIMIT ?
                """,
                values,
            ).fetchall()
        return [_row_to_content_source(row) for row in rows]

    def update_content_source(
        self,
        source_id: str,
        updates: dict[str, Any],
    ) -> dict[str, Any]:
        """Update editable source fields while preserving collection history."""
        source = self.get_content_source(source_id)
        allowed = {
            "channel_id",
            "name",
            "kind",
            "url",
            "enabled",
            "poll_interval_minutes",
            "items_per_poll",
            "candidates_per_item",
        }
        unknown = set(updates) - allowed
        if unknown:
            raise ValueError(f"Unsupported content source fields: {sorted(unknown)}")
        if "kind" in updates:
            _validate_content_source_kind(str(updates["kind"]))
        merged = {**source, **updates}
        now = _utc_now()
        next_poll_at = source.get("next_poll_at")
        if bool(merged["enabled"]) and not source["enabled"]:
            next_poll_at = now
        elif not bool(merged["enabled"]):
            next_poll_at = None
        with self._lock, self._connection:
            self._connection.execute(
                """
                UPDATE production_content_sources SET
                    channel_id = ?, name = ?, kind = ?, url = ?, enabled = ?,
                    poll_interval_minutes = ?, items_per_poll = ?,
                    candidates_per_item = ?, next_poll_at = ?, updated_at = ?
                WHERE id = ?
                """,
                (
                    merged["channel_id"],
                    str(merged["name"]).strip(),
                    merged["kind"],
                    str(merged["url"]).strip(),
                    int(bool(merged["enabled"])),
                    int(merged["poll_interval_minutes"]),
                    int(merged["items_per_poll"]),
                    int(merged["candidates_per_item"]),
                    next_poll_at,
                    now,
                    source_id,
                ),
            )
        return self.get_content_source(source_id)

    def delete_content_source(self, source_id: str) -> dict[str, Any]:
        source = self.get_content_source(source_id)
        if source["state"] in {"queued", "polling"}:
            raise ValueError("Content source is collecting; wait or cancel before deletion")
        with self._lock, self._connection:
            count = self._connection.execute(
                "SELECT COUNT(*) AS count FROM production_source_items WHERE source_id = ?",
                (source_id,),
            ).fetchone()["count"]
            self._connection.execute(
                "DELETE FROM production_source_items WHERE source_id = ?", (source_id,)
            )
            self._connection.execute(
                "DELETE FROM production_content_sources WHERE id = ?", (source_id,)
            )
        return {
            "source": source,
            "task_ids": [source["last_task_id"]] if source.get("last_task_id") else [],
            "counts": {"sources": 1, "source_items": int(count)},
        }

    def due_content_sources(self, limit: int = 10) -> list[dict[str, Any]]:
        now = _utc_now()
        with self._lock:
            rows = self._connection.execute(
                """
                SELECT id FROM production_content_sources
                WHERE enabled = 1 AND state NOT IN ('queued', 'polling')
                  AND (next_poll_at IS NULL OR next_poll_at <= ?)
                ORDER BY COALESCE(next_poll_at, created_at) ASC LIMIT ?
                """,
                (now, limit),
            ).fetchall()
        return [self.get_content_source(row["id"]) for row in rows]

    def queue_content_source(
        self,
        source_id: str,
        task_id: str,
        force: bool = False,
    ) -> dict[str, Any]:
        """Reserve a source for one durable task, rejecting active duplicate polls."""
        source = self.get_content_source(source_id)
        if source["state"] in {"queued", "polling"}:
            raise ValueError("Content source is already being collected")
        if not source["enabled"] and not force:
            raise ValueError("Content source is disabled")
        with self._lock, self._connection:
            changed = self._connection.execute(
                """
                UPDATE production_content_sources
                SET state = 'queued', last_task_id = ?, last_error = NULL, updated_at = ?
                WHERE id = ? AND state NOT IN ('queued', 'polling')
                """,
                (task_id, _utc_now(), source_id),
            ).rowcount
        if not changed:
            raise ValueError("Content source is already being collected")
        return self.get_content_source(source_id)

    def mark_content_source_polling(self, source_id: str, task_id: str) -> dict[str, Any]:
        source = self.get_content_source(source_id)
        if source.get("last_task_id") != task_id:
            raise ValueError("Content source task is no longer current")
        with self._lock, self._connection:
            self._connection.execute(
                """
                UPDATE production_content_sources
                SET state = 'polling', last_polled_at = ?, updated_at = ? WHERE id = ?
                """,
                (_utc_now(), _utc_now(), source_id),
            )
        return self.get_content_source(source_id)

    def complete_content_source_poll(
        self,
        source_id: str,
        task_id: str,
        result: dict[str, Any] | None = None,
        error: str | None = None,
        etag: str | None = None,
        last_modified: str | None = None,
    ) -> dict[str, Any]:
        source = self.get_content_source(source_id)
        if source.get("last_task_id") != task_id:
            raise ValueError("Content source task is no longer current")
        now = datetime.now(timezone.utc)
        next_poll = now + timedelta(minutes=int(source["poll_interval_minutes"]))
        with self._lock, self._connection:
            self._connection.execute(
                """
                UPDATE production_content_sources SET
                    state = ?, last_success_at = ?, next_poll_at = ?, last_error = ?,
                    last_result_json = ?, etag = COALESCE(?, etag),
                    last_modified = COALESCE(?, last_modified), updated_at = ?
                WHERE id = ?
                """,
                (
                    "error" if error else "idle",
                    source.get("last_success_at") if error else now.isoformat(),
                    next_poll.isoformat(),
                    error,
                    _json(result or {}),
                    etag,
                    last_modified,
                    now.isoformat(),
                    source_id,
                ),
            )
        return self.get_content_source(source_id)

    def insert_source_item(
        self,
        source_id: str,
        external_id: str | None,
        title: str,
        url: str | None,
        content_excerpt: str,
        fingerprint: str,
        published_at: str | None = None,
    ) -> tuple[dict[str, Any], bool]:
        item_id = str(uuid.uuid4())
        created = True
        with self._lock, self._connection:
            try:
                self._connection.execute(
                    """
                    INSERT INTO production_source_items (
                        id, source_id, external_id, title, url, content_excerpt,
                        fingerprint, published_at, created_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        item_id,
                        source_id,
                        external_id,
                        title.strip(),
                        url,
                        content_excerpt.strip(),
                        fingerprint,
                        published_at,
                        _utc_now(),
                    ),
                )
            except sqlite3.IntegrityError:
                created = False
                row = self._connection.execute(
                    """
                    SELECT id FROM production_source_items
                    WHERE source_id = ? AND fingerprint = ?
                    """,
                    (source_id, fingerprint),
                ).fetchone()
                if row is None:
                    raise
                item_id = row["id"]
        return self.get_source_item(item_id), created

    def get_source_item(self, item_id: str) -> dict[str, Any]:
        with self._lock:
            row = self._connection.execute(
                "SELECT * FROM production_source_items WHERE id = ?", (item_id,)
            ).fetchone()
        if row is None:
            raise KeyError(item_id)
        return _row_to_source_item(row)

    def attach_source_item_candidates(
        self, item_id: str, candidate_ids: list[str]
    ) -> dict[str, Any]:
        self.get_source_item(item_id)
        with self._lock, self._connection:
            self._connection.execute(
                """
                UPDATE production_source_items SET candidate_ids_json = ? WHERE id = ?
                """,
                (_json(candidate_ids), item_id),
            )
        return self.get_source_item(item_id)

    def create_assistant_thread(self, title: str) -> dict[str, Any]:
        thread_id = str(uuid.uuid4())
        now = _utc_now()
        with self._lock, self._connection:
            self._connection.execute(
                """
                INSERT INTO production_assistant_threads(id, title, created_at, updated_at)
                VALUES (?, ?, ?, ?)
                """,
                (thread_id, title.strip()[:160] or "新制片任务", now, now),
            )
        return self.get_assistant_thread(thread_id)

    def get_assistant_thread(self, thread_id: str) -> dict[str, Any]:
        with self._lock:
            row = self._connection.execute(
                "SELECT * FROM production_assistant_threads WHERE id = ?",
                (thread_id,),
            ).fetchone()
            if row is None:
                raise KeyError(thread_id)
            messages = self._connection.execute(
                """
                SELECT * FROM production_assistant_messages
                WHERE thread_id = ? ORDER BY created_at ASC
                """,
                (thread_id,),
            ).fetchall()
            plans = self._connection.execute(
                """
                SELECT * FROM production_assistant_plans
                WHERE thread_id = ? ORDER BY created_at ASC
                """,
                (thread_id,),
            ).fetchall()
        value = dict(row)
        value["messages"] = [_row_to_assistant_message(item) for item in messages]
        value["plans"] = [_row_to_assistant_plan(item) for item in plans]
        return value

    def list_assistant_threads(self, limit: int = 30) -> list[dict[str, Any]]:
        with self._lock:
            rows = self._connection.execute(
                """
                SELECT t.*, COUNT(m.id) AS message_count
                FROM production_assistant_threads t
                LEFT JOIN production_assistant_messages m ON m.thread_id = t.id
                GROUP BY t.id ORDER BY t.updated_at DESC LIMIT ?
                """,
                (limit,),
            ).fetchall()
        return [dict(row) for row in rows]

    def inspect_assistant_thread_deletion(self, thread_id: str) -> dict[str, Any]:
        thread = self.get_assistant_thread(thread_id)
        executing = sum(plan["status"] == "executing" for plan in thread["plans"])
        return {
            "thread": thread,
            "executing": executing,
            "counts": {
                "assistant_threads": 1,
                "assistant_messages": len(thread["messages"]),
                "assistant_plans": len(thread["plans"]),
            },
        }

    def delete_assistant_thread(self, thread_id: str) -> dict[str, Any]:
        context = self.inspect_assistant_thread_deletion(thread_id)
        if context["executing"]:
            raise ValueError("An assistant plan is executing and cannot be deleted")
        with self._lock, self._connection:
            self._connection.execute(
                "DELETE FROM production_assistant_messages WHERE thread_id = ?",
                (thread_id,),
            )
            self._connection.execute(
                "DELETE FROM production_assistant_plans WHERE thread_id = ?",
                (thread_id,),
            )
            self._connection.execute(
                "DELETE FROM production_assistant_threads WHERE id = ?", (thread_id,)
            )
        return context

    def append_assistant_message(
        self,
        thread_id: str,
        role: str,
        content: str,
        payload: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        self.get_assistant_thread(thread_id)
        if role not in {"user", "assistant", "system"}:
            raise ValueError(f"Unsupported assistant role: {role}")
        message_id = str(uuid.uuid4())
        now = _utc_now()
        with self._lock, self._connection:
            self._connection.execute(
                """
                INSERT INTO production_assistant_messages(
                    id, thread_id, role, content, payload_json, created_at
                ) VALUES (?, ?, ?, ?, ?, ?)
                """,
                (message_id, thread_id, role, content.strip(), _json(payload or {}), now),
            )
            self._connection.execute(
                "UPDATE production_assistant_threads SET updated_at = ? WHERE id = ?",
                (now, thread_id),
            )
        with self._lock:
            row = self._connection.execute(
                "SELECT * FROM production_assistant_messages WHERE id = ?",
                (message_id,),
            ).fetchone()
        return _row_to_assistant_message(row)

    def create_assistant_plan(
        self,
        thread_id: str,
        request_message_id: str,
        summary: str,
        actions: list[dict[str, Any]],
    ) -> dict[str, Any]:
        plan_id = str(uuid.uuid4())
        now = _utc_now()
        with self._lock, self._connection:
            self._connection.execute(
                """
                INSERT INTO production_assistant_plans(
                    id, thread_id, request_message_id, status, summary,
                    actions_json, created_at, updated_at
                ) VALUES (?, ?, ?, 'pending', ?, ?, ?, ?)
                """,
                (plan_id, thread_id, request_message_id, summary, _json(actions), now, now),
            )
        return self.get_assistant_plan(plan_id)

    def get_assistant_plan(self, plan_id: str) -> dict[str, Any]:
        with self._lock:
            row = self._connection.execute(
                "SELECT * FROM production_assistant_plans WHERE id = ?", (plan_id,)
            ).fetchone()
        if row is None:
            raise KeyError(plan_id)
        return _row_to_assistant_plan(row)

    def update_assistant_plan(
        self,
        plan_id: str,
        status: str,
        result: dict[str, Any] | None = None,
        error: str | None = None,
        expected_status: str | None = None,
    ) -> dict[str, Any]:
        allowed = {"pending", "rejected", "executing", "completed", "failed"}
        if status not in allowed:
            raise ValueError(f"Unsupported assistant plan status: {status}")
        plan = self.get_assistant_plan(plan_id)
        if plan["status"] in {"completed", "rejected"}:
            raise ValueError("Assistant plan is already terminal")
        now = _utc_now()
        executed_at = now if status in {"completed", "failed"} else None
        with self._lock, self._connection:
            where = "id = ?"
            values: list[Any] = [
                status,
                _json(result or {}),
                error,
                now,
                executed_at,
                plan_id,
            ]
            if expected_status is not None:
                where += " AND status = ?"
                values.append(expected_status)
            cursor = self._connection.execute(
                f"""
                UPDATE production_assistant_plans
                SET status = ?, result_json = ?, error = ?, updated_at = ?,
                    executed_at = COALESCE(?, executed_at) WHERE {where}
                """,
                values,
            )
            if cursor.rowcount != 1:
                raise ValueError("Assistant plan status changed concurrently")
            self._connection.execute(
                "UPDATE production_assistant_threads SET updated_at = ? WHERE id = ?",
                (now, plan["thread_id"]),
            )
        return self.get_assistant_plan(plan_id)

    def save_storyboard_plan(
        self,
        job_id: str,
        task_id: str,
        plan: dict[str, Any],
        status: str = "awaiting_storyboard",
    ) -> dict[str, Any]:
        """Persist one pre-generation storyboard and its content audit."""
        job = self.get_job(job_id)
        if job.get("storyboard_task_id") != task_id:
            raise ValueError("Storyboard planning task is no longer current")
        return self.update_job(
            job_id,
            title=plan.get("title") or job.get("title"),
            status=status,
            storyboard_json=plan,
            storyboard_status="review_pending",
            content_checks_json=plan.get("content_checks") or [],
            content_gate_status=plan.get("content_gate_status") or "pending",
            error=None,
        )

    def approve_storyboard(self, job_id: str, override: bool = False) -> dict[str, Any]:
        """Freeze a reviewed plan into the future media-generation request."""
        job = self.get_job(job_id)
        if job["status"] != "awaiting_storyboard" or not job.get("storyboard"):
            raise ValueError("This job has no storyboard waiting for approval")
        if job.get("content_gate_status") == "fail" and not override:
            raise ValueError("Content gate failed; edit the storyboard or explicitly override")
        plan = job["storyboard"]
        scenes = plan.get("scenes") or []
        request = {
            **job["request"],
            "title": plan.get("title") or job.get("title"),
            "n_scenes": len(scenes),
            "narrations": [scene.get("narration") or "" for scene in scenes],
            "image_prompts": [scene.get("visual_prompt") or "" for scene in scenes],
            "scene_directions": [
                {
                    "image_motion": scene.get("image_motion") or "ken_burns",
                    "transition": scene.get("transition")
                    or ("none" if index == 0 else "crossfade"),
                    "transition_duration": (
                        0.0
                        if index == 0
                        else float(
                            scene.get("transition_duration")
                            if scene.get("transition_duration") is not None
                            else 0.35
                        )
                    ),
                    "direction_reason": scene.get("direction_reason") or "",
                    "subtitle_effect": scene.get("subtitle_effect"),
                    "subtitle_keywords": scene.get("subtitle_keywords") or [],
                    "subtitle_start_offset": float(
                        scene.get("subtitle_start_offset") or 0
                    ),
                    "subtitle_end_offset": float(scene.get("subtitle_end_offset") or 0),
                    "focus_x": scene.get("focus_x"),
                    "focus_y": scene.get("focus_y"),
                    "focus_confidence": scene.get("focus_confidence"),
                    "focus_source": scene.get("focus_source"),
                }
                for index, scene in enumerate(scenes)
            ],
        }
        return self.update_job(
            job_id,
            status="planned",
            request_json=request,
            storyboard_status="approved",
            storyboard_reviewed_at=_utc_now(),
            error=None,
        )

    def mark_published(self, channel_id: str, count: int) -> list[dict[str, Any]]:
        with self._lock:
            rows = self._connection.execute(
                """
                SELECT id FROM production_jobs
                WHERE channel_id = ? AND status = 'ready'
                  AND review_status = 'approved'
                ORDER BY completed_at ASC LIMIT ?
                """,
                (channel_id, count),
            ).fetchall()
        published = []
        for row in rows:
            published.append(
                self.update_job(
                    row["id"],
                    status="published",
                    published_at=_utc_now(),
                )
            )
        return published

    def review_job(
        self,
        job_id: str,
        review_status: str,
        note: str | None = None,
    ) -> dict[str, Any]:
        """Approve or reject a completed production job."""
        if review_status not in {"approved", "rejected"}:
            raise ValueError(f"Invalid review decision: {review_status}")
        job = self.get_job(job_id)
        if job["status"] != "ready":
            raise ValueError("Only ready jobs can be reviewed")
        return self.update_job(
            job_id,
            review_status=review_status,
            review_note=(note or None),
            reviewed_at=_utc_now(),
        )

    def review_jobs_batch(
        self,
        job_ids: list[str],
        review_status: str,
        note: str | None = None,
    ) -> list[dict[str, Any]]:
        """Apply one review decision atomically after all targets are locked and rechecked."""
        if review_status not in {"approved", "rejected"}:
            raise ValueError(f"Invalid review decision: {review_status}")
        if not job_ids or len(set(job_ids)) != len(job_ids):
            raise ValueError("Batch review requires unique job ids")
        placeholders = ",".join("?" for _ in job_ids)
        reviewed_at = _utc_now()
        with self._lock:
            self._connection.execute("BEGIN IMMEDIATE")
            try:
                rows = self._connection.execute(
                    f"SELECT id, status FROM production_jobs WHERE id IN ({placeholders})",
                    job_ids,
                ).fetchall()
                status_by_id = {row["id"]: row["status"] for row in rows}
                unavailable = [job_id for job_id in job_ids if status_by_id.get(job_id) != "ready"]
                if unavailable:
                    raise ValueError(
                        f"Batch review targets are missing or no longer ready: {', '.join(unavailable)}"
                    )
                self._connection.executemany(
                    """
                    UPDATE production_jobs
                    SET review_status = ?, review_note = ?, reviewed_at = ?, updated_at = ?
                    WHERE id = ? AND status = 'ready'
                    """,
                    [
                        (review_status, note or None, reviewed_at, reviewed_at, job_id)
                        for job_id in job_ids
                    ],
                )
                self._connection.commit()
            except Exception:
                self._connection.rollback()
                raise
        return [self.get_job(job_id) for job_id in job_ids]

    def list_library(
        self,
        channel_id: str | None = None,
        review_status: str | None = None,
        limit: int = 100,
    ) -> list[dict[str, Any]]:
        """List generated videos that are ready for review or already published."""
        clauses = ["status IN ('ready', 'published')"]
        values: list[Any] = []
        if channel_id:
            clauses.append("channel_id = ?")
            values.append(channel_id)
        if review_status:
            if review_status not in REVIEW_STATUSES:
                raise ValueError(f"Invalid review status: {review_status}")
            clauses.append("review_status = ?")
            values.append(review_status)
        values.append(limit)
        with self._lock:
            rows = self._connection.execute(
                f"""
                SELECT * FROM production_jobs
                WHERE {" AND ".join(clauses)}
                ORDER BY COALESCE(completed_at, updated_at) DESC LIMIT ?
                """,
                values,
            ).fetchall()
        return [_row_to_job(row) for row in rows]

    def set_channel_paused(self, channel_id: str, paused: bool) -> dict[str, Any]:
        """Persist a manual pause independently of the runner process."""
        now = _utc_now()
        with self._lock, self._connection:
            self._connection.execute(
                """
                INSERT INTO production_channel_state(channel_id, paused, updated_at)
                VALUES (?, ?, ?)
                ON CONFLICT(channel_id) DO UPDATE SET
                    paused = excluded.paused,
                    updated_at = excluded.updated_at
                """,
                (channel_id, int(paused), now),
            )
        return {"channel_id": channel_id, "paused": paused, "updated_at": now}

    def is_channel_paused(self, channel_id: str) -> bool:
        with self._lock:
            row = self._connection.execute(
                "SELECT paused FROM production_channel_state WHERE channel_id = ?",
                (channel_id,),
            ).fetchone()
        return bool(row["paused"]) if row else False

    def channel_dependencies(self, channel_id: str) -> dict[str, int]:
        tables = {
            "jobs": "production_jobs",
            "topics": "production_topic_candidates",
            "sources": "production_content_sources",
            "projects": "production_projects",
        }
        with self._lock:
            counts = {
                label: int(
                    self._connection.execute(
                        f"SELECT COUNT(*) AS count FROM {table} WHERE channel_id = ?",
                        (channel_id,),
                    ).fetchone()["count"]
                )
                for label, table in tables.items()
            }
        return counts

    def delete_channel_state(self, channel_id: str) -> None:
        with self._lock, self._connection:
            self._connection.execute(
                "DELETE FROM production_channel_state WHERE channel_id = ?", (channel_id,)
            )

    def import_project_revision(
        self,
        job_id: str,
        storyboard: dict[str, Any],
        metadata: dict[str, Any],
        quality_checks: list[dict[str, Any]],
    ) -> dict[str, Any]:
        """Import one completed task into the durable editable project model."""
        job = self.get_job(job_id)
        now = _utc_now()
        project_id = f"project:{job_id}"
        revision_id = f"revision:{job_id}:1"
        quality_status = _quality_rollup(quality_checks)
        with self._lock, self._connection:
            self._connection.execute(
                """
                INSERT INTO production_projects(
                    id, channel_id, job_id, title, topic, current_revision_id,
                    created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(job_id) DO UPDATE SET
                    title = excluded.title,
                    topic = excluded.topic,
                    updated_at = excluded.updated_at
                """,
                (
                    project_id,
                    job["channel_id"],
                    job_id,
                    storyboard.get("title") or job.get("title") or job["topic"],
                    job["topic"],
                    revision_id,
                    job["created_at"],
                    now,
                ),
            )
            self._connection.execute(
                """
                INSERT INTO production_revisions(
                    id, project_id, number, source_task_id, status, note,
                    config_json, quality_status, created_at, activated_at
                ) VALUES (?, ?, 1, ?, 'active', ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    source_task_id = excluded.source_task_id,
                    config_json = excluded.config_json,
                    quality_status = excluded.quality_status,
                    activated_at = excluded.activated_at
                """,
                (
                    revision_id,
                    project_id,
                    job.get("api_task_id"),
                    "Imported from completed production task",
                    _json(storyboard.get("config") or metadata.get("input") or {}),
                    quality_status,
                    storyboard.get("created_at") or job["created_at"],
                    storyboard.get("completed_at") or job.get("completed_at") or now,
                ),
            )
            for position, frame in enumerate(storyboard.get("frames") or []):
                scene_id = f"scene:{revision_id}:{position + 1}"
                self._connection.execute(
                    """
                    INSERT INTO production_scenes(
                        id, revision_id, position, narration, visual_prompt,
                        image_motion, transition, transition_duration, direction_reason,
                        subtitle_effect, subtitle_effect_applied,
                        subtitle_effect_fallback_reason, subtitle_keywords_json,
                        subtitle_start_offset, subtitle_end_offset,
                        focus_x, focus_y, focus_confidence, focus_source, locked,
                        duration, audio_path, media_path, segment_path, created_at, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(revision_id, position) DO UPDATE SET
                        narration = excluded.narration,
                        visual_prompt = excluded.visual_prompt,
                        image_motion = excluded.image_motion,
                        transition = excluded.transition,
                        transition_duration = excluded.transition_duration,
                        direction_reason = excluded.direction_reason,
                        subtitle_effect = excluded.subtitle_effect,
                        subtitle_effect_applied = excluded.subtitle_effect_applied,
                        subtitle_effect_fallback_reason = excluded.subtitle_effect_fallback_reason,
                        subtitle_keywords_json = excluded.subtitle_keywords_json,
                        subtitle_start_offset = excluded.subtitle_start_offset,
                        subtitle_end_offset = excluded.subtitle_end_offset,
                        focus_x = excluded.focus_x,
                        focus_y = excluded.focus_y,
                        focus_confidence = excluded.focus_confidence,
                        focus_source = excluded.focus_source,
                        duration = excluded.duration,
                        audio_path = excluded.audio_path,
                        media_path = excluded.media_path,
                        segment_path = excluded.segment_path,
                        updated_at = excluded.updated_at
                    """,
                    (
                        scene_id,
                        revision_id,
                        position,
                        frame.get("narration") or "",
                        frame.get("image_prompt") or "",
                        frame.get("image_motion") or "none",
                        frame.get("transition") or ("none" if position == 0 else "crossfade"),
                        float(
                            frame.get("transition_duration")
                            if frame.get("transition_duration") is not None
                            else 0
                            if position == 0
                            else 0.35
                        ),
                        frame.get("direction_reason"),
                        frame.get("subtitle_effect"),
                        frame.get("subtitle_effect_applied"),
                        frame.get("subtitle_effect_fallback_reason"),
                        _json(frame.get("subtitle_keywords") or []),
                        float(frame.get("subtitle_start_offset") or 0),
                        float(frame.get("subtitle_end_offset") or 0),
                        frame.get("focus_x"),
                        frame.get("focus_y"),
                        frame.get("focus_confidence"),
                        frame.get("focus_source"),
                        float(frame.get("duration") or 0),
                        frame.get("audio_path"),
                        frame.get("video_path") or frame.get("image_path"),
                        frame.get("video_segment_path") or frame.get("composed_image_path"),
                        frame.get("created_at") or now,
                        now,
                    ),
                )
                for kind, path, media_type in (
                    ("audio", frame.get("audio_path"), "audio"),
                    (
                        "source_media",
                        frame.get("video_path") or frame.get("image_path"),
                        frame.get("media_type"),
                    ),
                    ("overlay", frame.get("composed_image_path"), "image"),
                    ("text_overlay", frame.get("overlay_image_path"), "image"),
                    ("subtitle_overlay", frame.get("subtitle_overlay_path"), "image"),
                    ("whiteboard_silent", frame.get("whiteboard_silent_path"), "video"),
                    (
                        "whiteboard_analysis",
                        frame.get("whiteboard_analysis_path"),
                        "application/json",
                    ),
                    ("segment", frame.get("video_segment_path"), "video"),
                ):
                    if path:
                        self._upsert_artifact(
                            revision_id,
                            scene_id,
                            kind,
                            path,
                            media_type,
                            metadata,
                            float(frame.get("duration") or 0),
                            now,
                        )
            template_snapshot = (storyboard.get("config") or {}).get("template_snapshot_path")
            if template_snapshot:
                self._upsert_artifact(
                    revision_id,
                    None,
                    "template_snapshot",
                    template_snapshot,
                    "text/html",
                    metadata,
                    0,
                    now,
                )
            config = storyboard.get("config") or {}
            for kind, path, media_type in (
                (
                    "hyperframes_project",
                    config.get("hyperframes_manifest_path"),
                    "application/json",
                ),
                ("check_report", config.get("hyperframes_check_report_path"), "application/json"),
            ):
                if path:
                    self._upsert_artifact(
                        revision_id,
                        None,
                        kind,
                        path,
                        media_type,
                        metadata,
                        0,
                        now,
                    )
            final_path = storyboard.get("final_video_path") or (metadata.get("result") or {}).get(
                "video_path"
            )
            if final_path:
                self._upsert_artifact(
                    revision_id,
                    None,
                    "final_video",
                    final_path,
                    "video",
                    metadata,
                    float(storyboard.get("total_duration") or 0),
                    now,
                )
            for check in quality_checks:
                self._connection.execute(
                    """
                    INSERT INTO production_quality_checks(
                        id, revision_id, check_name, status, detail_json, created_at
                    ) VALUES (?, ?, ?, ?, ?, ?)
                    ON CONFLICT(revision_id, check_name) DO UPDATE SET
                        status = excluded.status,
                        detail_json = excluded.detail_json,
                        created_at = excluded.created_at
                    """,
                    (
                        f"quality:{revision_id}:{check['name']}",
                        revision_id,
                        check["name"],
                        check["status"],
                        _json(check.get("detail") or {}),
                        now,
                    ),
                )
        return self.get_project(project_id)

    def _upsert_artifact(
        self,
        revision_id: str,
        scene_id: str | None,
        kind: str,
        path: str,
        media_type: str | None,
        metadata: dict[str, Any],
        duration: float,
        now: str,
    ) -> None:
        file_path = Path(path)
        size = file_path.stat().st_size if file_path.is_file() else 0
        model = (metadata.get("config") or {}).get("llm_model")
        identity = scene_id or "project"
        self._connection.execute(
            """
            INSERT INTO production_artifacts(
                id, revision_id, scene_id, kind, path, sha256, media_type, model,
                params_json, size_bytes, duration, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                path = excluded.path,
                sha256 = excluded.sha256,
                media_type = excluded.media_type,
                model = excluded.model,
                params_json = excluded.params_json,
                size_bytes = excluded.size_bytes,
                duration = excluded.duration
            """,
            (
                f"artifact:{revision_id}:{identity}:{kind}",
                revision_id,
                scene_id,
                kind,
                path,
                _sha256(file_path),
                media_type,
                model,
                _json(metadata.get("input") or {}),
                size,
                duration,
                now,
            ),
        )

    def list_projects(
        self,
        channel_id: str | None = None,
        limit: int = 100,
    ) -> list[dict[str, Any]]:
        clauses: list[str] = []
        values: list[Any] = []
        if channel_id:
            clauses.append("p.channel_id = ?")
            values.append(channel_id)
        where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
        values.append(limit)
        with self._lock:
            rows = self._connection.execute(
                f"""
                SELECT p.*, r.number AS current_revision_number,
                       r.quality_status, r.status AS revision_status,
                       COUNT(s.id) AS scene_count
                FROM production_projects p
                LEFT JOIN production_revisions r ON r.id = p.current_revision_id
                LEFT JOIN production_scenes s ON s.revision_id = r.id
                {where}
                GROUP BY p.id
                ORDER BY p.updated_at DESC LIMIT ?
                """,
                values,
            ).fetchall()
        return [dict(row) for row in rows]

    def get_project(self, project_id: str) -> dict[str, Any]:
        with self._lock:
            project = self._connection.execute(
                "SELECT * FROM production_projects WHERE id = ?", (project_id,)
            ).fetchone()
            if project is None:
                raise KeyError(project_id)
            revisions = self._connection.execute(
                """
                SELECT * FROM production_revisions
                WHERE project_id = ? ORDER BY number DESC
                """,
                (project_id,),
            ).fetchall()
        value = dict(project)
        value["revisions"] = [self.get_revision(row["id"]) for row in revisions]
        return value

    def get_project_by_job(self, job_id: str) -> dict[str, Any]:
        with self._lock:
            row = self._connection.execute(
                "SELECT id FROM production_projects WHERE job_id = ?", (job_id,)
            ).fetchone()
        if row is None:
            raise KeyError(job_id)
        return self.get_project(row["id"])

    def get_revision(self, revision_id: str) -> dict[str, Any]:
        with self._lock:
            revision = self._connection.execute(
                "SELECT * FROM production_revisions WHERE id = ?", (revision_id,)
            ).fetchone()
            if revision is None:
                raise KeyError(revision_id)
            scenes = self._connection.execute(
                """
                SELECT * FROM production_scenes
                WHERE revision_id = ? ORDER BY position
                """,
                (revision_id,),
            ).fetchall()
            artifacts = self._connection.execute(
                "SELECT * FROM production_artifacts WHERE revision_id = ?",
                (revision_id,),
            ).fetchall()
            checks = self._connection.execute(
                """
                SELECT * FROM production_quality_checks
                WHERE revision_id = ? ORDER BY check_name
                """,
                (revision_id,),
            ).fetchall()
        value = dict(revision)
        value["config"] = json.loads(value.pop("config_json"))
        raw_repair_plan = value.pop("repair_plan_json", None)
        value["repair_plan"] = json.loads(raw_repair_plan) if raw_repair_plan else None
        artifacts_by_scene: dict[str | None, list[dict[str, Any]]] = {}
        for row in artifacts:
            artifact = dict(row)
            artifact["params"] = json.loads(artifact.pop("params_json"))
            artifacts_by_scene.setdefault(artifact["scene_id"], []).append(artifact)
        value["scenes"] = []
        for row in scenes:
            scene = dict(row)
            scene["locked"] = bool(scene["locked"])
            raw_keywords = scene.pop("subtitle_keywords_json", None)
            scene["subtitle_keywords"] = json.loads(raw_keywords or "[]")
            scene["artifacts"] = artifacts_by_scene.get(scene["id"], [])
            value["scenes"].append(scene)
        value["artifacts"] = artifacts_by_scene.get(None, [])
        value["quality_checks"] = []
        for row in checks:
            check = dict(row)
            check["detail"] = json.loads(check.pop("detail_json"))
            value["quality_checks"].append(check)
        return value

    def inspect_revision_deletion(self, revision_id: str) -> dict[str, Any]:
        revision = self.get_revision(revision_id)
        with self._lock:
            project = self._connection.execute(
                "SELECT * FROM production_projects WHERE id = ?",
                (revision["project_id"],),
            ).fetchone()
            revision_count = self._connection.execute(
                "SELECT COUNT(*) AS count FROM production_revisions WHERE project_id = ?",
                (revision["project_id"],),
            ).fetchone()["count"]
        paths = {artifact["path"] for artifact in revision["artifacts"] if artifact.get("path")}
        for scene in revision["scenes"]:
            paths.update(
                value
                for value in (
                    scene.get("audio_path"),
                    scene.get("media_path"),
                    scene.get("segment_path"),
                    *(artifact.get("path") for artifact in scene["artifacts"]),
                )
                if value
            )
        task_ids = {
            value
            for value in (
                revision.get("repair_task_id"),
                revision.get("render_task_id"),
                *(scene.get("regeneration_task_id") for scene in revision["scenes"]),
            )
            if value
        }
        return {
            "revision": revision,
            "project": dict(project) if project is not None else None,
            "revision_count": int(revision_count),
            "paths": sorted(paths),
            "task_ids": sorted(task_ids),
            "counts": {
                "revisions": 1,
                "scenes": len(revision["scenes"]),
                "artifacts": sum(len(scene["artifacts"]) for scene in revision["scenes"])
                + len(revision["artifacts"]),
                "quality_checks": len(revision["quality_checks"]),
            },
        }

    def delete_revision(self, revision_id: str) -> dict[str, Any]:
        context = self.inspect_revision_deletion(revision_id)
        revision = context["revision"]
        project = context["project"]
        if project is None:
            raise ValueError("Revision project no longer exists")
        if project["current_revision_id"] == revision_id or revision["status"] == "active":
            raise ValueError("The current active revision cannot be deleted")
        if context["revision_count"] <= 1:
            raise ValueError("A project must retain at least one revision")
        if revision.get("repair_status") in {"planned", "pending", "running"}:
            raise ValueError("Revision repair is active and cannot be deleted")
        if revision.get("render_status") in {"planned", "pending", "running"}:
            raise ValueError("Revision rendering is active and cannot be deleted")
        if any(
            scene.get("regeneration_status") in {"pending", "running"}
            for scene in revision["scenes"]
        ):
            raise ValueError("Scene regeneration is active and cannot be deleted")
        with self._lock, self._connection:
            self._connection.execute(
                "UPDATE production_revisions SET parent_revision_id = ? "
                "WHERE parent_revision_id = ?",
                (revision.get("parent_revision_id"), revision_id),
            )
            self._connection.execute(
                "DELETE FROM production_quality_checks WHERE revision_id = ?",
                (revision_id,),
            )
            self._connection.execute(
                "DELETE FROM production_artifacts WHERE revision_id = ?", (revision_id,)
            )
            self._connection.execute(
                "DELETE FROM production_scenes WHERE revision_id = ?", (revision_id,)
            )
            self._connection.execute(
                "DELETE FROM production_revisions WHERE id = ?", (revision_id,)
            )
            self._connection.execute(
                "UPDATE production_projects SET updated_at = ? WHERE id = ?",
                (_utc_now(), revision["project_id"]),
            )
        context["paths"] = [
            path for path in context["paths"] if not self.artifact_path_in_use(path)
        ]
        return context

    def inspect_scene_deletion(self, scene_id: str) -> dict[str, Any]:
        context = self.get_scene_context(scene_id)
        scene = context["scene"]
        revision = context["revision"]
        with self._lock:
            artifacts = self._connection.execute(
                "SELECT * FROM production_artifacts WHERE scene_id = ?", (scene_id,)
            ).fetchall()
            scene_count = self._connection.execute(
                "SELECT COUNT(*) AS count FROM production_scenes WHERE revision_id = ?",
                (revision["id"],),
            ).fetchone()["count"]
        paths = {
            value
            for value in (
                scene.get("audio_path"),
                scene.get("media_path"),
                scene.get("segment_path"),
                *(row["path"] for row in artifacts),
            )
            if value
        }
        return {
            **context,
            "scene_count": int(scene_count),
            "paths": sorted(paths),
            "task_ids": (
                [scene["regeneration_task_id"]] if scene.get("regeneration_task_id") else []
            ),
            "counts": {"scenes": 1, "artifacts": len(artifacts)},
        }

    def delete_scene(self, scene_id: str) -> dict[str, Any]:
        context = self.inspect_scene_deletion(scene_id)
        scene = context["scene"]
        revision = context["revision"]
        if revision["status"] != "draft":
            raise ValueError("Only scenes in a draft revision can be deleted")
        if scene["locked"]:
            raise ValueError("Unlock the scene before deletion")
        if context["scene_count"] <= 1:
            raise ValueError("A revision must retain at least one scene")
        if scene.get("regeneration_status") in {"pending", "running"}:
            raise ValueError("Scene regeneration is active and cannot be deleted")
        with self._lock, self._connection:
            self._connection.execute(
                "DELETE FROM production_artifacts WHERE scene_id = ?", (scene_id,)
            )
            self._connection.execute("DELETE FROM production_scenes WHERE id = ?", (scene_id,))
            remaining = self._connection.execute(
                "SELECT id FROM production_scenes WHERE revision_id = ? ORDER BY position",
                (revision["id"],),
            ).fetchall()
            for position, row in enumerate(remaining):
                self._connection.execute(
                    "UPDATE production_scenes SET position = ?, updated_at = ? WHERE id = ?",
                    (position, _utc_now(), row["id"]),
                )
            self._connection.execute(
                "DELETE FROM production_quality_checks WHERE revision_id = ?",
                (revision["id"],),
            )
            self._connection.execute(
                "UPDATE production_revisions SET quality_status = 'stale' WHERE id = ?",
                (revision["id"],),
            )
            self._connection.execute(
                "UPDATE production_projects SET updated_at = ? WHERE id = ?",
                (_utc_now(), revision["project_id"]),
            )
        context["paths"] = [
            path for path in context["paths"] if not self.artifact_path_in_use(path)
        ]
        return context

    def create_revision(
        self,
        project_id: str,
        note: str | None = None,
        source_revision_id: str | None = None,
    ) -> dict[str, Any]:
        project = self.get_project(project_id)
        source = self.get_revision(source_revision_id or project["current_revision_id"])
        if source["project_id"] != project_id:
            raise ValueError("Source revision does not belong to this project")
        next_number = max(item["number"] for item in project["revisions"]) + 1
        revision_id = f"revision:{project_id}:{next_number}:{uuid.uuid4().hex[:8]}"
        now = _utc_now()
        with self._lock, self._connection:
            self._connection.execute(
                """
                INSERT INTO production_revisions(
                    id, project_id, number, parent_revision_id, source_task_id,
                    status, note, config_json, quality_status, created_at
                ) VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, 'stale', ?)
                """,
                (
                    revision_id,
                    project_id,
                    next_number,
                    source["id"],
                    source.get("source_task_id"),
                    note,
                    _json(source["config"]),
                    now,
                ),
            )
            scene_id_map: dict[str, str] = {}
            for scene in source["scenes"]:
                scene_id = f"scene:{revision_id}:{scene['position'] + 1}"
                scene_id_map[scene["id"]] = scene_id
                self._connection.execute(
                    """
                    INSERT INTO production_scenes(
                        id, revision_id, position, narration, visual_prompt,
                        image_motion, transition, transition_duration, direction_reason,
                        subtitle_effect, subtitle_effect_applied,
                        subtitle_effect_fallback_reason, subtitle_keywords_json,
                        subtitle_start_offset, subtitle_end_offset,
                        focus_x, focus_y, focus_confidence, focus_source, locked,
                        duration, audio_path, media_path, segment_path, created_at, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        scene_id,
                        revision_id,
                        scene["position"],
                        scene["narration"],
                        scene["visual_prompt"],
                        scene.get("image_motion") or "none",
                        scene.get("transition") or "crossfade",
                        float(scene.get("transition_duration") or 0),
                        scene.get("direction_reason"),
                        scene.get("subtitle_effect"),
                        scene.get("subtitle_effect_applied"),
                        scene.get("subtitle_effect_fallback_reason"),
                        _json(scene.get("subtitle_keywords") or []),
                        float(scene.get("subtitle_start_offset") or 0),
                        float(scene.get("subtitle_end_offset") or 0),
                        scene.get("focus_x"),
                        scene.get("focus_y"),
                        scene.get("focus_confidence"),
                        scene.get("focus_source"),
                        int(scene["locked"]),
                        scene["duration"],
                        scene["audio_path"],
                        scene["media_path"],
                        scene["segment_path"],
                        now,
                        now,
                    ),
                )
            for artifact in [
                *source["artifacts"],
                *(item for scene in source["scenes"] for item in scene["artifacts"]),
            ]:
                copied_scene_id = scene_id_map.get(artifact["scene_id"])
                identity = copied_scene_id or "project"
                self._connection.execute(
                    """
                    INSERT INTO production_artifacts(
                        id, revision_id, scene_id, kind, path, sha256, media_type,
                        model, params_json, size_bytes, duration, created_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        f"artifact:{revision_id}:{identity}:{artifact['kind']}",
                        revision_id,
                        copied_scene_id,
                        artifact["kind"],
                        artifact["path"],
                        artifact["sha256"],
                        artifact["media_type"],
                        artifact["model"],
                        _json(artifact["params"]),
                        artifact["size_bytes"],
                        artifact["duration"],
                        now,
                    ),
                )
        return self.get_revision(revision_id)

    def create_renderer_variant(
        self,
        source_revision_id: str,
        engine: str,
    ) -> dict[str, Any]:
        """Clone one revision into a renderer-only variant with identical source assets."""
        if engine not in {"native_image_html", "hyperframes", "whiteboard_cv"}:
            raise ValueError(f"Unsupported renderer variant: {engine}")
        source = self.get_revision(source_revision_id)
        for scene in source["scenes"]:
            for label, value in (
                ("image", scene.get("media_path")),
                ("audio", scene.get("audio_path")),
            ):
                if not value or not Path(value).is_file():
                    raise FileNotFoundError(
                        f"Scene {scene['position'] + 1} has no reusable {label} asset"
                    )
            if Path(scene["media_path"]).suffix.lower() not in {
                ".png",
                ".jpg",
                ".jpeg",
                ".webp",
            }:
                raise ValueError("Renderer comparison currently requires image source media")

        label = (
            "原生图片 + HTML"
            if engine == "native_image_html"
            else "手绘白板动画"
            if engine == "whiteboard_cv"
            else "HyperFrames"
        )
        target = self.create_revision(
            source["project_id"],
            f"同素材渲染对照：{label}",
            source_revision_id=source_revision_id,
        )
        config = dict(target["config"])
        config.update(
            {
                "production_mode": (
                    "whiteboard_animation" if engine == "whiteboard_cv" else engine
                ),
                "render_engine": engine,
                "renderer_version": (
                    NATIVE_RENDERER_VERSION
                    if engine == "native_image_html"
                    else WHITEBOARD_RENDERER_VERSION
                    if engine == "whiteboard_cv"
                    else HYPERFRAMES_RENDERER_VERSION
                ),
                "render_fallback_reason": None,
            }
        )
        if engine == "whiteboard_cv":
            config.update(
                frame_template=None,
                whiteboard=WhiteboardTemplateRegistry().resolve(
                    config.get("whiteboard")
                ),
            )
        now = _utc_now()
        with self._lock, self._connection:
            self._connection.execute(
                """
                UPDATE production_revisions
                SET config_json = ?, render_status = 'planned', render_engine = ?,
                    render_task_id = NULL, render_error = NULL, rendered_at = NULL,
                    quality_status = 'pending'
                WHERE id = ?
                """,
                (_json(config), engine, target["id"]),
            )
            self._connection.execute(
                """
                DELETE FROM production_artifacts
                WHERE revision_id = ? AND kind IN (
                    'final_video', 'hyperframes_project', 'check_report',
                    'overlay', 'text_overlay', 'segment'
                )
                """,
                (target["id"],),
            )
            self._connection.execute(
                "UPDATE production_scenes SET segment_path = NULL, "
                "subtitle_effect_applied = NULL, subtitle_effect_fallback_reason = NULL, "
                "updated_at = ? "
                "WHERE revision_id = ?",
                (now, target["id"]),
            )
            self._connection.execute(
                "DELETE FROM production_quality_checks WHERE revision_id = ?",
                (target["id"],),
            )
        return self.get_revision(target["id"])

    def attach_renderer_variant_task(self, revision_id: str, task_id: str) -> dict[str, Any]:
        with self._lock, self._connection:
            cursor = self._connection.execute(
                """
                UPDATE production_revisions
                SET render_task_id = ?, render_status = 'pending', render_error = NULL
                WHERE id = ? AND render_status = 'planned'
                """,
                (task_id, revision_id),
            )
        if cursor.rowcount != 1:
            raise ValueError("Renderer variant is no longer available for scheduling")
        return self.get_revision(revision_id)

    def set_renderer_variant_status(
        self,
        revision_id: str,
        task_id: str,
        status: str,
        error: str | None = None,
    ) -> dict[str, Any]:
        if status not in {"pending", "running", "completed", "failed", "cancelled"}:
            raise ValueError(f"Unsupported renderer variant status: {status}")
        rendered_at = _utc_now() if status == "completed" else None
        with self._lock, self._connection:
            cursor = self._connection.execute(
                """
                UPDATE production_revisions
                SET render_status = ?, render_error = ?, rendered_at = ?
                WHERE id = ? AND render_task_id = ?
                """,
                (status, error, rendered_at, revision_id, task_id),
            )
        if cursor.rowcount != 1:
            raise KeyError(revision_id)
        return self.get_revision(revision_id)

    def complete_renderer_variant(
        self,
        revision_id: str,
        task_id: str,
        frames: list[dict[str, Any]],
        final_path: str,
        config: dict[str, Any],
        quality_checks: list[dict[str, Any]],
        *,
        hyperframes_manifest_path: str | None = None,
        check_report_path: str | None = None,
    ) -> dict[str, Any]:
        """Atomically publish renderer-owned artifacts without replacing shared inputs."""
        revision = self.get_revision(revision_id)
        if revision.get("render_task_id") != task_id:
            raise ValueError("Renderer variant task is no longer current")
        if len(frames) != len(revision["scenes"]):
            raise ValueError("Rendered frame count does not match revision scenes")
        now = _utc_now()
        metadata = {"input": {"render_engine": revision.get("render_engine")}}
        with self._lock, self._connection:
            for scene, frame in zip(revision["scenes"], frames, strict=True):
                self._connection.execute(
                    """
                    UPDATE production_scenes
                    SET segment_path = ?, duration = ?, subtitle_effect_applied = ?,
                        subtitle_effect_fallback_reason = ?, updated_at = ?
                    WHERE id = ?
                    """,
                    (
                        frame.get("segment_path"),
                        float(frame.get("duration") or scene.get("duration") or 0),
                        frame.get("subtitle_effect_applied"),
                        frame.get("subtitle_effect_fallback_reason"),
                        now,
                        scene["id"],
                    ),
                )
                for kind, path, media_type in (
                    ("overlay", frame.get("composed_image_path"), "image"),
                    ("text_overlay", frame.get("overlay_image_path"), "image"),
                    ("subtitle_overlay", frame.get("subtitle_overlay_path"), "image"),
                    ("whiteboard_silent", frame.get("whiteboard_silent_path"), "video"),
                    (
                        "whiteboard_analysis",
                        frame.get("whiteboard_analysis_path"),
                        "application/json",
                    ),
                    ("segment", frame.get("segment_path"), "video"),
                ):
                    if path:
                        self._upsert_artifact(
                            revision_id,
                            scene["id"],
                            kind,
                            path,
                            media_type,
                            metadata,
                            float(frame.get("duration") or 0),
                            now,
                        )
            self._upsert_artifact(
                revision_id,
                None,
                "final_video",
                final_path,
                "video",
                metadata,
                sum(float(frame.get("duration") or 0) for frame in frames),
                now,
            )
            for kind, path in (
                ("hyperframes_project", hyperframes_manifest_path),
                ("check_report", check_report_path),
            ):
                if path:
                    self._upsert_artifact(
                        revision_id,
                        None,
                        kind,
                        path,
                        "application/json",
                        metadata,
                        0,
                        now,
                    )
            self._connection.execute(
                "DELETE FROM production_quality_checks WHERE revision_id = ?",
                (revision_id,),
            )
            for check in quality_checks:
                self._connection.execute(
                    """
                    INSERT INTO production_quality_checks(
                        id, revision_id, check_name, status, detail_json, created_at
                    ) VALUES (?, ?, ?, ?, ?, ?)
                    """,
                    (
                        f"quality:{revision_id}:{check['name']}",
                        revision_id,
                        check["name"],
                        check["status"],
                        _json(check.get("detail") or {}),
                        now,
                    ),
                )
            self._connection.execute(
                """
                UPDATE production_revisions
                SET config_json = ?, quality_status = ?, render_status = 'completed',
                    render_error = NULL, rendered_at = ?
                WHERE id = ? AND render_task_id = ?
                """,
                (
                    _json(config),
                    _quality_rollup(quality_checks),
                    now,
                    revision_id,
                    task_id,
                ),
            )
            self._connection.execute(
                "UPDATE production_projects SET updated_at = ? WHERE id = ?",
                (now, revision["project_id"]),
            )
        return self.get_revision(revision_id)

    def prepare_quality_repair(
        self,
        source_revision_id: str,
        plan: dict[str, Any],
    ) -> dict[str, Any]:
        """Create one recoverable repair draft and persist its audit plan."""
        source = self.get_revision(source_revision_id)
        if source["status"] != "active":
            raise ValueError("Automatic quality repair requires the active revision")
        if source["quality_status"] != "fail":
            raise ValueError("Revision has no failed technical quality gate")
        existing = source.get("repair_plan") or {}
        target_id = existing.get("target_revision_id")
        if (
            source.get("repair_status") in {"planned", "pending", "running", "completed"}
            and target_id
        ):
            return {
                "source": source,
                "target": self.get_revision(target_id),
                "plan": existing,
            }

        target = self.create_revision(
            source["project_id"],
            "自动质量修复：仅重做失败检查影响的步骤",
        )
        durable_plan = {**plan, "target_revision_id": target["id"]}
        with self._lock, self._connection:
            for revision_id in (source_revision_id, target["id"]):
                self._connection.execute(
                    """
                    UPDATE production_revisions
                    SET repair_status = 'planned', repair_plan_json = ?,
                        repair_error = NULL, repaired_at = NULL
                    WHERE id = ?
                    """,
                    (_json(durable_plan), revision_id),
                )
        return {
            "source": self.get_revision(source_revision_id),
            "target": self.get_revision(target["id"]),
            "plan": durable_plan,
        }

    def attach_quality_repair_task(
        self,
        source_revision_id: str,
        target_revision_id: str,
        task_id: str,
    ) -> None:
        with self._lock, self._connection:
            for revision_id in (source_revision_id, target_revision_id):
                self._connection.execute(
                    """
                    UPDATE production_revisions
                    SET repair_task_id = ?, repair_status = 'pending', repair_error = NULL
                    WHERE id = ?
                    """,
                    (task_id, revision_id),
                )

    def set_quality_repair_status(
        self,
        source_revision_id: str,
        target_revision_id: str,
        task_id: str,
        status: str,
        error: str | None = None,
    ) -> None:
        if status not in {"pending", "running", "completed", "failed", "cancelled"}:
            raise ValueError(f"Unsupported quality repair status: {status}")
        repaired_at = _utc_now() if status == "completed" else None
        with self._lock, self._connection:
            for revision_id in (source_revision_id, target_revision_id):
                self._connection.execute(
                    """
                    UPDATE production_revisions
                    SET repair_status = ?, repair_error = ?, repaired_at = ?
                    WHERE id = ? AND repair_task_id = ?
                    """,
                    (status, error, repaired_at, revision_id, task_id),
                )

    def update_scene(
        self,
        scene_id: str,
        *,
        expected_updated_at: str | None = None,
        require_idle: bool = False,
        **updates: Any,
    ) -> dict[str, Any]:
        allowed = {
            "narration",
            "visual_prompt",
            "image_motion",
            "transition",
            "transition_duration",
            "direction_reason",
            "subtitle_effect",
            "subtitle_keywords",
            "subtitle_start_offset",
            "subtitle_end_offset",
            "focus_x",
            "focus_y",
            "focus_confidence",
            "focus_source",
            "locked",
            "duration",
        }
        unknown = set(updates) - allowed
        if unknown:
            raise ValueError(f"Unsupported scene fields: {sorted(unknown)}")
        with self._lock:
            row = self._connection.execute(
                """
                SELECT s.*, r.status AS revision_status
                FROM production_scenes s
                JOIN production_revisions r ON r.id = s.revision_id
                WHERE s.id = ?
                """,
                (scene_id,),
            ).fetchone()
        if row is None:
            raise KeyError(scene_id)
        if row["revision_status"] != "draft":
            raise ValueError("Only draft revisions can be edited")
        if expected_updated_at is not None and row["updated_at"] != expected_updated_at:
            raise ValueError("Scene changed since it was read; reload before editing")
        if row["locked"] and any(key != "locked" for key in updates):
            raise ValueError("Unlock the scene before editing it")
        if require_idle and row["regeneration_status"] in {"pending", "running"}:
            raise ValueError("Scene regeneration is in progress")
        if "locked" in updates:
            updates["locked"] = int(bool(updates["locked"]))
        if "subtitle_effect" in updates:
            from pixelle_video.rendering.subtitle_effects import normalize_subtitle_effect

            updates["subtitle_effect"] = (
                normalize_subtitle_effect(updates["subtitle_effect"])
                if updates["subtitle_effect"]
                else None
            )
        if "subtitle_keywords" in updates:
            from pixelle_video.rendering.subtitle_effects import normalize_subtitle_keywords

            updates["subtitle_keywords_json"] = _json(
                normalize_subtitle_keywords(updates.pop("subtitle_keywords"))
            )
        start_offset = float(
            updates.get("subtitle_start_offset", row["subtitle_start_offset"] or 0)
        )
        end_offset = float(
            updates.get("subtitle_end_offset", row["subtitle_end_offset"] or 0)
        )
        duration = float(updates.get("duration", row["duration"] or 0))
        from pixelle_video.rendering.subtitle_effects import normalize_subtitle_timing

        normalize_subtitle_timing(duration, start_offset, end_offset)
        if {
            "subtitle_effect",
            "subtitle_keywords_json",
            "subtitle_start_offset",
            "subtitle_end_offset",
        } & updates.keys():
            updates["subtitle_effect_applied"] = None
            updates["subtitle_effect_fallback_reason"] = None
        if {
            "narration",
            "visual_prompt",
            "image_motion",
            "transition",
            "transition_duration",
            "duration",
            "focus_x",
            "focus_y",
            "subtitle_effect",
            "subtitle_keywords_json",
            "subtitle_start_offset",
            "subtitle_end_offset",
        } & updates.keys():
            updates["regeneration_status"] = "idle"
            updates["regeneration_error"] = None
            updates["regenerated_at"] = None
        updates["updated_at"] = _utc_now_after(row["updated_at"])
        assignments = ", ".join(f"{key} = ?" for key in updates)
        original_updated_at = row["updated_at"]
        with self._lock, self._connection:
            cursor = self._connection.execute(
                f"""
                UPDATE production_scenes SET {assignments}
                WHERE id = ? AND updated_at = ?
                  AND EXISTS (
                      SELECT 1 FROM production_revisions r
                      WHERE r.id = production_scenes.revision_id AND r.status = 'draft'
                  )
                  AND (? = 0 OR (
                      locked = 0
                      AND COALESCE(regeneration_status, 'idle') NOT IN ('pending', 'running')
                  ))
                """,
                [*updates.values(), scene_id, original_updated_at, int(require_idle)],
            )
            if cursor.rowcount != 1:
                raise ValueError(
                    "Scene changed, was locked, or started regenerating; no edits were applied"
                )
            self._connection.execute(
                """
                UPDATE production_revisions
                SET quality_status = 'stale' WHERE id = ?
                """,
                (row["revision_id"],),
            )
        revision = self.get_revision(row["revision_id"])
        return next(scene for scene in revision["scenes"] if scene["id"] == scene_id)

    def get_scene_context(self, scene_id: str) -> dict[str, Any]:
        """Return a scene with its revision, project, and production job."""
        with self._lock:
            row = self._connection.execute(
                """
                SELECT revision_id FROM production_scenes WHERE id = ?
                """,
                (scene_id,),
            ).fetchone()
        if row is None:
            raise KeyError(scene_id)
        revision = self.get_revision(row["revision_id"])
        scene = next(item for item in revision["scenes"] if item["id"] == scene_id)
        project = self.get_project(revision["project_id"])
        job = self.get_job(project["job_id"])
        return {
            "scene": scene,
            "revision": revision,
            "project": project,
            "job": job,
        }

    def begin_scene_regeneration(
        self,
        scene_id: str,
        task_id: str,
        scope: str,
    ) -> dict[str, Any]:
        """Reserve one draft revision for an isolated scene regeneration."""
        context = self.get_scene_context(scene_id)
        scene = context["scene"]
        revision = context["revision"]
        if revision["status"] != "draft":
            raise ValueError("Only draft revisions can regenerate scenes")
        if scene["locked"]:
            raise ValueError("Unlock the scene before regenerating it")
        if scope not in {"full", "visual", "voice", "composition"}:
            raise ValueError(f"Unsupported regeneration scope: {scope}")
        if any(
            item.get("regeneration_status") in {"pending", "running"} for item in revision["scenes"]
        ):
            raise ValueError("This revision already has a scene regeneration in progress")
        with self._lock, self._connection:
            cursor = self._connection.execute(
                """
                UPDATE production_scenes
                SET regeneration_task_id = ?, regeneration_status = 'pending',
                    regeneration_scope = ?, regeneration_error = NULL,
                    updated_at = ?
                WHERE id = ? AND updated_at = ? AND locked = 0
                  AND COALESCE(regeneration_status, 'idle') NOT IN ('pending', 'running')
                  AND EXISTS (
                      SELECT 1 FROM production_revisions r
                      WHERE r.id = production_scenes.revision_id AND r.status = 'draft'
                  )
                  AND NOT EXISTS (
                      SELECT 1 FROM production_scenes other
                      WHERE other.revision_id = production_scenes.revision_id
                        AND other.regeneration_status IN ('pending', 'running')
                  )
                """,
                (
                    task_id,
                    scope,
                    _utc_now_after(scene["updated_at"]),
                    scene_id,
                    scene["updated_at"],
                ),
            )
            if cursor.rowcount != 1:
                raise ValueError(
                    "Scene changed, was locked, or another regeneration started"
                )
        return self.get_scene_context(scene_id)["scene"]

    def set_scene_regeneration_status(
        self,
        scene_id: str,
        task_id: str,
        status: str,
        error: str | None = None,
    ) -> dict[str, Any]:
        if status not in {"pending", "running", "completed", "failed", "cancelled"}:
            raise ValueError(f"Unsupported regeneration status: {status}")
        with self._lock, self._connection:
            cursor = self._connection.execute(
                """
                UPDATE production_scenes
                SET regeneration_status = ?, regeneration_error = ?, updated_at = ?
                WHERE id = ? AND regeneration_task_id = ?
                """,
                (status, error, _utc_now(), scene_id, task_id),
            )
        if cursor.rowcount != 1:
            raise KeyError(scene_id)
        return self.get_scene_context(scene_id)["scene"]

    def complete_scene_regeneration(
        self,
        scene_id: str,
        task_id: str,
        frame: dict[str, Any],
        final_path: str,
        quality_checks: list[dict[str, Any]],
        metadata: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Atomically switch a scene and revision to newly generated artifacts."""
        context = self.get_scene_context(scene_id)
        scene = context["scene"]
        revision = context["revision"]
        if scene.get("regeneration_task_id") != task_id:
            raise ValueError("Scene regeneration task is no longer current")
        now = _utc_now()
        metadata = metadata or {}
        with self._lock, self._connection:
            self._connection.execute(
                """
                UPDATE production_scenes
                SET duration = ?, audio_path = ?, media_path = ?, segment_path = ?,
                    image_motion = ?, transition = ?, transition_duration = ?,
                    direction_reason = ?, subtitle_effect = ?,
                    subtitle_effect_applied = ?, subtitle_effect_fallback_reason = ?,
                    subtitle_keywords_json = ?, subtitle_start_offset = ?,
                    subtitle_end_offset = ?, focus_x = ?, focus_y = ?,
                    focus_confidence = ?, focus_source = ?,
                    regeneration_status = 'completed', regeneration_error = NULL,
                    regenerated_at = ?, updated_at = ?
                WHERE id = ? AND regeneration_task_id = ?
                """,
                (
                    float(frame.get("duration") or 0),
                    frame.get("audio_path"),
                    frame.get("media_path"),
                    frame.get("segment_path"),
                    frame.get("image_motion") or scene.get("image_motion") or "none",
                    frame.get("transition") or scene.get("transition") or "crossfade",
                    float(
                        frame.get("transition_duration")
                        if frame.get("transition_duration") is not None
                        else scene.get("transition_duration") or 0
                    ),
                    frame.get("direction_reason") or scene.get("direction_reason"),
                    frame.get("subtitle_effect", scene.get("subtitle_effect")),
                    frame.get(
                        "subtitle_effect_applied",
                        scene.get("subtitle_effect_applied"),
                    ),
                    frame.get(
                        "subtitle_effect_fallback_reason",
                        scene.get("subtitle_effect_fallback_reason"),
                    ),
                    _json(
                        frame.get("subtitle_keywords", scene.get("subtitle_keywords") or [])
                    ),
                    float(
                        frame.get(
                            "subtitle_start_offset",
                            scene.get("subtitle_start_offset") or 0,
                        )
                    ),
                    float(
                        frame.get(
                            "subtitle_end_offset",
                            scene.get("subtitle_end_offset") or 0,
                        )
                    ),
                    frame.get("focus_x", scene.get("focus_x")),
                    frame.get("focus_y", scene.get("focus_y")),
                    frame.get("focus_confidence", scene.get("focus_confidence")),
                    frame.get("focus_source") or scene.get("focus_source"),
                    now,
                    now,
                    scene_id,
                    task_id,
                ),
            )
            for kind, path, media_type in (
                ("audio", frame.get("audio_path"), "audio"),
                ("source_media", frame.get("media_path"), frame.get("media_type")),
                ("overlay", frame.get("composed_image_path"), "image"),
                ("text_overlay", frame.get("overlay_image_path"), "image"),
                ("subtitle_overlay", frame.get("subtitle_overlay_path"), "image"),
                ("whiteboard_silent", frame.get("whiteboard_silent_path"), "video"),
                (
                    "whiteboard_analysis",
                    frame.get("whiteboard_analysis_path"),
                    "application/json",
                ),
                ("segment", frame.get("segment_path"), "video"),
            ):
                if path:
                    self._upsert_artifact(
                        revision["id"],
                        scene_id,
                        kind,
                        path,
                        media_type,
                        metadata,
                        float(frame.get("duration") or 0),
                        now,
                    )
            self._upsert_artifact(
                revision["id"],
                None,
                "final_video",
                final_path,
                "video",
                metadata,
                float(frame.get("total_duration") or 0),
                now,
            )
            self._connection.execute(
                "DELETE FROM production_quality_checks WHERE revision_id = ?",
                (revision["id"],),
            )
            for check in quality_checks:
                self._connection.execute(
                    """
                    INSERT INTO production_quality_checks(
                        id, revision_id, check_name, status, detail_json, created_at
                    ) VALUES (?, ?, ?, ?, ?, ?)
                    """,
                    (
                        f"quality:{revision['id']}:{check['name']}",
                        revision["id"],
                        check["name"],
                        check["status"],
                        _json(check.get("detail") or {}),
                        now,
                    ),
                )
            self._connection.execute(
                "UPDATE production_revisions SET quality_status = ? WHERE id = ?",
                (_quality_rollup(quality_checks), revision["id"]),
            )
            self._connection.execute(
                "UPDATE production_projects SET updated_at = ? WHERE id = ?",
                (now, revision["project_id"]),
            )
        return self.get_scene_context(scene_id)

    def reorder_scenes(self, revision_id: str, scene_ids: list[str]) -> dict[str, Any]:
        revision = self.get_revision(revision_id)
        current_ids = [scene["id"] for scene in revision["scenes"]]
        if len(scene_ids) != len(set(scene_ids)) or set(scene_ids) != set(current_ids):
            raise ValueError("scene_ids must contain every revision scene exactly once")
        if revision["status"] != "draft":
            raise ValueError("Only draft revisions can be reordered")
        with self._lock, self._connection:
            for offset, scene_id in enumerate(scene_ids):
                self._connection.execute(
                    "UPDATE production_scenes SET position = ? WHERE id = ?",
                    (-10000 - offset, scene_id),
                )
            now = _utc_now()
            for position, scene_id in enumerate(scene_ids):
                self._connection.execute(
                    """
                    UPDATE production_scenes
                    SET position = ?, updated_at = ? WHERE id = ?
                    """,
                    (position, now, scene_id),
                )
            self._connection.execute(
                "UPDATE production_revisions SET quality_status = 'stale' WHERE id = ?",
                (revision_id,),
            )
        return self.get_revision(revision_id)

    def split_scene(
        self,
        scene_id: str,
        narration: str,
        visual_prompt: str,
    ) -> dict[str, Any]:
        with self._lock:
            row = self._connection.execute(
                """
                SELECT s.*, r.status AS revision_status
                FROM production_scenes s
                JOIN production_revisions r ON r.id = s.revision_id
                WHERE s.id = ?
                """,
                (scene_id,),
            ).fetchone()
        if row is None:
            raise KeyError(scene_id)
        if row["revision_status"] != "draft" or row["locked"]:
            raise ValueError("Only unlocked scenes in draft revisions can be split")
        if not narration.strip() or not visual_prompt.strip():
            raise ValueError("The new scene narration and visual prompt are required")
        now = _utc_now()
        revision_id = row["revision_id"]
        with self._lock, self._connection:
            scenes = self._connection.execute(
                """
                SELECT id, position FROM production_scenes
                WHERE revision_id = ? AND position > ? ORDER BY position DESC
                """,
                (revision_id, row["position"]),
            ).fetchall()
            for scene in scenes:
                self._connection.execute(
                    "UPDATE production_scenes SET position = ? WHERE id = ?",
                    (scene["position"] + 1, scene["id"]),
                )
            new_id = f"scene:{revision_id}:{uuid.uuid4().hex[:10]}"
            self._connection.execute(
                """
                INSERT INTO production_scenes(
                    id, revision_id, position, narration, visual_prompt, locked,
                    duration, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?)
                """,
                (
                    new_id,
                    revision_id,
                    row["position"] + 1,
                    narration.strip(),
                    visual_prompt.strip(),
                    now,
                    now,
                ),
            )
            self._connection.execute(
                "UPDATE production_revisions SET quality_status = 'stale' WHERE id = ?",
                (revision_id,),
            )
        return self.get_revision(revision_id)

    def merge_scenes(self, scene_id: str, next_scene_id: str) -> dict[str, Any]:
        with self._lock:
            rows = self._connection.execute(
                """
                SELECT s.*, r.status AS revision_status
                FROM production_scenes s
                JOIN production_revisions r ON r.id = s.revision_id
                WHERE s.id IN (?, ?) ORDER BY s.position
                """,
                (scene_id, next_scene_id),
            ).fetchall()
        if len(rows) != 2:
            raise KeyError(next_scene_id)
        first, second = rows
        if first["id"] != scene_id or second["id"] != next_scene_id:
            raise ValueError("Scenes must be supplied in their current order")
        if (
            first["revision_id"] != second["revision_id"]
            or second["position"] != first["position"] + 1
        ):
            raise ValueError("Only adjacent scenes in one revision can be merged")
        if first["revision_status"] != "draft" or first["locked"] or second["locked"]:
            raise ValueError("Only unlocked scenes in draft revisions can be merged")
        revision_id = first["revision_id"]
        now = _utc_now()
        merged_keywords = list(
            dict.fromkeys(
                [
                    *json.loads(first["subtitle_keywords_json"] or "[]"),
                    *json.loads(second["subtitle_keywords_json"] or "[]"),
                ]
            )
        )[:12]
        with self._lock, self._connection:
            self._connection.execute(
                """
                UPDATE production_scenes SET
                    narration = ?, visual_prompt = ?, duration = ?,
                    subtitle_keywords_json = ?, subtitle_end_offset = ?, updated_at = ?
                WHERE id = ?
                """,
                (
                    f"{first['narration'].rstrip()} {second['narration'].lstrip()}",
                    f"{first['visual_prompt'].rstrip()} {second['visual_prompt'].lstrip()}",
                    float(first["duration"]) + float(second["duration"]),
                    _json(merged_keywords),
                    float(second["subtitle_end_offset"] or 0),
                    now,
                    scene_id,
                ),
            )
            self._connection.execute(
                "DELETE FROM production_artifacts WHERE scene_id = ?", (next_scene_id,)
            )
            self._connection.execute("DELETE FROM production_scenes WHERE id = ?", (next_scene_id,))
            remaining = self._connection.execute(
                """
                SELECT id, position FROM production_scenes
                WHERE revision_id = ? AND position > ? ORDER BY position
                """,
                (revision_id, second["position"]),
            ).fetchall()
            for scene in remaining:
                self._connection.execute(
                    "UPDATE production_scenes SET position = ? WHERE id = ?",
                    (scene["position"] - 1, scene["id"]),
                )
            self._connection.execute(
                "UPDATE production_revisions SET quality_status = 'stale' WHERE id = ?",
                (revision_id,),
            )
        return self.get_revision(revision_id)

    def activate_revision(self, project_id: str, revision_id: str) -> dict[str, Any]:
        revision = self.get_revision(revision_id)
        if revision["project_id"] != project_id:
            raise ValueError("Revision does not belong to this project")
        if revision.get("render_status") in {"planned", "pending", "running"}:
            raise ValueError("Wait for revision rendering to finish before activation")
        if revision.get("render_status") in {"failed", "cancelled"}:
            raise ValueError("A failed renderer variant cannot be activated")
        final_artifact = next(
            (
                artifact
                for artifact in revision.get("artifacts", [])
                if artifact["kind"] == "final_video"
            ),
            None,
        )
        if revision.get("render_status") == "completed":
            if final_artifact is None:
                raise ValueError("The completed revision has no final video artifact")
            if not Path(final_artifact["path"]).is_file():
                raise ValueError(
                    "The revision final video file is missing; render it again before activation"
                )
        now = _utc_now()
        with self._lock, self._connection:
            self._connection.execute(
                "UPDATE production_revisions SET status = 'archived' WHERE project_id = ?",
                (project_id,),
            )
            self._connection.execute(
                """
                UPDATE production_revisions
                SET status = 'active', activated_at = ? WHERE id = ?
                """,
                (now, revision_id),
            )
            self._connection.execute(
                """
                UPDATE production_projects
                SET current_revision_id = ?, updated_at = ? WHERE id = ?
                """,
                (revision_id, now, project_id),
            )
            if final_artifact is not None:
                project = self._connection.execute(
                    "SELECT job_id FROM production_projects WHERE id = ?",
                    (project_id,),
                ).fetchone()
                if project is None:
                    raise KeyError(project_id)
                job = self._connection.execute(
                    "SELECT result_json FROM production_jobs WHERE id = ?",
                    (project["job_id"],),
                ).fetchone()
                if job is None:
                    raise KeyError(project["job_id"])
                result = json.loads(job["result_json"] or "{}")
                result.pop("video_url", None)
                result.pop("render_fallback_reason", None)
                result.update(
                    video_path=final_artifact["path"],
                    duration=float(final_artifact.get("duration") or 0),
                    file_size=int(final_artifact.get("size_bytes") or 0),
                    render_engine=revision.get("render_engine")
                    or (revision.get("config") or {}).get("render_engine"),
                    active_revision_id=revision_id,
                )
                self._connection.execute(
                    """
                    UPDATE production_jobs
                    SET result_json = ?, updated_at = ? WHERE id = ?
                    """,
                    (_json(result), now, project["job_id"]),
                )
        return self.get_project(project_id)

    def enqueue_notification(
        self,
        event_key: str,
        event_type: str,
        payload: dict[str, Any],
    ) -> dict[str, Any]:
        """Persist one deduplicated webhook event before network delivery."""
        now = _utc_now()
        event_id = str(uuid.uuid4())
        with self._lock, self._connection:
            self._connection.execute(
                """
                INSERT OR IGNORE INTO production_notification_events(
                    id, event_key, event_type, payload_json, status, created_at
                ) VALUES (?, ?, ?, ?, 'pending', ?)
                """,
                (event_id, event_key, event_type, _json(payload), now),
            )
            row = self._connection.execute(
                "SELECT * FROM production_notification_events WHERE event_key = ?",
                (event_key,),
            ).fetchone()
        assert row is not None
        return _row_to_notification(row)

    def list_pending_notifications(
        self,
        limit: int = 20,
        max_attempts: int = 5,
    ) -> list[dict[str, Any]]:
        with self._lock:
            rows = self._connection.execute(
                """
                SELECT * FROM production_notification_events
                WHERE status IN ('pending', 'failed') AND attempts < ?
                ORDER BY created_at ASC LIMIT ?
                """,
                (max_attempts, limit),
            ).fetchall()
        return [_row_to_notification(row) for row in rows]

    def complete_notification(
        self,
        event_id: str,
        error: str | None = None,
    ) -> dict[str, Any]:
        status = "failed" if error else "sent"
        sent_at = None if error else _utc_now()
        with self._lock, self._connection:
            self._connection.execute(
                """
                UPDATE production_notification_events
                SET status = ?, attempts = attempts + 1, last_error = ?, sent_at = ?
                WHERE id = ?
                """,
                (status, error, sent_at, event_id),
            )
            row = self._connection.execute(
                "SELECT * FROM production_notification_events WHERE id = ?",
                (event_id,),
            ).fetchone()
        if row is None:
            raise KeyError(event_id)
        return _row_to_notification(row)

    def acquire_lease(self, name: str, holder: str, ttl_seconds: int) -> bool:
        now = time.time()
        with self._lock:
            self._connection.execute("BEGIN IMMEDIATE")
            try:
                row = self._connection.execute(
                    "SELECT holder, expires_at FROM production_leases WHERE name = ?",
                    (name,),
                ).fetchone()
                if row and row["holder"] != holder and row["expires_at"] > now:
                    self._connection.rollback()
                    return False
                self._connection.execute(
                    """
                    INSERT INTO production_leases(name, holder, expires_at)
                    VALUES (?, ?, ?)
                    ON CONFLICT(name) DO UPDATE SET
                        holder = excluded.holder,
                        expires_at = excluded.expires_at
                    """,
                    (name, holder, now + ttl_seconds),
                )
                self._connection.commit()
                return True
            except Exception:
                self._connection.rollback()
                raise

    def release_lease(self, name: str, holder: str) -> None:
        with self._lock, self._connection:
            self._connection.execute(
                "DELETE FROM production_leases WHERE name = ? AND holder = ?",
                (name, holder),
            )


def _row_to_job(row: sqlite3.Row) -> dict[str, Any]:
    job = dict(row)
    job["request"] = json.loads(job.pop("request_json"))
    raw_result = job.pop("result_json")
    job["result"] = json.loads(raw_result) if raw_result else None
    raw_storyboard = job.pop("storyboard_json", None)
    job["storyboard"] = json.loads(raw_storyboard) if raw_storyboard else None
    raw_checks = job.pop("content_checks_json", None)
    job["content_checks"] = json.loads(raw_checks) if raw_checks else []
    return job


def _row_to_task_event(row: sqlite3.Row | dict[str, Any]) -> dict[str, Any]:
    """Decode the JSON-bearing task-event row into the public timeline contract."""
    value = dict(row)
    value["artifacts"] = json.loads(value.pop("artifacts_json", "[]") or "[]")
    value["recovery"] = json.loads(value.pop("recovery_json", "[]") or "[]")
    value["detail"] = json.loads(value.pop("detail_json", "{}") or "{}")
    return value


def _row_to_notification(row: sqlite3.Row) -> dict[str, Any]:
    value = dict(row)
    value["payload"] = json.loads(value.pop("payload_json"))
    return value


def _row_to_preset_version(
    row: sqlite3.Row,
    preset: dict[str, Any] | None = None,
) -> dict[str, Any]:
    value = dict(row)
    value["config"] = json.loads(value.pop("config_json"))
    if preset is not None:
        value["kind"] = preset["kind"]
        value["preset_name"] = preset["name"]
    return value


def _row_to_topic_candidate(row: sqlite3.Row) -> dict[str, Any]:
    value = dict(row)
    value["tags"] = json.loads(value.pop("tags_json"))
    value["scores"] = json.loads(value.pop("score_json"))
    value["score_reasons"] = json.loads(value.pop("score_reasons_json"))
    value["semantic_terms"] = json.loads(value.pop("semantic_terms_json", "[]") or "[]")
    value["semantic_vector"] = json.loads(value.pop("semantic_vector_json", "[]") or "[]")
    value["title_variants"] = json.loads(value.pop("title_variants_json", "[]") or "[]")
    value["experiment"] = json.loads(value.pop("experiment_json", "{}") or "{}")
    return value


def _row_to_content_source(row: sqlite3.Row) -> dict[str, Any]:
    value = dict(row)
    value["enabled"] = bool(value["enabled"])
    value["last_result"] = json.loads(value.pop("last_result_json") or "{}")
    value["item_count"] = int(value.get("item_count") or 0)
    return value


def _row_to_source_item(row: sqlite3.Row) -> dict[str, Any]:
    value = dict(row)
    value["candidate_ids"] = json.loads(value.pop("candidate_ids_json") or "[]")
    return value


def _row_to_assistant_message(row: sqlite3.Row) -> dict[str, Any]:
    value = dict(row)
    value["payload"] = json.loads(value.pop("payload_json") or "{}")
    return value


def _row_to_assistant_plan(row: sqlite3.Row) -> dict[str, Any]:
    value = dict(row)
    value["actions"] = json.loads(value.pop("actions_json") or "[]")
    value["result"] = json.loads(value.pop("result_json") or "{}")
    return value


def _generated_paths_from_job(job: dict[str, Any]) -> set[str]:
    """Collect only generated media fields; never treat request inputs as owned files."""
    paths: set[str] = set()
    result = job.get("result") or {}
    for key in ("video_path", "output_path", "final_video_path"):
        value = result.get(key)
        if isinstance(value, str) and value:
            paths.add(value)
    storyboard = job.get("storyboard") or {}
    template_snapshot = (storyboard.get("config") or {}).get("template_snapshot_path")
    if isinstance(template_snapshot, str) and template_snapshot:
        paths.add(template_snapshot)
    paths.update(_hyperframes_generated_paths(storyboard.get("config") or {}))
    final_path = storyboard.get("final_video_path")
    if isinstance(final_path, str) and final_path:
        paths.add(final_path)
    for frame in storyboard.get("frames") or []:
        if not isinstance(frame, dict):
            continue
        for key in (
            "audio_path",
            "video_path",
            "image_path",
            "video_segment_path",
            "composed_image_path",
            "overlay_image_path",
            "subtitle_overlay_path",
            "whiteboard_silent_path",
            "whiteboard_analysis_path",
        ):
            value = frame.get(key)
            if isinstance(value, str) and value:
                paths.add(value)
    return paths


def _paths_as_event_artifacts(paths: Iterable[str]) -> list[dict[str, Any]]:
    artifacts: list[dict[str, Any]] = []
    for value in sorted(set(paths)):
        path = Path(value).expanduser()
        artifacts.append(
            {
                "path": str(path),
                "kind": "directory" if path.is_dir() else "file",
                "sha256": _sha256(path),
                "size_bytes": path.stat().st_size if path.is_file() else None,
            }
        )
    return artifacts


def _job_event_model(job: dict[str, Any]) -> str | None:
    request = job.get("request") or {}
    production = request.get("production") or {}
    for value in (
        production.get("model_route"),
        request.get("media_workflow"),
        request.get("model"),
    ):
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


def _parse_iso_millis(value: str | None) -> float | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def _topic_identity(value: str) -> str:
    """Canonicalize titles across whitespace and punctuation for exact deduplication."""
    return "".join(character.casefold() for character in value if character.isalnum())


def _hyperframes_generated_paths(config: dict[str, Any]) -> set[str]:
    paths: set[str] = set()
    for key in (
        "hyperframes_project_path",
        "hyperframes_manifest_path",
        "hyperframes_check_report_path",
    ):
        value = config.get(key)
        if not isinstance(value, str) or not value:
            continue
        candidate = Path(value).expanduser()
        if candidate.is_dir():
            paths.update(str(item) for item in candidate.rglob("*") if item.is_file())
        else:
            paths.add(value)
    return paths


def _validate_preset_kind(kind: str) -> None:
    if kind not in {"brand_kit", "recipe"}:
        raise ValueError(f"Unsupported preset kind: {kind}")


def _validate_content_source_kind(kind: str) -> None:
    if kind not in {"url", "rss"}:
        raise ValueError(f"Unsupported content source kind: {kind}")


def _json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _utc_now_after(previous: str | None) -> str:
    """Return a UTC revision token strictly newer than the previous value.

    Windows' wall clock may repeat within one scheduler tick. Optimistic scene
    updates use this timestamp as their compare-and-swap token, so equality
    after a real write would otherwise let a stale editor overwrite it.
    """
    now = datetime.now(timezone.utc)
    if previous:
        try:
            parsed = datetime.fromisoformat(previous)
            if parsed.tzinfo is None:
                parsed = parsed.replace(tzinfo=timezone.utc)
            else:
                parsed = parsed.astimezone(timezone.utc)
            if now <= parsed:
                now = parsed + timedelta(microseconds=1)
        except ValueError:
            pass
    return now.isoformat()


def _sha256(path: Path) -> str | None:
    if not path.is_file():
        return None
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _quality_rollup(checks: list[dict[str, Any]]) -> str:
    statuses = {check["status"] for check in checks}
    if "fail" in statuses:
        return "fail"
    if "warn" in statuses:
        return "warn"
    return "pass" if checks else "pending"
