import asyncio
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi.testclient import TestClient

from api.app import app
from api.config import api_config
from api.routers.production import (
    _await_redirection_stage,
    _merge_review_scenes,
    _redirection_output_budget,
    _redirection_steps,
    _repair_custom_script_request,
    _review_target_positions,
    execute_custom_script_recommendation_task,
    execute_storyboard_redirection_task,
)
from api.schemas.production import (
    CustomScriptRecommendation,
    ReviewStoryboardDirection,
    ReviewStoryboardScenePatch,
)
from api.tasks import Task, TaskProgress, TaskStatus, TaskType, task_manager
from pixelle_video.production import ProductionStore
from pixelle_video.production.planning import (
    LLMAudit,
    plan_storyboard,
    recommend_custom_script_scene_count,
)
from pixelle_video.production.runner_control import production_runner_manager
from pixelle_video.production.topics import TopicSuggestion, TopicSuggestionBatch


def test_review_redirection_only_merges_flagged_scenes():
    original = [
        {"position": 0, "narration": "keep one", "visual_prompt": "keep visual one", "transition": "none"},
        {"position": 1, "narration": "change two", "visual_prompt": "old visual two", "transition": "crossfade"},
        {"position": 2, "narration": "keep three", "visual_prompt": "keep visual three", "transition": "crossfade"},
    ]
    directed = [
        {"position": 0, "narration": "rewritten one", "visual_prompt": "rewritten visual one"},
        {"position": 1, "narration": "fixed two", "visual_prompt": "fixed visual two"},
        {"position": 2, "narration": "rewritten three", "visual_prompt": "rewritten visual three"},
    ]

    merged = _merge_review_scenes(original, directed, {1})

    assert merged[0]["narration"] == "keep one"
    assert merged[1]["narration"] == "fixed two"
    assert merged[2]["narration"] == "keep three"

    partial = _merge_review_scenes(original, [directed[1]], {1})
    assert partial[0]["narration"] == "keep one"
    assert partial[1]["narration"] == "fixed two"
    assert partial[2]["narration"] == "keep three"


def test_review_target_positions_follow_audit_details():
    scenes = [
        {"position": 0, "narration": "百分百有效"},
        {"position": 1, "narration": "可能还需要核实"},
    ]
    checks = [
        {"name": "content_prohibited_claims", "status": "fail", "detail": {"matches": ["百分百有效"]}},
        {"name": "content_llm_review", "status": "warn", "detail": {"issues": [{"scene": 2}] }},
    ]

    assert _review_target_positions(checks, scenes) == {0, 1}


def test_review_redirection_progress_steps_and_budget_are_bounded():
    steps = _redirection_steps("audit")

    assert [step["label"] for step in steps] == [
        "读取审查建议",
        "定位需要修订的镜头",
        "AI 重新导演",
        "合并目标镜头",
        "AI 事实与安全复核",
        "保存分镜结果",
    ]
    assert [step["status"] for step in steps] == [
        "completed",
        "completed",
        "completed",
        "completed",
        "active",
        "pending",
    ]
    assert _redirection_output_budget(1) == 1800
    assert _redirection_output_budget(10) == 5000


@pytest.mark.asyncio
async def test_redirection_stage_reports_heartbeat_while_model_is_running(monkeypatch):
    monkeypatch.setattr("api.routers.production._REDIRECTION_HEARTBEAT_SECONDS", 0.01)
    updates: list[str] = []

    def progress(_current, _total, message, *, steps):
        updates.append(message)
        assert steps[2]["status"] == "active"

    async def slow_operation():
        await asyncio.sleep(0.04)
        return "done"

    result = await _await_redirection_stage(
        slow_operation(),
        progress=progress,
        current=35,
        message="正在使用文字模型重新导演",
        steps=_redirection_steps("director"),
        operation_name="测试模型调用",
    )

    assert result == "done"
    assert any("仍在处理中" in message for message in updates)


def _write_config(tmp_path: Path) -> Path:
    channels = tmp_path / "channels"
    channels.mkdir()
    (channels / "science.yaml").write_text(
        """id: science
name: Science
topic:
  strategy: seed
  seeds: [space]
inventory:
  ready_target: 2
  daily_target: 1
  max_in_flight: 1
visual_memory:
  characters: [蓝色实验助手]
  palette: ['#1E6BFF']
  composition: [主体居中]
  forbidden_elements: []
  exemplars: []
video:
  frame_template: 1080x1920/video_default.html
  media_workflow: api/grok/grok-imagine-video
  watermark:
    enabled: true
    text: Science
    motion: fixed
    opacity: 0.4
    position: bottom_right
  voice_preset:
    voice_id: zh-CN-YunxiNeural
    tts_speed: 1.05
    voice_volume: 0.82
    bgm_volume: 0.12
    emotion: neutral
    bgm_path: ''
    bgm_mode: loop
    intro_path: ''
    outro_path: ''
    auto_duck: true
    duck_threshold_db: -20
    duck_reduction_db: 8
    loudness_target_lufs: -14
""",
        encoding="utf-8",
    )
    config = tmp_path / "runner.yaml"
    config.write_text(
        f"database_path: {tmp_path / 'production.db'}\n"
        f"channels_dir: {channels}\n",
        encoding="utf-8",
    )
    return config


def test_production_status_and_jobs(tmp_path: Path):
    original = api_config.production_config_path
    api_config.production_config_path = str(_write_config(tmp_path))
    try:
        with ProductionStore(str(tmp_path / "production.db")) as store:
            job = store.create_job("science", "space", "Space", {"text": "space"})
        client = TestClient(app)
        status = client.get("/api/production/status")
        jobs = client.get("/api/production/jobs")
        detail = client.get(f"/api/production/jobs/{job['id']}")
        assert status.status_code == 200
        assert status.json()["runner"]["state"] in {
            "stopped",
            "starting",
            "running",
            "stopping",
            "failed",
        }
        assert status.json()["channels"][0]["planned"] == 1
        assert jobs.json()["count"] == 1
        assert jobs.json()["jobs"][0]["channel_name"] == "Science"
        assert detail.json()["topic"] == "space"
    finally:
        api_config.production_config_path = original


def test_runner_control_endpoints(monkeypatch):
    start = AsyncMock(return_value={"enabled": True, "state": "starting"})
    stop = AsyncMock(return_value={"enabled": False, "state": "stopped"})
    monkeypatch.setattr(production_runner_manager, "start", start)
    monkeypatch.setattr(production_runner_manager, "stop", stop)

    client = TestClient(app)
    started = client.post("/api/production/runner/start")
    stopped = client.post("/api/production/runner/stop")

    assert started.status_code == 200
    assert started.json() == {"enabled": True, "state": "starting"}
    assert stopped.status_code == 200
    assert stopped.json() == {"enabled": False, "state": "stopped"}
    start.assert_awaited_once_with()
    stop.assert_awaited_once_with()


def test_job_timelines_batch_preserves_per_job_limit_and_handles_large_lists(tmp_path: Path):
    with ProductionStore(str(tmp_path / "production.db")) as store:
        first = store.create_job("science", "space", "Space", {"text": "space"})
        second = store.create_job("science", "ocean", "Ocean", {"text": "ocean"})
        for job in (first, second):
            for index in range(3):
                store.append_job_event(job["id"], f"stage-{index}", "progress")

        timelines = store.get_job_timelines([first["id"], second["id"]], limit=2)
        assert [event["stage"] for event in timelines[first["id"]]] == [
            "queue",
            "stage-0",
        ]
        assert timelines[first["id"]] == store.get_job_timeline(first["id"], limit=2)
        assert len(store.get_job_timelines([f"missing-{index}" for index in range(1000)])) == 1000


@pytest.mark.asyncio
async def test_custom_script_recommendation_and_job_creation(tmp_path: Path, monkeypatch):
    original = api_config.production_config_path
    api_config.production_config_path = str(_write_config(tmp_path))

    async def fake_llm(**kwargs):
        assert kwargs["response_type"] is CustomScriptRecommendation
        return CustomScriptRecommendation(
            title="为什么天空看起来是蓝色",
            script="优化后的完整科普文案，保留原始事实并让叙事更紧凑。这里补足测试所需长度。",
            production_mode="whiteboard_animation",
            subtitle_effect="typewriter",
            n_scenes=5,
            content_policy="science",
            image_motion="push_in",
            transition="crossfade",
            rationale="白板动画适合逐步解释散射过程。",
            review_status="pass",
            review_summary="事实边界清晰。",
        )

    monkeypatch.setattr(
        "api.routers.production.get_pixelle_video",
        AsyncMock(return_value=SimpleNamespace(llm=fake_llm)),
    )
    monkeypatch.setattr(task_manager, "execute_task", AsyncMock())
    try:
        client = TestClient(app)
        original_script = "天空为什么呈现蓝色？这是一段等待优化的完整科普文案。"
        recommendation = client.post(
            "/api/production/custom-script/recommend",
            json={
                "channel_id": "science",
                "script": original_script,
                "rewrite_enabled": True,
                "review_mode": "ai_auto",
            },
        )
        assert recommendation.status_code == 202
        task_id = recommendation.json()["task_id"]
        durable_task = task_manager.get_task(task_id)
        assert durable_task is not None
        assert durable_task.task_type == TaskType.CUSTOM_SCRIPT_RECOMMENDATION
        assert durable_task.request_params is not None
        assert durable_task.request_params["script"] == original_script

        executed = await execute_custom_script_recommendation_task(durable_task)
        produced = executed["recommendation"]
        assert produced["production_mode"] == "whiteboard_animation"
        assert produced["original_script"] == original_script
        assert produced["n_scenes"] == recommend_custom_script_scene_count(
            produced["script"]
        )
        assert "按当前文案" in produced["scene_count_basis"]

        payload = produced
        created = client.post(
            "/api/production/custom-script/jobs",
            json={
                "channel_id": "science",
                "script": payload["script"],
                "original_script": payload["original_script"],
                "title": payload["title"],
                "rewrite_enabled": True,
                "review_mode": "manual",
                "production_mode": payload["production_mode"],
                "subtitle_effect": payload["subtitle_effect"],
                "n_scenes": payload["n_scenes"],
                "content_policy": payload["content_policy"],
                "image_motion": payload["image_motion"],
                "transition": payload["transition"],
                "voice_id": "zh-CN-YunxiNeural",
                "tts_speed": 1.1,
                "bgm_volume": 0.15,
                "image_generation_concurrency": 6,
                "whiteboard_template_id": "minimal-whiteboard",
            },
        )
        assert created.status_code == 202
        job = created.json()["job"]
        assert job["status"] == "planning"
        assert job["request"]["mode"] == "fixed"
        assert job["request"]["production_mode"] == "whiteboard_animation"
        assert job["request"]["frame_template"] is None
        assert job["request"]["template_sha256"] is None
        assert job["request"]["media_workflow"].startswith("api/")
        assert "/default/" not in job["request"]["media_workflow"]
        assert job["request"]["whiteboard"]["template_id"] == "minimal-whiteboard"
        assert job["request"]["image_generation_concurrency"] == 6
        assert job["request"]["visual_memory"]["characters"] == ["蓝色实验助手"]
        assert job["request"]["watermark"]["text"] == "Science"
        assert job["request"]["voice_preset"]["auto_duck"] is True
        assert job["request"]["voice_volume"] == 0.82
        assert job["request"]["voice_preset"]["voice_volume"] == 0.82
        assert job["request"]["_production"]["rendering"]["mode"] == "whiteboard_animation"
        assert job["request"]["_production"]["rendering"]["template"]["path"] is None
        assert job["request"]["_production"]["custom_script"]["original_script"] == original_script
        assert job["request"]["_production"]["planning"]["approval"] == "manual"
    finally:
        api_config.production_config_path = original


def test_legacy_custom_whiteboard_request_is_repaired_for_retry():
    repaired = _repair_custom_script_request(
        {
            "custom_script": True,
            "production_mode": "whiteboard_animation",
            "render_engine": "whiteboard_cv",
            "renderer_version": "whiteboard-cv-v1",
            "media_workflow": "api/default/image",
            "frame_template": "1080x1920/f2_knowledge_card_v1.html",
            "template_sha256": "a" * 64,
            "subtitle_effect": "typewriter",
            "image_motion": "none",
            "transition": "crossfade",
            "whiteboard": {"template_id": "minimal-whiteboard"},
            "_production": {
                "rendering": {
                    "mode": "hyperframes",
                    "engine": "hyperframes",
                    "template": {"path": "1080x1920/f2_knowledge_card_v1.html"},
                }
            },
        }
    )

    assert repaired["frame_template"] is None
    assert repaired["template_sha256"] is None
    assert repaired["media_workflow"].startswith("api/")
    assert repaired["_production"]["rendering"]["mode"] == "whiteboard_animation"
    assert repaired["_production"]["rendering"]["engine"] == "whiteboard_cv"
    assert repaired["_production"]["rendering"]["template"] == {
        "path": None,
        "sha256": None,
    }


def test_custom_scene_count_follows_copy_length_and_paragraphs():
    assert recommend_custom_script_scene_count("短文案也需要一个画面。") == 1
    assert recommend_custom_script_scene_count("甲" * 210) == 3
    assert recommend_custom_script_scene_count("第一段内容" * 8 + "。第二段内容" * 8 + "。") >= 2
    assert recommend_custom_script_scene_count("长" * 2_000) > 20


@pytest.mark.asyncio
async def test_custom_script_storyboard_has_no_scene_cap_or_oversized_last_scene():
    script = "长" * 2_000
    scene_count = recommend_custom_script_scene_count(script)
    plan = await plan_storyboard(
        {
            "text": script,
            "title": "长文案",
            "mode": "fixed",
            "custom_script": True,
            "n_scenes": 3,
            "image_prompts": [f"画面 {index}" for index in range(scene_count)],
        },
        llm=AsyncMock(),
        llm_review=False,
    )

    assert len(plan["scenes"]) == scene_count
    assert len(plan["scenes"]) > 20
    assert max(len(scene["narration"]) for scene in plan["scenes"]) <= 72


def test_production_jobs_include_live_task_progress(tmp_path: Path, monkeypatch):
    original = api_config.production_config_path
    api_config.production_config_path = str(_write_config(tmp_path))
    try:
        with ProductionStore(str(tmp_path / "production.db")) as store:
            job = store.create_job("science", "space", "Space", {"text": "space"})
            job = store.update_job(
                job["id"], status="running", api_task_id="task-progress-1"
            )
        task = Task(
            task_id="task-progress-1",
            task_type=TaskType.VIDEO_GENERATION,
            status=TaskStatus.RUNNING,
            attempts=2,
            progress=TaskProgress(
                current=42,
                total=100,
                percentage=42,
                message="镜头 2/6 · 生成画面",
            ),
        )
        monkeypatch.setattr(
            task_manager,
            "get_task",
            lambda task_id: task if task_id == task.task_id else None,
        )

        payload = TestClient(app).get("/api/production/jobs").json()["jobs"][0]

        assert payload["id"] == job["id"]
        assert payload["progress"] == {
            "current": 42,
            "total": 100,
            "percentage": 42,
            "message": "镜头 2/6 · 生成画面",
            "steps": [],
            "task_id": "task-progress-1",
            "task_type": "video_generation",
            "task_status": "running",
            "attempt": 2,
        }
    finally:
        api_config.production_config_path = original


def test_review_publish_and_library_flow(tmp_path: Path):
    original = api_config.production_config_path
    api_config.production_config_path = str(_write_config(tmp_path))
    try:
        with ProductionStore(str(tmp_path / "production.db")) as store:
            job = store.create_job("science", "space", "Space", {"text": "space"})
            store.update_job(
                job["id"],
                status="ready",
                review_status="pending",
                result_json={"video_url": "http://localhost/video.mp4"},
            )

        client = TestClient(app)
        blocked = client.post("/api/production/channels/science/publish", json={"count": 1})
        approved = client.post(
            f"/api/production/jobs/{job['id']}/approve",
            json={"note": "画面与字幕正常"},
        )
        published = client.post(
            "/api/production/channels/science/publish",
            json={"count": 1},
        )
        library = client.get("/api/production/library/videos")

        assert blocked.status_code == 409
        assert approved.status_code == 200
        assert approved.json()["review_status"] == "approved"
        assert published.status_code == 200
        assert published.json()["jobs"][0]["status"] == "published"
        assert library.json()["videos"][0]["result"]["video_url"].endswith("video.mp4")
    finally:
        api_config.production_config_path = original


def test_batch_review_preflight_and_atomic_execution(tmp_path: Path):
    original = api_config.production_config_path
    api_config.production_config_path = str(_write_config(tmp_path))
    try:
        with ProductionStore(str(tmp_path / "production.db")) as store:
            first = store.create_job("science", "one", "One", {})
            second = store.create_job("science", "two", "Two", {})
            blocked = store.create_job("science", "three", "Three", {})
            store.update_job(first["id"], status="ready", review_status="pending")
            store.update_job(second["id"], status="ready", review_status="pending")

        client = TestClient(app)
        blocked_response = client.post(
            "/api/production/reviews/batch",
            json={
                "job_ids": [first["id"], blocked["id"]],
                "decision": "approved",
            },
        )
        assert blocked_response.status_code == 409
        with ProductionStore(str(tmp_path / "production.db")) as store:
            assert store.get_job(first["id"])["review_status"] == "pending"

        payload = {
            "job_ids": [first["id"], second["id"]],
            "decision": "rejected",
            "note": "批量退回：字幕需要统一。",
        }
        preview = client.post("/api/production/reviews/batch/preview", json=payload)
        executed = client.post("/api/production/reviews/batch", json=payload)
        assert preview.status_code == 200
        assert preview.json()["atomic"] is True
        assert len(preview.json()["eligible"]) == 2
        assert executed.status_code == 200
        assert executed.json()["completed"] == 2
        assert {job["review_status"] for job in executed.json()["jobs"]} == {"rejected"}
    finally:
        api_config.production_config_path = original


def test_batch_queue_retry_and_atomic_delete(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("PIXELLE_VIDEO_ROOT", str(tmp_path))
    original = api_config.production_config_path
    api_config.production_config_path = str(_write_config(tmp_path))
    try:
        with ProductionStore(str(tmp_path / "production.db")) as store:
            first = store.create_job("science", "one", "One", {})
            second = store.create_job("science", "two", "Two", {})
            removable = store.create_job("science", "three", "Three", {})
            removable_second = store.create_job("science", "three-b", "Three B", {})
            blocked = store.create_job("science", "four", "Four", {})
            store.update_job(first["id"], status="failed", error="upstream")
            store.update_job(second["id"], status="failed", error="upstream")
            store.update_job(
                removable["id"],
                status="cancelled",
                api_task_id="task-remove-one",
            )
            store.update_job(
                removable_second["id"],
                status="cancelled",
                api_task_id="task-remove-two",
            )
        task_directories = []
        for task_id in ("task-remove-one", "task-remove-two"):
            for root_name in ("output", "temp"):
                directory = tmp_path / root_name / task_id
                directory.mkdir(parents=True)
                (directory / f"{root_name}.bin").write_bytes(root_name.encode())
                task_directories.append(directory)
        client = TestClient(app)
        retry_payload = {"job_ids": [first["id"], second["id"]]}
        retry_preview = client.post(
            "/api/production/jobs/batch/retry/preview", json=retry_payload
        )
        retried = client.post("/api/production/jobs/batch/retry", json=retry_payload)
        assert retry_preview.status_code == 200
        assert len(retry_preview.json()["eligible"]) == 2
        assert retried.status_code == 200
        assert retried.json()["completed"] == 2
        assert {job["status"] for job in retried.json()["jobs"]} == {"planned"}

        blocked_delete = client.post(
            "/api/production/jobs/batch/delete/preview",
            json={"job_ids": [removable["id"], blocked["id"]]},
        )
        assert len(blocked_delete.json()["blocked"]) == 1
        with ProductionStore(str(tmp_path / "production.db")) as store:
            assert store.get_job(removable["id"])["status"] == "cancelled"

        delete_payload = {
            "job_ids": [removable["id"], removable_second["id"]],
            "confirmation": "DELETE",
            "delete_files": True,
        }
        deleted = client.request(
            "DELETE", "/api/production/jobs/batch", json=delete_payload
        )
        assert deleted.status_code == 200
        assert deleted.json()["deleted"] == 2
        assert deleted.json()["atomic_ledger"] is True
        assert deleted.json()["file_deletion"]["skipped"] == []
        assert set(deleted.json()["file_deletion"]["directories"]) == {
            str(path) for path in task_directories
        }
        assert all(not path.exists() for path in task_directories)
        with ProductionStore(str(tmp_path / "production.db")) as store:
            for job_id in (removable["id"], removable_second["id"]):
                try:
                    store.get_job(job_id)
                except KeyError:
                    continue
                raise AssertionError("batch delete left a selected job in the ledger")
    finally:
        api_config.production_config_path = original


def test_reject_retry_cancel_and_channel_pause(tmp_path: Path):
    original = api_config.production_config_path
    api_config.production_config_path = str(_write_config(tmp_path))
    try:
        with ProductionStore(str(tmp_path / "production.db")) as store:
            rejected_job = store.create_job("science", "one", "One", {"text": "one"})
            store.update_job(
                rejected_job["id"], status="ready", review_status="pending"
            )
            failed_job = store.create_job("science", "two", "Two", {"text": "two"})
            store.update_job(failed_job["id"], status="failed", error="upstream")
            planned_job = store.create_job("science", "three", "Three", {"text": "three"})

        client = TestClient(app)
        rejected = client.post(
            f"/api/production/jobs/{rejected_job['id']}/reject",
            json={"note": "字幕需要修改"},
        )
        retried = client.post(f"/api/production/jobs/{failed_job['id']}/retry")
        cancelled = client.post(f"/api/production/jobs/{planned_job['id']}/cancel")
        paused = client.post("/api/production/channels/science/pause")
        status = client.get("/api/production/status")
        resumed = client.post("/api/production/channels/science/resume")

        assert rejected.json()["review_status"] == "rejected"
        assert rejected.json()["review_note"] == "字幕需要修改"
        assert status.json()["channels"][0]["ready"] == 0
        assert retried.json()["status"] == "planned"
        assert retried.json()["retries"] == 1
        assert cancelled.json()["status"] == "cancelled"
        assert paused.json()["paused"] is True
        assert status.json()["channels"][0]["paused"] is True
        assert resumed.json()["paused"] is False
    finally:
        api_config.production_config_path = original


def test_channel_create_copy_and_hot_edit(tmp_path: Path):
    original = api_config.production_config_path
    api_config.production_config_path = str(_write_config(tmp_path))
    payload = {
        "id": "morning",
        "name": "Morning",
        "enabled": True,
        "topic": {"strategy": "seed", "seeds": ["sunrise"]},
        "inventory": {
            "ready_target": 2,
            "daily_target": 1,
            "max_in_flight": 1,
        },
        "video": {
            "frame_template": "1080x1920/video_default.html",
            "media_workflow": "api/grok/grok-imagine-video",
        },
    }
    try:
        client = TestClient(app)
        created = client.post("/api/production/channels", json=payload)
        updated = client.patch(
            "/api/production/channels/science",
            json={"enabled": False, "inventory": {"ready_target": 7}},
        )
        copied = client.post(
            "/api/production/channels/science/copy",
            json={"id": "science_copy", "name": "Science Copy"},
        )
        channels = client.get("/api/production/channels")

        assert created.status_code == 201
        assert updated.json()["enabled"] is False
        assert updated.json()["inventory"]["ready_target"] == 7
        assert copied.status_code == 201
        assert copied.json()["enabled"] is False
        assert {channel["id"] for channel in channels.json()["channels"]} == {
            "science",
            "morning",
            "science_copy",
        }
        assert created.json()["config_source"] == "api"
        assert copied.json()["config_source"] == "copy"
    finally:
        api_config.production_config_path = original


def test_standalone_brand_and_recipe_presets_are_retired(tmp_path: Path):
    original = api_config.production_config_path
    api_config.production_config_path = str(_write_config(tmp_path))
    try:
        client = TestClient(app)
        assert client.get("/api/production/brand-kits").status_code == 404
        assert client.get("/api/production/recipes").status_code == 404
        channel = client.get("/api/production/channels").json()["channels"][0]
        assert "brand_kit_version_id" not in channel
        assert "recipe_version_id" not in channel
        assert "visual_memory" in channel
    finally:
        api_config.production_config_path = original


def test_topic_inbox_generation_scoring_and_decisions(tmp_path: Path, monkeypatch):
    original = api_config.production_config_path
    api_config.production_config_path = str(_write_config(tmp_path))
    llm = AsyncMock(
        return_value=TopicSuggestionBatch(
            items=[
                    TopicSuggestion(
                    title="雨后为什么会有泥土气味",
                    topic="解释土臭素如何被雨滴带入空气，并区分已知机制与气味偏好。",
                    cover_copy="雨后的味道从哪来",
                    platform_description="一分钟看懂雨后气味。",
                        tags=["天气", "科学"],
                        semantic_terms=["雨滴", "土臭素", "气溶胶", "嗅觉", "多孔土壤"],
                        title_variants=[
                            {
                                "title": "一滴雨，怎样制造熟悉的泥土味？",
                                "angle": "curiosity",
                                "hypothesis": "用可视化过程制造好奇",
                            }
                        ],
                ),
                TopicSuggestion(
                    title="微波炉为何很少直接加热盘子",
                    topic="从介电损耗解释水分子与常见陶瓷盘受热差异，并给出安全边界。",
                    cover_copy="盘子为何没那么烫",
                    tags=["物理", "生活"],
                ),
            ]
        )
    )
    monkeypatch.setattr(
        "api.routers.production.get_pixelle_video",
        AsyncMock(return_value=SimpleNamespace(llm=llm)),
    )
    try:
        client = TestClient(app)
        generated = client.post(
            "/api/production/topics/generate",
            json={"channel_id": "science", "count": 2, "source_type": "prompt"},
        )
        assert generated.status_code == 201
        assert generated.json()["fallback"] is False
        topics = generated.json()["topics"]
        assert len(topics) == 2
        assert {
            "overall", "novelty", "semantic_similarity", "lexical_similarity",
            "specificity", "credibility", "channel_fit"
        }.issubset(topics[0]["scores"])
        assert topics[0]["score_reasons"]["novelty"]
        assert len(topics[0]["semantic_vector"]) == 384
        assert len(topics[0]["title_variants"]) == 2
        selected = client.patch(
            f"/api/production/topics/{topics[0]['id']}/title",
            json={"variant_id": "variant-1"},
        )
        assert selected.status_code == 200
        assert selected.json()["title"] == "一滴雨，怎样制造熟悉的泥土味？"
        assert selected.json()["selected_title_id"] == "variant-1"

        pinned = client.patch(
            f"/api/production/topics/{topics[0]['id']}",
            json={"status": "pinned", "note": "明天优先生产"},
        )
        discarded = client.patch(
            f"/api/production/topics/{topics[1]['id']}",
            json={"status": "discarded", "note": "本周已有相近内容"},
        )
        listed = client.get("/api/production/topics?channel_id=science&status=pinned")
        assert pinned.json()["status"] == "pinned"
        assert discarded.json()["status"] == "discarded"
        assert listed.json()["count"] == 1
        assert listed.json()["topics"][0]["decision_note"] == "明天优先生产"
        llm.assert_awaited_once()
    finally:
        api_config.production_config_path = original


def test_channel_sample_creates_exactly_one_durable_task(tmp_path: Path, monkeypatch):
    original = api_config.production_config_path
    api_config.production_config_path = str(_write_config(tmp_path))
    task = Task(task_id="sample-task", task_type=TaskType.VIDEO_GENERATION)
    execute = AsyncMock()
    monkeypatch.setattr(task_manager, "create_task", lambda *args, **kwargs: task)
    monkeypatch.setattr(task_manager, "execute_task", execute)
    try:
        response = TestClient(app).post(
            "/api/production/channels/science/test",
            json={"topic": "为什么天空是蓝色的"},
        )
        assert response.status_code == 202
        assert response.json()["task_id"] == "sample-task"
        assert response.json()["job"]["status"] == "pending"
        execute.assert_awaited_once_with("sample-task")
        with ProductionStore(str(tmp_path / "production.db")) as store:
            jobs = store.list_jobs(channel_id="science")
            assert len(jobs) == 1
            assert jobs[0]["title"].startswith("[测试]")
    finally:
        api_config.production_config_path = original


def test_storyboard_edit_and_approval_freezes_generation_request(
    tmp_path: Path, monkeypatch
):
    original = api_config.production_config_path
    api_config.production_config_path = str(_write_config(tmp_path))
    try:
        with ProductionStore(str(tmp_path / "production.db")) as store:
            job = store.create_job(
                "science",
                "space",
                "Space",
                {
                    "text": "space",
                    "frame_template": "1080x1920/video_default.html",
                    "media_workflow": "api/grok/grok-imagine-video",
                },
            )
            store.update_job(
                job["id"],
                status="planning",
                storyboard_task_id="plan-task",
            )
            store.save_storyboard_plan(
                job["id"],
                "plan-task",
                {
                    "title": "Space",
                    "content_policy": "science",
                    "content_gate_status": "pass",
                    "content_checks": [
                        {
                            "name": "content_fact_boundaries",
                            "status": "warn",
                            "detail": {"summary": "补充事实与推测边界"},
                        }
                    ],
                    "scenes": [
                        {
                            "position": 0,
                            "narration": "Old narration",
                            "visual_prompt": "Old visual",
                        }
                    ],
                },
            )

        director_prompts: list[str] = []

        async def director_llm(*_args, response_type=None, prompt="", **_kwargs):
            if response_type is ReviewStoryboardDirection:
                director_prompts.append(prompt)
                return ReviewStoryboardDirection(
                    scenes=[
                        ReviewStoryboardScenePatch(
                            position=0,
                            narration="Evidence suggests the effect may vary.",
                            visual_prompt="Accurate orbital animation",
                            image_motion="pan_right",
                            transition="crossfade",
                            direction_reason="结合事实边界建议重新编排",
                        )
                    ],
                    rationale="已吸收右侧事实边界建议",
                )
            if response_type is LLMAudit:
                return LLMAudit(status="warn", summary="仍需人工核实来源")
            raise AssertionError(response_type)

        monkeypatch.setattr(
            "api.routers.production.get_pixelle_video",
            AsyncMock(return_value=SimpleNamespace(llm=director_llm)),
        )
        client = TestClient(app)
        manual = client.patch(
            f"/api/production/jobs/{job['id']}/storyboard",
            json={
                "title": "A better space story",
                "director_note": "结合右侧审查建议，保持事实边界",
                "scenes": [
                    {
                        "narration": "Evidence suggests the effect may vary.",
                        "visual_prompt": "Accurate orbital animation",
                    }
                ],
            },
        )

        created_tasks: list[Task] = []

        def fake_create_task(task_type, request_params=None, idempotency_key=None):
            task = Task(
                task_id="redirect-task",
                task_type=task_type,
                request_params=request_params,
                idempotency_key=idempotency_key,
            )
            task_manager._tasks[task.task_id] = task
            created_tasks.append(task)
            return task

        monkeypatch.setattr(task_manager, "create_task", fake_create_task)
        monkeypatch.setattr(task_manager, "execute_task", AsyncMock())
        redirected = client.post(
            f"/api/production/jobs/{job['id']}/storyboard/redirect",
            json={
                "title": "A better space story",
                "director_note": "结合右侧审查建议，保持事实边界",
                "scenes": [
                    {
                        "narration": "Evidence suggests the effect may vary.",
                        "visual_prompt": "Accurate orbital animation",
                    }
                ],
            },
        )
        assert redirected.status_code == 202
        assert redirected.json()["task_id"] == "redirect-task"
        assert len(created_tasks) == 1
        assert created_tasks[0].task_type == TaskType.STORYBOARD_REDIRECTION
        assert created_tasks[0].idempotency_key
        assert created_tasks[0].request_params["title"] == "A better space story"

        with ProductionStore(str(tmp_path / "production.db")) as persistence:
            reserved = persistence.get_job(job["id"])
            assert reserved["storyboard_status"] == "redirecting"
            assert reserved["storyboard_task_id"] == "redirect-task"

        result = asyncio.run(execute_storyboard_redirection_task(created_tasks[0]))
        assert result["content_gate_status"] == "warn"
        assert "结合右侧审查建议，保持事实边界" in director_prompts[0]
        assert "右侧审查建议" in director_prompts[0]
        assert "content_llm_review" in director_prompts[0]

        with ProductionStore(str(tmp_path / "production.db")) as persistence:
            completed = persistence.get_job(job["id"])
            assert completed["title"] == "A better space story"
            assert completed["storyboard_status"] == "review_pending"
            assert completed["storyboard"]["director_rationale"] == "已吸收右侧事实边界建议"
        task_manager._tasks["redirect-task"].status = TaskStatus.COMPLETED

        approved = client.post(
            f"/api/production/jobs/{job['id']}/storyboard/approve",
            json={},
        )

        assert manual.status_code == 200
        assert manual.json()["content_gate_status"] == "warn"
        assert manual.json()["storyboard"]["scenes"][0]["transition"] == "none"
        assert manual.json()["storyboard"]["scenes"][0]["direction_reason"]
        assert manual.json()["storyboard"]["director_note"] == "结合右侧审查建议，保持事实边界"
        assert "结合右侧审查建议，保持事实边界" in director_prompts[0]
        assert "右侧审查建议" in director_prompts[0]
        assert approved.status_code == 200
        assert approved.json()["status"] == "planned"
        assert approved.json()["request"]["narrations"] == [
            "Evidence suggests the effect may vary."
        ]
        assert approved.json()["request"]["image_prompts"] == [
            "Accurate orbital animation"
        ]
        assert approved.json()["request"]["scene_directions"][0]["transition"] == "none"
    finally:
        task_manager._tasks.pop("redirect-task", None)
        api_config.production_config_path = original


def test_content_source_crud_and_async_poll(tmp_path: Path, monkeypatch):
    original = api_config.production_config_path
    api_config.production_config_path = str(_write_config(tmp_path))
    created_tasks: list[Task] = []

    def fake_create_task(task_type, request_params=None, idempotency_key=None):
        task = Task(
            task_id="source-task",
            task_type=task_type,
            request_params=request_params,
            idempotency_key=idempotency_key,
        )
        task_manager._tasks[task.task_id] = task
        created_tasks.append(task)
        return task

    execute = AsyncMock()
    monkeypatch.setattr(task_manager, "create_task", fake_create_task)
    monkeypatch.setattr(task_manager, "execute_task", execute)
    try:
        client = TestClient(app)
        created = client.post(
            "/api/production/sources",
            json={
                "channel_id": "science",
                "name": "NASA News",
                "kind": "rss",
                "url": "https://example.com/feed.xml",
                "poll_interval_minutes": 60,
            },
        )
        assert created.status_code == 201
        source_id = created.json()["id"]
        assert created.json()["next_poll_at"]

        updated = client.patch(
            f"/api/production/sources/{source_id}",
            json={"items_per_poll": 8, "candidates_per_item": 3},
        )
        assert updated.status_code == 200
        assert updated.json()["items_per_poll"] == 8

        poll = client.post(f"/api/production/sources/{source_id}/poll")
        assert poll.status_code == 202
        assert poll.json()["task_id"] == "source-task"
        assert created_tasks[0].task_type == TaskType.SOURCE_INGESTION
        execute.assert_awaited_once_with("source-task")

        listed = client.get("/api/production/sources?channel_id=science")
        assert listed.status_code == 200
        assert listed.json()["sources"][0]["state"] == "queued"
    finally:
        task_manager._tasks.pop("source-task", None)
        api_config.production_config_path = original
