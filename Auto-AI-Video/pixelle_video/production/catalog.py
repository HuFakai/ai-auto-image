"""Bridge generated filesystem storyboards into the editable production catalog."""

from __future__ import annotations

import json
import os
import uuid
from pathlib import Path
from typing import Any

from .quality import inspect_subtitle_layout, inspect_video
from .store import ProductionStore


def sync_job_project(
    store: ProductionStore,
    job: dict[str, Any],
    output_dir: str | Path = "output",
    deep_quality: bool = True,
) -> dict[str, Any]:
    """Import or refresh a generated job's first revision and quality report."""
    task_id = job.get("api_task_id")
    if not task_id:
        raise ValueError("Production job has no API task id")
    task_dir = Path(output_dir).expanduser().resolve() / task_id
    storyboard_path = task_dir / "storyboard.json"
    metadata_path = task_dir / "metadata.json"
    if not storyboard_path.is_file():
        raise FileNotFoundError(f"Storyboard not found: {storyboard_path}")
    storyboard = json.loads(storyboard_path.read_text(encoding="utf-8"))
    metadata = (
        json.loads(metadata_path.read_text(encoding="utf-8"))
        if metadata_path.is_file()
        else {}
    )
    final_path = storyboard.get("final_video_path") or task_dir / "final.mp4"
    checks = inspect_video(
        final_path,
        expected_duration=float(storyboard.get("total_duration") or 0) or None,
        deep=deep_quality,
    )
    checks.append(inspect_subtitle_layout(storyboard.get("frames") or []))
    checks.extend(job.get("content_checks") or [])
    project = store.import_project_revision(job["id"], storyboard, metadata, checks)
    revision = store.get_revision(project["current_revision_id"])
    manifest_path = _write_artifacts_manifest(task_dir, job, revision)
    store.attach_artifacts_manifest(
        job["id"],
        revision["id"],
        str(manifest_path),
        detail={"artifact_count": len(revision.get("artifacts") or [])},
    )
    return store.get_project(project["id"])


def _write_artifacts_manifest(
    task_dir: Path,
    job: dict[str, Any],
    revision: dict[str, Any],
) -> Path:
    artifacts = []
    for artifact in [
        *(revision.get("artifacts") or []),
        *(item for scene in revision.get("scenes") or [] for item in scene.get("artifacts") or []),
    ]:
        path = Path(str(artifact.get("path") or "")).expanduser()
        artifacts.append(
            {
                "id": artifact.get("id"),
                "kind": artifact.get("kind"),
                "path": str(path),
                "sha256": artifact.get("sha256"),
                "scene_id": artifact.get("scene_id"),
                "size_bytes": artifact.get("size_bytes"),
                "references": {
                    "job_id": job["id"],
                    "project_id": revision.get("project_id"),
                    "revision_id": revision["id"],
                    "scene_id": artifact.get("scene_id"),
                },
            }
        )
    payload = {
        "format": 1,
        "job_id": job["id"],
        "task_id": job.get("api_task_id"),
        "project_id": revision.get("project_id"),
        "revision_id": revision["id"],
        "artifacts": artifacts,
    }
    output = task_dir / "artifacts.json"
    temporary = output.with_name(f".{output.name}.{uuid.uuid4().hex}.tmp")
    try:
        temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        os.replace(temporary, output)
    finally:
        temporary.unlink(missing_ok=True)
    return output
