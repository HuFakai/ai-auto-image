"""Durable quality-gate repair using the smallest affected scene steps."""

from __future__ import annotations

from typing import Any

from .regeneration import regenerate_scene
from .store import ProductionStore


async def repair_revision(
    store: ProductionStore,
    source_revision_id: str,
    target_revision_id: str,
    task_id: str,
    plan: dict[str, Any],
    core: Any,
) -> dict[str, Any]:
    """Execute a persisted repair plan sequentially so every step is resumable."""
    store.set_quality_repair_status(
        source_revision_id, target_revision_id, task_id, "running"
    )
    completed: list[dict[str, Any]] = []
    try:
        for step in plan.get("steps") or []:
            scope = str(step["scope"])
            for position in step.get("scenes") or []:
                revision = store.get_revision(target_revision_id)
                scene = next(
                    (
                        item
                        for item in revision["scenes"]
                        if int(item["position"]) + 1 == int(position)
                    ),
                    None,
                )
                if scene is None:
                    raise ValueError(f"Repair scene {position} no longer exists")
                scene_task_id = f"{task_id}:scene:{position}"
                same_attempt = scene.get("regeneration_task_id") == scene_task_id
                if same_attempt and scene.get("regeneration_status") == "completed":
                    completed.append({"scene": int(position), "scope": scope})
                    continue
                if not same_attempt:
                    store.begin_scene_regeneration(scene["id"], scene_task_id, scope)
                await regenerate_scene(
                    store=store,
                    scene_id=scene["id"],
                    task_id=scene_task_id,
                    scope=scope,
                    preserve_style=scope in {"full", "visual"},
                    core=core,
                )
                completed.append({"scene": int(position), "scope": scope})
        store.set_quality_repair_status(
            source_revision_id, target_revision_id, task_id, "completed"
        )
        repaired = store.get_revision(target_revision_id)
        return {
            "source_revision_id": source_revision_id,
            "target_revision_id": target_revision_id,
            "quality_status": repaired["quality_status"],
            "completed_steps": completed,
            "manual_checks": plan.get("manual_checks") or [],
            "locked_scenes": plan.get("locked_scenes") or [],
        }
    except Exception as exc:
        store.set_quality_repair_status(
            source_revision_id, target_revision_id, task_id, "failed", str(exc)
        )
        raise
