import asyncio
import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from api.app import app
from api.config import api_config
from api.schemas.projects import SceneUpdateRequest
from api.tasks import Task, TaskType, task_manager
from pixelle_video.production import (
    ProductionStore,
    build_quality_repair_plan,
    inspect_subtitle_layout,
    inspect_video,
    regenerate_scene,
    render_revision_variant,
)
from pixelle_video.production.catalog import sync_job_project


def test_scene_update_rejects_zero_duration_for_visible_transition():
    with pytest.raises(ValidationError, match="at least 0.05"):
        SceneUpdateRequest.model_validate(
            {"transition": "crossfade", "transition_duration": 0}
        )

    request = SceneUpdateRequest.model_validate(
        {"transition": "none", "transition_duration": 0}
    )
    assert request.transition_duration == 0


def test_scene_update_normalizes_subtitle_v2_payload():
    request = SceneUpdateRequest.model_validate(
        {
            "subtitle_effect": "word_pop",
            "subtitle_keywords": [" 情绪 ", "边界感", "情绪"],
            "subtitle_start_offset": 0.15,
            "subtitle_end_offset": 0.35,
        }
    )

    assert request.subtitle_effect == "word_pop"
    assert request.subtitle_keywords == ["情绪", "边界感"]
    assert request.subtitle_start_offset == 0.15
    assert request.subtitle_end_offset == 0.35


def _config(tmp_path: Path) -> Path:
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
  media_workflow: api/grok/grok-imagine-video
""",
        encoding="utf-8",
    )
    path = tmp_path / "runner.yaml"
    path.write_text(
        f"database_path: {tmp_path / 'production.db'}\nchannels_dir: {channels}\n",
        encoding="utf-8",
    )
    return path


def _import_project(
    store: ProductionStore,
    tmp_path: Path,
    quality_checks: list[dict] | None = None,
    *,
    image_media: bool = False,
) -> tuple[dict, dict]:
    task_dir = tmp_path / "output" / "task-one"
    frames = task_dir / "frames"
    frames.mkdir(parents=True)
    final = task_dir / "final.mp4"
    audio = frames / "01_audio.mp3"
    media = frames / ("01_image.png" if image_media else "01_video.mp4")
    segment = frames / "01_segment.mp4"
    for path, content in (
        (final, b"final-video"),
        (audio, b"audio"),
        (media, b"source-video"),
        (segment, b"segment"),
    ):
        path.write_bytes(content)
    job = store.create_job("science", "space", "Space", {"text": "space"})
    job = store.update_job(
        job["id"],
        status="ready",
        api_task_id="task-one",
        review_status="pending",
    )
    storyboard = {
        "title": "Space",
        "config": {"media_workflow": "api/grok/grok-imagine-video"},
        "frames": [
            {
                "narration": "The first narration",
                "image_prompt": "A clean scientific illustration",
                "audio_path": str(audio),
                "image_path" if image_media else "video_path": str(media),
                "video_segment_path": str(segment),
                "media_type": "image" if image_media else "video",
                "duration": 5,
                "image_motion": "push_in",
                "transition": "none",
                "transition_duration": 0,
                "focus_x": 0.78,
                "focus_y": 0.34,
                "focus_confidence": 0.61,
                "focus_source": "local_saliency_v1",
            }
        ],
        "final_video_path": str(final),
        "total_duration": 5,
    }
    project = store.import_project_revision(
        job["id"],
        storyboard,
        {"config": {"llm_model": "grok-4.5"}, "input": {"n_scenes": 1}},
        quality_checks
        if quality_checks is not None
        else [{"name": "video_codec", "status": "pass", "detail": {"codec": "h264"}}],
    )
    return job, project


def test_project_revision_scene_and_artifact_lifecycle(tmp_path: Path):
    with ProductionStore(str(tmp_path / "production.db")) as store:
        job, project = _import_project(store, tmp_path)
        active = project["revisions"][0]
        assert active["number"] == 1
        assert active["quality_status"] == "pass"
        assert active["scenes"][0]["artifacts"][0]["sha256"]
        assert active["artifacts"][0]["kind"] == "final_video"
        assert active["scenes"][0]["focus_x"] == 0.78
        assert active["scenes"][0]["focus_source"] == "local_saliency_v1"

        draft = store.create_revision(project["id"], "Shorten the opening")
        assert draft["number"] == 2
        assert draft["status"] == "draft"
        scene = store.update_scene(
            draft["scenes"][0]["id"],
            narration="A tighter opening narration",
            image_motion="pan_left",
            focus_x=0.64,
            focus_y=0.42,
            focus_confidence=1,
            focus_source="studio_manual",
            locked=True,
        )
        assert scene["locked"] is True
        assert scene["narration"].startswith("A tighter")
        assert scene["image_motion"] == "pan_left"
        assert scene["focus_x"] == 0.64
        assert scene["focus_source"] == "studio_manual"

        unlocked = store.update_scene(scene["id"], locked=False)
        split = store.split_scene(
            unlocked["id"],
            "A second scene",
            "A second scientific visual",
        )
        assert len(split["scenes"]) == 2
        reordered = store.reorder_scenes(
            draft["id"],
            [split["scenes"][1]["id"], split["scenes"][0]["id"]],
        )
        merged = store.merge_scenes(
            reordered["scenes"][0]["id"],
            reordered["scenes"][1]["id"],
        )
        assert len(merged["scenes"]) == 1
        store.update_job(
            job["id"],
            result_json={
                "video_path": "outdated-native.mp4",
                "render_engine": "native_image_html",
                "render_fallback_reason": "outdated HyperFrames failure",
            },
        )
        activated = store.activate_revision(project["id"], draft["id"])
        assert activated["current_revision_id"] == draft["id"]
        refreshed_job = store.get_job(job["id"])
        assert Path(refreshed_job["result"]["video_path"]).parts[-2:] == (
            "task-one",
            "final.mp4",
        )
        assert refreshed_job["result"]["active_revision_id"] == draft["id"]
        assert "video_url" not in refreshed_job["result"]
        assert "render_fallback_reason" not in refreshed_job["result"]
        assert next(item for item in activated["revisions"] if item["number"] == 1)[
            "status"
        ] == "archived"


def test_catalog_sync_returns_project_with_current_revision(tmp_path: Path):
    """Completed runner jobs must sync without treating a project id as a revision id."""
    with ProductionStore(str(tmp_path / "production.db")) as store:
        job, _project = _import_project(store, tmp_path)
        task_dir = tmp_path / "output" / "task-one"
        final_path = task_dir / "final.mp4"
        storyboard = {
            "title": "Space",
            "config": {"media_workflow": "api/grok/grok-imagine-video"},
            "frames": [],
            "final_video_path": str(final_path),
            "total_duration": 5,
        }
        (task_dir / "storyboard.json").write_text(
            json.dumps(storyboard), encoding="utf-8"
        )
        (task_dir / "metadata.json").write_text("{}", encoding="utf-8")

        project = sync_job_project(
            store,
            job,
            output_dir=tmp_path / "output",
            deep_quality=False,
        )

    assert project["id"] == f"project:{job['id']}"
    assert project["current_revision_id"] == f"revision:{job['id']}:1"
    current = next(
        revision
        for revision in project["revisions"]
        if revision["id"] == project["current_revision_id"]
    )
    assert any(item["kind"] == "artifacts_manifest" for item in current["artifacts"])


def test_scene_subtitle_v2_fields_migrate_persist_validate_and_copy(tmp_path: Path):
    database = tmp_path / "production.db"
    with ProductionStore(str(database)) as store:
        _job, project = _import_project(store, tmp_path)
        columns = {
            row["name"]
            for row in store._connection.execute(
                "PRAGMA table_info(production_scenes)"
            ).fetchall()
        }
        assert {
            "subtitle_effect",
            "subtitle_keywords_json",
            "subtitle_start_offset",
            "subtitle_end_offset",
        } <= columns

        draft = store.create_revision(project["id"], "逐镜字幕")
        scene = store.update_scene(
            draft["scenes"][0]["id"],
            subtitle_effect="typewriter",
            subtitle_keywords=["边界感", "情绪", "边界感"],
            subtitle_start_offset=0.25,
            subtitle_end_offset=0.4,
        )
        assert scene["subtitle_effect"] == "typewriter"
        assert scene["subtitle_keywords"] == ["边界感", "情绪"]
        assert scene["subtitle_start_offset"] == 0.25
        assert scene["subtitle_end_offset"] == 0.4

        copied = store.create_revision(project["id"], source_revision_id=draft["id"])
        copied_scene = copied["scenes"][0]
        assert copied_scene["subtitle_effect"] == "typewriter"
        assert copied_scene["subtitle_keywords"] == ["边界感", "情绪"]
        assert copied_scene["subtitle_start_offset"] == 0.25
        assert copied_scene["subtitle_end_offset"] == 0.4

        with pytest.raises(ValueError, match="at least 0.1 seconds"):
            store.update_scene(
                copied_scene["id"],
                subtitle_start_offset=2.6,
                subtitle_end_offset=2.4,
            )


def test_project_api_returns_media_urls(tmp_path: Path):
    original = api_config.production_config_path
    api_config.production_config_path = str(_config(tmp_path))
    try:
        with ProductionStore(str(tmp_path / "production.db")) as store:
            job, project = _import_project(store, tmp_path)
        client = TestClient(app)
        detail = client.get(f"/api/projects/by-job/{job['id']}")
        created = client.post(
            f"/api/projects/{project['id']}/revisions",
            json={"note": "API draft"},
        )
        assert detail.status_code == 200
        revision = detail.json()["revisions"][0]
        assert revision["artifacts"][0]["url"].endswith("/task-one/final.mp4")
        assert revision["scenes"][0]["audio_url"].endswith("/frames/01_audio.mp3")
        assert created.status_code == 201
        assert created.json()["status"] == "draft"
    finally:
        api_config.production_config_path = original


def test_stale_active_revision_blocks_approval(tmp_path: Path):
    original = api_config.production_config_path
    api_config.production_config_path = str(_config(tmp_path))
    try:
        with ProductionStore(str(tmp_path / "production.db")) as store:
            job, project = _import_project(store, tmp_path)
            draft = store.create_revision(project["id"], "Changed narration")
            store.update_scene(draft["scenes"][0]["id"], narration="Changed")
            store.activate_revision(project["id"], draft["id"])

        response = TestClient(app).post(
            f"/api/production/jobs/{job['id']}/approve",
            json={"note": "Looks good"},
        )
        assert response.status_code == 409
        assert "quality gate is not ready" in response.json()["detail"]
    finally:
        api_config.production_config_path = original


def test_scene_regeneration_atomically_recomposes_draft(tmp_path: Path):
    class FakeProcessor:
        async def __call__(self, frame, storyboard, config, total_frames):
            task_dir = tmp_path / "regenerated" / config.task_id / "frames"
            task_dir.mkdir(parents=True)
            frame.audio_path = str(task_dir / "01_audio.mp3")
            frame.video_path = str(task_dir / "01_video.mp4")
            frame.video_segment_path = str(task_dir / "01_segment.mp4")
            frame.media_type = "video"
            frame.duration = 4.5
            for path in (frame.audio_path, frame.video_path, frame.video_segment_path):
                Path(path).write_bytes(b"regenerated")
            return frame

    class FakeVideoService:
        def concat_videos(self, videos, output, **_kwargs):
            assert all(Path(path).is_file() for path in videos)
            Path(output).write_bytes(b"recomposed")
            return output

    with ProductionStore(str(tmp_path / "production.db")) as store:
        _job, project = _import_project(store, tmp_path)
        draft = store.create_revision(project["id"], "Regenerate opening")
        scene_id = draft["scenes"][0]["id"]
        original_segment = draft["scenes"][0]["segment_path"]
        store.begin_scene_regeneration(scene_id, "scene-task", "full")
        result = asyncio.run(
            regenerate_scene(
                store=store,
                scene_id=scene_id,
                task_id="scene-task",
                scope="full",
                preserve_style=False,
                core=SimpleNamespace(frame_processor=FakeProcessor()),
                video_service=FakeVideoService(),
                quality_inspector=lambda *_args, **_kwargs: [
                    {"name": "file", "status": "pass", "detail": {}}
                ],
                output_dir=tmp_path / "regenerated",
            )
        )
        updated = store.get_revision(draft["id"])
        active = store.get_revision(project["current_revision_id"])

    assert result["quality_status"] == "pass"
    assert updated["scenes"][0]["regeneration_status"] == "completed"
    assert updated["scenes"][0]["segment_path"] != original_segment
    assert Path(updated["artifacts"][0]["path"]).parts[-2:] == (
        "scene-task",
        "final.mp4",
    )
    assert active["scenes"][0]["segment_path"] == original_segment
    assert (tmp_path / "regenerated" / "scene-task" / "storyboard.json").is_file()


def test_scene_regeneration_failure_preserves_existing_artifacts(tmp_path: Path):
    class FailingProcessor:
        async def __call__(self, frame, storyboard, config, total_frames):
            raise RuntimeError("isolated generation failed")

    with ProductionStore(str(tmp_path / "production.db")) as store:
        _job, project = _import_project(store, tmp_path)
        draft = store.create_revision(project["id"], "Failure should be recoverable")
        scene_id = draft["scenes"][0]["id"]
        old_scene = draft["scenes"][0]
        old_final = draft["artifacts"][0]["path"]
        store.begin_scene_regeneration(scene_id, "failed-scene-task", "full")

        with pytest.raises(RuntimeError, match="isolated generation failed"):
            asyncio.run(
                regenerate_scene(
                    store=store,
                    scene_id=scene_id,
                    task_id="failed-scene-task",
                    scope="full",
                    preserve_style=False,
                    core=SimpleNamespace(frame_processor=FailingProcessor()),
                    output_dir=tmp_path / "failed-regeneration",
                )
            )

        failed = store.get_revision(draft["id"])

    failed_scene = failed["scenes"][0]
    assert failed_scene["regeneration_status"] == "failed"
    assert failed_scene["regeneration_error"] == "isolated generation failed"
    assert failed_scene["audio_path"] == old_scene["audio_path"]
    assert failed_scene["media_path"] == old_scene["media_path"]
    assert failed_scene["segment_path"] == old_scene["segment_path"]
    assert failed["artifacts"][0]["path"] == old_final


def test_scene_regeneration_endpoint_schedules_one_durable_task(
    tmp_path: Path,
    monkeypatch,
):
    original = api_config.production_config_path
    api_config.production_config_path = str(_config(tmp_path))
    execute = AsyncMock()
    task = Task(task_id="scene-task", task_type=TaskType.SCENE_REGENERATION)
    monkeypatch.setattr(task_manager, "create_task", lambda *args, **kwargs: task)
    monkeypatch.setattr(task_manager, "execute_task", execute)
    try:
        with ProductionStore(str(tmp_path / "production.db")) as store:
            _job, project = _import_project(store, tmp_path)
            draft = store.create_revision(project["id"], "API regeneration")
            scene_id = draft["scenes"][0]["id"]

        response = TestClient(app).post(
            f"/api/projects/scenes/{scene_id}/regenerate",
            json={"scope": "visual", "preserve_style": True},
        )
        assert response.status_code == 202
        assert response.json()["task_id"] == "scene-task"
        execute.assert_awaited_once_with("scene-task")
        with ProductionStore(str(tmp_path / "production.db")) as store:
            scene = store.get_scene_context(scene_id)["scene"]
        assert scene["regeneration_status"] == "pending"
        assert scene["regeneration_scope"] == "visual"
    finally:
        api_config.production_config_path = original


def test_renderer_variant_keeps_source_hashes_and_replaces_only_render_artifacts(
    tmp_path: Path,
):
    with ProductionStore(str(tmp_path / "production.db")) as store:
        _job, project = _import_project(store, tmp_path, image_media=True)
        source = project["revisions"][0]
        variant = store.create_renderer_variant(source["id"], "hyperframes")

        source_media = source["scenes"][0]["artifacts"]
        variant_media = variant["scenes"][0]["artifacts"]
        source_hashes = {
            item["kind"]: item["sha256"]
            for item in source_media
            if item["kind"] in {"audio", "source_media"}
        }
        variant_hashes = {
            item["kind"]: item["sha256"]
            for item in variant_media
            if item["kind"] in {"audio", "source_media"}
        }

    assert variant["parent_revision_id"] == source["id"]
    assert variant["render_status"] == "planned"
    assert variant["render_engine"] == "hyperframes"
    assert variant["config"]["render_engine"] == "hyperframes"
    assert variant["scenes"][0]["segment_path"] is None
    assert not variant["artifacts"]
    assert variant_hashes == source_hashes


def test_whiteboard_renderer_variant_freezes_independent_profile(tmp_path: Path):
    with ProductionStore(str(tmp_path / "production.db")) as store:
        _job, project = _import_project(store, tmp_path, image_media=True)
        source = project["revisions"][0]
        variant = store.create_renderer_variant(source["id"], "whiteboard_cv")

    assert variant["render_engine"] == "whiteboard_cv"
    assert variant["config"]["production_mode"] == "whiteboard_animation"
    assert variant["config"]["renderer_version"] == "whiteboard-cv-v1"
    assert variant["config"]["frame_template"] is None
    assert variant["config"]["whiteboard"]["template_id"] == "minimal-whiteboard"
    assert variant["config"]["whiteboard"]["template_fingerprint"]
    assert variant["scenes"][0]["segment_path"] is None


def test_renderer_variant_endpoint_rejects_removed_native_choice(
    tmp_path: Path,
    monkeypatch,
):
    original = api_config.production_config_path
    api_config.production_config_path = str(_config(tmp_path))
    try:
        with ProductionStore(str(tmp_path / "production.db")) as store:
            _job, project = _import_project(store, tmp_path, image_media=True)
            revision_id = project["current_revision_id"]

        response = TestClient(app).post(
            f"/api/projects/revisions/{revision_id}/render-variant",
            json={"engine": "native_image_html"},
        )

        assert response.status_code == 422
    finally:
        api_config.production_config_path = original


def test_native_renderer_variant_reuses_image_and_audio_without_generation(
    tmp_path: Path,
    monkeypatch,
):
    class FrozenAssetProcessor:
        async def __call__(self, frame, storyboard, config, total_frames):
            assert Path(frame.image_path).is_file()
            assert Path(frame.audio_path).is_file()
            assert frame.image_prompt
            output = tmp_path / "output" / config.task_id / "frames"
            output.mkdir(parents=True, exist_ok=True)
            frame.composed_image_path = str(output / "01_composed.png")
            frame.overlay_image_path = str(output / "01_overlay.png")
            frame.video_segment_path = str(output / "01_segment.mp4")
            Path(frame.composed_image_path).write_bytes(b"composed")
            Path(frame.overlay_image_path).write_bytes(b"overlay")
            Path(frame.video_segment_path).write_bytes(b"segment")
            return frame

    class FakeVideoService:
        def concat_videos(self, videos, output, **_kwargs):
            assert all(Path(path).is_file() for path in videos)
            Path(output).parent.mkdir(parents=True, exist_ok=True)
            Path(output).write_bytes(b"same-assets-native")
            return output

    monkeypatch.setattr(
        "pixelle_video.production.renderer_variants.VideoService",
        FakeVideoService,
    )
    monkeypatch.setattr(
        "pixelle_video.production.renderer_variants.inspect_video",
        lambda *_args, **_kwargs: [{"name": "file", "status": "pass", "detail": {}}],
    )
    monkeypatch.setattr(
        "pixelle_video.production.renderer_variants.inspect_subtitle_layout",
        lambda *_args, **_kwargs: {
            "name": "subtitle_safe_area",
            "status": "pass",
            "detail": {},
        },
    )
    monkeypatch.setenv("PIXELLE_VIDEO_ROOT", str(tmp_path))

    with ProductionStore(str(tmp_path / "production.db")) as store:
        _job, project = _import_project(store, tmp_path, image_media=True)
        source = project["revisions"][0]
        variant = store.create_renderer_variant(source["id"], "native_image_html")
        store.attach_renderer_variant_task(variant["id"], "native-variant-task")
        result = asyncio.run(
            render_revision_variant(
                store,
                variant["id"],
                "native-variant-task",
                SimpleNamespace(frame_processor=FrozenAssetProcessor()),
            )
        )
        completed = store.get_revision(variant["id"])

    assert result["render_engine"] == "native_image_html"
    assert completed["render_status"] == "completed"
    assert completed["quality_status"] == "pass"
    assert completed["scenes"][0]["media_path"] == source["scenes"][0]["media_path"]
    assert completed["scenes"][0]["audio_path"] == source["scenes"][0]["audio_path"]
    assert completed["scenes"][0]["segment_path"].endswith("01_segment.mp4")
    assert completed["artifacts"][0]["path"].endswith("final.mp4")


def test_quality_inspection_reports_missing_file(tmp_path: Path):
    checks = inspect_video(tmp_path / "missing.mp4")
    assert checks == [
        {
            "name": "file",
            "status": "fail",
            "detail": {"path": str((tmp_path / "missing.mp4").resolve()), "reason": "missing"},
        }
    ]


def test_subtitle_layout_gate_reports_adjustment_and_violation(tmp_path: Path):
    overlay = tmp_path / "01_composed.png"
    overlay.write_bytes(b"overlay")
    layout = overlay.with_suffix(".layout.json")
    layout.write_text(
        json.dumps(
            {
                "elements": [
                    {
                        "kind": "subtitle",
                        "adjusted": True,
                        "in_safe_area": True,
                    }
                ]
            }
        ),
        encoding="utf-8",
    )
    frames = [{"index": 0, "composed_image_path": str(overlay)}]

    passed = inspect_subtitle_layout(frames)
    assert passed["status"] == "pass"
    assert passed["detail"]["adjusted_scenes"] == [1]

    layout.write_text(
        json.dumps(
            {
                "elements": [
                    {
                        "kind": "subtitle",
                        "adjusted": True,
                        "in_safe_area": False,
                    }
                ]
            }
        ),
        encoding="utf-8",
    )
    failed = inspect_subtitle_layout(frames)
    assert failed["status"] == "fail"
    assert failed["detail"]["affected_scenes"] == [1]


def test_quality_repair_plan_merges_audio_and_visual_into_full_scene_rebuild():
    plan = build_quality_repair_plan(
        {
            "id": "revision:one",
            "scenes": [
                {"position": 0, "locked": False},
                {"position": 1, "locked": True},
            ],
            "quality_checks": [
                {"check_name": "audio_stream", "status": "fail", "detail": {}},
                {"check_name": "black_frames", "status": "fail", "detail": {}},
                {
                    "check_name": "content_prohibited_claims",
                    "status": "fail",
                    "detail": {},
                },
            ],
        }
    )

    assert plan["steps"] == [
        {
            "scope": "full",
            "scenes": [1],
            "checks": ["audio_stream", "black_frames"],
        }
    ]
    assert plan["locked_scenes"] == [2]
    assert plan["manual_checks"] == ["content_prohibited_claims"]


def test_quality_repair_endpoint_creates_audited_draft_task(tmp_path: Path, monkeypatch):
    original = api_config.production_config_path
    api_config.production_config_path = str(_config(tmp_path))
    execute = AsyncMock()
    task = Task(task_id="repair-task", task_type=TaskType.QUALITY_REPAIR)
    monkeypatch.setattr(task_manager, "create_task", lambda *args, **kwargs: task)
    monkeypatch.setattr(task_manager, "execute_task", execute)
    try:
        with ProductionStore(str(tmp_path / "production.db")) as store:
            _job, project = _import_project(
                store,
                tmp_path,
                [{"name": "audio_stream", "status": "fail", "detail": {}}],
            )
            revision_id = project["current_revision_id"]

        response = TestClient(app).post(
            f"/api/projects/revisions/{revision_id}/auto-repair"
        )

        assert response.status_code == 202
        assert response.json()["task_id"] == "repair-task"
        execute.assert_awaited_once_with("repair-task")
        with ProductionStore(str(tmp_path / "production.db")) as store:
            source = store.get_revision(revision_id)
            target = store.get_revision(response.json()["target_revision_id"])
        assert source["repair_status"] == "pending"
        assert target["status"] == "draft"
        assert target["repair_plan"]["steps"][0]["scope"] == "voice"
    finally:
        api_config.production_config_path = original
