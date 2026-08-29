"""Editable project, revision, scene, artifact, and quality-check endpoints."""

from contextlib import contextmanager
from typing import Annotated, Iterator

from fastapi import APIRouter, HTTPException, Query, Request, status

from api.config import api_config
from api.dependencies import get_pixelle_video
from api.routers.video import path_to_url_from_base
from api.schemas.projects import (
    RevisionCreateRequest,
    RevisionVariantRequest,
    SceneMergeRequest,
    SceneOrderRequest,
    SceneRegenerateRequest,
    SceneSplitRequest,
    SceneUpdateRequest,
)
from api.tasks import Task, TaskType, task_manager
from pixelle_video.production import (
    ProductionStore,
    build_quality_repair_plan,
    load_runner_config,
    regenerate_scene,
    render_revision_variant,
    repair_revision,
    sync_job_project,
)

router = APIRouter(prefix="/projects", tags=["Projects & Storyboards"])


def _config():
    try:
        return load_runner_config(api_config.production_config_path)
    except (FileNotFoundError, ValueError) as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@contextmanager
def _store() -> Iterator[ProductionStore]:
    store = ProductionStore(_config().database_path)
    try:
        yield store
    finally:
        store.close()


@router.get("")
def list_projects(
    request: Request,
    channel_id: str | None = None,
    limit: Annotated[int, Query(ge=1, le=1000)] = 100,
):
    with _store() as store:
        projects = store.list_projects(channel_id=channel_id, limit=limit)
    return {"projects": projects, "count": len(projects)}


@router.get("/by-job/{job_id}")
def get_project_by_job(job_id: str, request: Request):
    with _store() as store:
        try:
            project = store.get_project_by_job(job_id)
        except KeyError:
            try:
                job = store.get_job(job_id)
                if job["status"] not in {"ready", "published"}:
                    raise HTTPException(status_code=409, detail="The production job has no completed video")
                project = sync_job_project(store, job)
            except KeyError as exc:
                raise HTTPException(status_code=404, detail="Production job not found") from exc
            except (FileNotFoundError, ValueError) as exc:
                raise HTTPException(status_code=409, detail=str(exc)) from exc
    return _decorate_project(project, request)


@router.get("/{project_id}")
def get_project(project_id: str, request: Request):
    with _store() as store:
        try:
            project = store.get_project(project_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="Project not found") from exc
    return _decorate_project(project, request)


@router.post("/{project_id}/revisions", status_code=201)
def create_revision(project_id: str, body: RevisionCreateRequest, request: Request):
    with _store() as store:
        try:
            revision = store.create_revision(project_id, body.note)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="Project not found") from exc
    return _decorate_revision(revision, request)


@router.post("/{project_id}/revisions/{revision_id}/activate")
def activate_revision(project_id: str, revision_id: str, request: Request):
    with _store() as store:
        try:
            project = store.activate_revision(project_id, revision_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="Revision not found") from exc
        except ValueError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
    return _decorate_project(project, request)


@router.post("/revisions/{revision_id}/reorder")
def reorder_scenes(revision_id: str, body: SceneOrderRequest, request: Request):
    with _store() as store:
        try:
            revision = store.reorder_scenes(revision_id, body.scene_ids)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="Revision not found") from exc
        except ValueError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
    return _decorate_revision(revision, request)


@router.patch("/scenes/{scene_id}")
def update_scene(scene_id: str, body: SceneUpdateRequest, request: Request):
    with _store() as store:
        try:
            scene = store.update_scene(
                scene_id,
                **body.model_dump(exclude_unset=True),
            )
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="Scene not found") from exc
        except ValueError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
    return _decorate_scene(scene, request)


@router.post("/scenes/{scene_id}/split")
def split_scene(scene_id: str, body: SceneSplitRequest, request: Request):
    with _store() as store:
        try:
            revision = store.split_scene(scene_id, body.narration, body.visual_prompt)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="Scene not found") from exc
        except ValueError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
    return _decorate_revision(revision, request)


@router.post("/scenes/{scene_id}/merge")
def merge_scenes(scene_id: str, body: SceneMergeRequest, request: Request):
    with _store() as store:
        try:
            revision = store.merge_scenes(scene_id, body.next_scene_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="Scene not found") from exc
        except ValueError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
    return _decorate_revision(revision, request)


async def execute_scene_regeneration_task(task: Task) -> dict:
    """Resume an isolated scene generation from durable task metadata."""
    params = dict(task.request_params or {})
    database_path = params["database_path"]
    scene_id = params["scene_id"]
    with ProductionStore(database_path) as store:
        core = await get_pixelle_video()
        return await regenerate_scene(
            store=store,
            scene_id=scene_id,
            task_id=task.task_id,
            scope=params.get("scope", "full"),
            preserve_style=bool(params.get("preserve_style", True)),
            core=core,
        )


task_manager.register_handler(TaskType.SCENE_REGENERATION, execute_scene_regeneration_task)


async def execute_quality_repair_task(task: Task) -> dict:
    """Resume a persisted affected-step quality repair plan."""
    params = dict(task.request_params or {})
    with ProductionStore(params["database_path"]) as store:
        core = await get_pixelle_video()
        return await repair_revision(
            store=store,
            source_revision_id=params["source_revision_id"],
            target_revision_id=params["target_revision_id"],
            task_id=task.task_id,
            plan=params["plan"],
            core=core,
        )


task_manager.register_handler(TaskType.QUALITY_REPAIR, execute_quality_repair_task)


async def execute_revision_render_task(task: Task) -> dict:
    """Render a native or HyperFrames revision from already-frozen assets."""
    params = dict(task.request_params or {})
    with ProductionStore(params["database_path"]) as store:
        core = await get_pixelle_video()
        return await render_revision_variant(
            store=store,
            revision_id=params["revision_id"],
            task_id=task.task_id,
            core=core,
            progress=lambda value, message: task_manager.update_progress(
                task.task_id,
                int(value),
                100,
                message,
            ),
        )


task_manager.register_handler(TaskType.REVISION_RENDER, execute_revision_render_task)


@router.post(
    "/revisions/{revision_id}/render-variant",
    status_code=status.HTTP_202_ACCEPTED,
)
async def create_revision_render_variant(
    revision_id: str,
    body: RevisionVariantRequest,
):
    config = _config()
    with ProductionStore(config.database_path) as store:
        try:
            target = store.create_renderer_variant(revision_id, body.engine)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="Revision not found") from exc
        except (FileNotFoundError, ValueError) as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        task = task_manager.create_task(
            task_type=TaskType.REVISION_RENDER,
            request_params={
                "database_path": config.database_path,
                "source_revision_id": revision_id,
                "revision_id": target["id"],
                "engine": body.engine,
            },
        )
        store.attach_renderer_variant_task(target["id"], task.task_id)
    await task_manager.execute_task(task.task_id)
    return {
        "task_id": task.task_id,
        "source_revision_id": revision_id,
        "target_revision_id": target["id"],
        "render_engine": body.engine,
        "status": "pending",
    }


@router.post(
    "/revisions/{revision_id}/auto-repair",
    status_code=status.HTTP_202_ACCEPTED,
)
async def auto_repair_revision(revision_id: str):
    config = _config()
    with ProductionStore(config.database_path) as store:
        try:
            source = store.get_revision(revision_id)
            plan = build_quality_repair_plan(source)
            if not plan["steps"]:
                raise HTTPException(
                    status_code=409,
                    detail="No repairable failed technical quality checks",
                )
            prepared = store.prepare_quality_repair(revision_id, plan)
            existing_task_id = prepared["source"].get("repair_task_id")
            if existing_task_id and prepared["source"].get("repair_status") in {
                "pending",
                "running",
                "completed",
            }:
                return {
                    "task_id": existing_task_id,
                    "source_revision_id": revision_id,
                    "target_revision_id": prepared["target"]["id"],
                    "plan": prepared["plan"],
                    "status": prepared["source"]["repair_status"],
                }
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="Revision not found") from exc
        except ValueError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc

        target_revision_id = prepared["target"]["id"]
        task = task_manager.create_task(
            task_type=TaskType.QUALITY_REPAIR,
            idempotency_key=f"quality-repair:{revision_id}",
            request_params={
                "database_path": config.database_path,
                "source_revision_id": revision_id,
                "target_revision_id": target_revision_id,
                "plan": prepared["plan"],
            },
        )
        store.attach_quality_repair_task(revision_id, target_revision_id, task.task_id)
    await task_manager.execute_task(task.task_id)
    return {
        "task_id": task.task_id,
        "source_revision_id": revision_id,
        "target_revision_id": target_revision_id,
        "plan": prepared["plan"],
        "status": "pending",
    }


@router.post(
    "/scenes/{scene_id}/regenerate",
    status_code=status.HTTP_202_ACCEPTED,
)
async def regenerate_project_scene(scene_id: str, body: SceneRegenerateRequest):
    config = _config()
    task = task_manager.create_task(
        task_type=TaskType.SCENE_REGENERATION,
        request_params={
            "database_path": config.database_path,
            "scene_id": scene_id,
            "scope": body.scope,
            "preserve_style": body.preserve_style,
        },
    )
    try:
        with ProductionStore(config.database_path) as store:
            store.begin_scene_regeneration(scene_id, task.task_id, body.scope)
    except KeyError as exc:
        task_manager.cancel_task(task.task_id)
        raise HTTPException(status_code=404, detail="Scene not found") from exc
    except ValueError as exc:
        task_manager.cancel_task(task.task_id)
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    await task_manager.execute_task(task.task_id)
    return {"task_id": task.task_id, "scene_id": scene_id, "status": "pending"}


def _decorate_project(project: dict, request: Request) -> dict:
    project["revisions"] = [
        _decorate_revision(revision, request) for revision in project["revisions"]
    ]
    return project


def _decorate_revision(revision: dict, request: Request) -> dict:
    revision["artifacts"] = [
        _decorate_artifact(artifact, request) for artifact in revision["artifacts"]
    ]
    revision["scenes"] = [
        _decorate_scene(scene, request) for scene in revision["scenes"]
    ]
    return revision


def _decorate_scene(scene: dict, request: Request) -> dict:
    for key in ("audio_path", "media_path", "segment_path"):
        if scene.get(key):
            scene[f"{key.removesuffix('_path')}_url"] = path_to_url_from_base(
                str(request.base_url), scene[key]
            )
    scene["artifacts"] = [
        _decorate_artifact(artifact, request) for artifact in scene.get("artifacts", [])
    ]
    return scene


def _decorate_artifact(artifact: dict, request: Request) -> dict:
    artifact["url"] = path_to_url_from_base(str(request.base_url), artifact["path"])
    return artifact
