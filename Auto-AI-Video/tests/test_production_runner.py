import sqlite3
from pathlib import Path

import httpx
import pytest
import yaml
from loguru import logger

from pixelle_video.production.models import (
    ChannelConfig,
    InventoryConfig,
    RunnerConfig,
    TopicConfig,
    load_runner_config,
)
from pixelle_video.production.planning import (
    LLMAudit,
    audit_storyboard_content,
    inspect_storyboard_content,
)
from pixelle_video.production.runner import ProductionRunner
from pixelle_video.production.store import ProductionStore
from pixelle_video.production.topics import score_topic


def make_config(tmp_path: Path, **inventory_overrides) -> RunnerConfig:
    planning = inventory_overrides.pop("planning", None)
    inventory = {
        "ready_target": 1,
        "daily_target": 1,
        "max_in_flight": 1,
        "refill_batch": 1,
        "max_task_retries": 1,
        "circuit_breaker_failures": 3,
        "failure_cooldown_seconds": 1800,
        **inventory_overrides,
    }
    channel = ChannelConfig(
        id="test_channel",
        name="Test Channel",
        topic=TopicConfig(strategy="seed", seeds=["topic one", "topic two"]),
        inventory=InventoryConfig(**inventory),
        planning=planning or {},
        video={
            "mode": "generate",
            "n_scenes": 3,
            "frame_template": "1080x1920/video_default.html",
            "media_workflow": "api/grok/grok-imagine-video",
        },
    )
    (tmp_path / "test_channel.yaml").write_text(
        yaml.safe_dump(channel.model_dump(), allow_unicode=True, sort_keys=False),
        encoding="utf-8",
    )
    return RunnerConfig(
        api_base_url="http://pixelle.test",
        database_path=str(tmp_path / "production.db"),
        channels_dir=str(tmp_path),
        channels=[channel],
        timezone="Asia/Shanghai",
    )


def test_runner_reconciles_inventory_without_duplicate_submission(tmp_path):
    tasks = {}
    submissions = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/health":
            return httpx.Response(200, json={"status": "healthy"})
        if request.url.path == "/api/video/generate/async":
            payload = __import__("json").loads(request.content)
            submissions.append(payload)
            assert request.headers["idempotency-key"].startswith("production:")
            task_id = f"task-{len(submissions)}"
            tasks[task_id] = "running"
            return httpx.Response(200, json={"task_id": task_id})
        if request.url.path.startswith("/api/tasks/"):
            task_id = request.url.path.rsplit("/", 1)[-1]
            status = tasks[task_id]
            result = (
                {"video_url": f"http://pixelle.test/{task_id}.mp4"}
                if status == "completed"
                else None
            )
            return httpx.Response(
                200, json={"task_id": task_id, "status": status, "result": result}
            )
        raise AssertionError(f"Unexpected request: {request.method} {request.url}")

    runner = ProductionRunner(make_config(tmp_path), transport=httpx.MockTransport(handler))
    try:
        first = runner.run_once()
        assert len(first["channels"]["test_channel"]["submitted"]) == 1
        assert submissions[0]["text"] == "topic one"

        second = runner.run_once()
        assert second["channels"]["test_channel"]["in_flight"] == 1
        assert len(submissions) == 1

        tasks["task-1"] = "completed"
        third = runner.run_once()
        assert third["channels"]["test_channel"]["ready"] == 1
        assert len(submissions) == 1

        ready_job = runner.store.list_jobs(channel_id="test_channel", statuses=("ready",))[0]
        runner.store.review_job(ready_job["id"], "approved")
        published = runner.publish("test_channel", 1)
        assert published[0]["status"] == "published"
        fourth = runner.run_once()
        assert len(fourth["channels"]["test_channel"]["submitted"]) == 1
        assert submissions[1]["text"] == "topic two"
    finally:
        runner.close()


def test_runner_recovers_next_cycle_after_health_read_timeout(tmp_path):
    health_calls = 0
    submissions = []

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal health_calls
        if request.url.path == "/health":
            health_calls += 1
            if health_calls == 1:
                raise httpx.ReadTimeout("temporary health timeout", request=request)
            assert request.extensions["timeout"]["read"] == 5.0
            return httpx.Response(200, json={"status": "healthy"})
        if request.url.path == "/api/video/generate/async":
            submissions.append(__import__("json").loads(request.content))
            return httpx.Response(200, json={"task_id": "recovered-task"})
        raise AssertionError(f"Unexpected request: {request.method} {request.url}")

    runner = ProductionRunner(make_config(tmp_path), transport=httpx.MockTransport(handler))
    try:
        assert runner.health_client is not runner.client

        timed_out_client = runner.health_client
        first = runner.run_once()
        assert first["status"] == "degraded"
        assert first["reason"] == "api-health-timeout"
        assert first["health"] == {
            "status": "timeout",
            "error_type": "ReadTimeout",
            "timeout_seconds": 5.0,
        }
        assert submissions == []
        assert runner.health_client is not timed_out_client

        second = runner.run_once()
        assert second["status"] == "ok"
        assert len(submissions) == 1
    finally:
        runner.close()


def test_runner_degrades_cleanly_when_api_is_unreachable(tmp_path):
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/health":
            raise httpx.ConnectError("connection refused", request=request)
        raise AssertionError(f"Unexpected request: {request.method} {request.url}")

    runner = ProductionRunner(make_config(tmp_path), transport=httpx.MockTransport(handler))
    try:
        result = runner.run_once()
        assert result["status"] == "degraded"
        assert result["reason"] == "api-health-unreachable"
        assert result["health"]["status"] == "unreachable"
        assert result["health"]["error_type"] == "ConnectError"
    finally:
        runner.close()


def test_quality_repair_skips_revision_without_actionable_checks(tmp_path):
    requests = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        raise AssertionError(f"Unexpected request: {request.method} {request.url}")

    runner = ProductionRunner(
        make_config(tmp_path), transport=httpx.MockTransport(handler)
    )
    try:
        runner._request_quality_repair(
            {
                "id": "manual-only-revision",
                "quality_checks": [
                    {
                        "check_name": "content_prohibited_claims",
                        "status": "fail",
                        "detail": {},
                    }
                ],
                "scenes": [{"position": 0, "locked": False}],
            }
        )
        assert requests == []
    finally:
        runner.close()


def test_quality_repair_treats_only_expected_race_conflict_as_noop(tmp_path):
    detail = "No repairable failed technical quality checks"

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/api/projects/revisions/repairable/auto-repair"
        return httpx.Response(409, json={"detail": detail})

    runner = ProductionRunner(
        make_config(tmp_path), transport=httpx.MockTransport(handler)
    )
    warnings = []
    sink_id = logger.add(warnings.append, level="WARNING", format="{message}")
    try:
        runner._request_quality_repair(
            {
                "id": "repairable",
                "quality_checks": [
                    {"check_name": "audio_stream", "status": "fail", "detail": {}}
                ],
                "scenes": [{"position": 0, "locked": False}],
            }
        )
        assert warnings == []

        detail = "revision is not active"
        runner._request_quality_repair(
            {
                "id": "repairable",
                "quality_checks": [
                    {"check_name": "audio_stream", "status": "fail", "detail": {}}
                ],
                "scenes": [{"position": 0, "locked": False}],
            }
        )
        assert len(warnings) == 1
        assert "revision is not active" in warnings[0]
    finally:
        logger.remove(sink_id)
        runner.close()


def test_runner_freezes_channel_owned_production_settings(tmp_path):
    submissions = []
    config = make_config(tmp_path)
    store = ProductionStore(config.database_path)
    video = {
        **config.channels[0].video,
        "n_scenes": 6,
        "limit_scenes": True,
        "video_fps": 24,
        "voice_id": "zh-CN-XiaoxiaoNeural",
    }
    channel = config.channels[0].model_copy(
        update={"video": video}
    )
    config.channels = [channel]
    (tmp_path / "test_channel.yaml").write_text(
        yaml.safe_dump(channel.model_dump(), allow_unicode=True, sort_keys=False),
        encoding="utf-8",
    )

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/health":
            return httpx.Response(200, json={"status": "healthy"})
        if request.url.path == "/api/video/generate/async":
            submissions.append(__import__("json").loads(request.content))
            return httpx.Response(200, json={"task_id": "preset-task"})
        raise AssertionError(f"Unexpected request: {request.method} {request.url}")

    runner = ProductionRunner(config, store=store, transport=httpx.MockTransport(handler))
    try:
        runner.run_once()
        payload = submissions[0]
        assert payload["n_scenes"] == 6
        assert payload["video_fps"] == 24
        assert payload["voice_id"] == "zh-CN-XiaoxiaoNeural"
        assert "brand_kit" not in payload["_production"]
        assert "recipe" not in payload["_production"]
        frozen = store.list_jobs(channel_id="test_channel")[0]["request"]
        assert frozen["n_scenes"] == 6
        assert frozen["video_fps"] == 24
    finally:
        runner.close()


def test_runner_consumes_pinned_topic_before_seed(tmp_path):
    submissions = []
    config = make_config(tmp_path)
    store = ProductionStore(config.database_path)
    channel = config.channels[0]
    scoring = score_topic(channel, "Pinned title", "A pinned production topic", [])
    candidate = store.create_topic_candidate(
        channel.id,
        "Pinned title",
        "A pinned production topic",
        {**scoring, "source_type": "manual", "status": "pinned"},
    )

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/health":
            return httpx.Response(200, json={"status": "healthy"})
        if request.url.path == "/api/video/generate/async":
            submissions.append(__import__("json").loads(request.content))
            return httpx.Response(200, json={"task_id": "topic-task"})
        raise AssertionError(f"Unexpected request: {request.method} {request.url}")

    runner = ProductionRunner(config, store=store, transport=httpx.MockTransport(handler))
    try:
        runner.run_once()
        assert submissions[0]["text"] == "A pinned production topic"
        assert submissions[0]["_production"]["topic_candidate"]["id"] == candidate["id"]
        consumed = store.get_topic_candidate(candidate["id"])
        assert consumed["status"] == "consumed"
        assert consumed["consumed_job_id"]
    finally:
        runner.close()


def test_semantic_vector_detects_same_concept_with_different_wording(tmp_path):
    channel = make_config(tmp_path).channels[0]
    terms = ["潮汐锁定", "月球自转", "公转周期", "地月系统", "同步旋转"]
    first = score_topic(
        channel,
        "月球为何总用同一面朝向地球",
        "解释月球自转周期与绕地公转周期相同造成的视觉结果。",
        [],
        terms,
    )
    second = score_topic(
        channel,
        "我们为什么看不到月亮背面",
        "从同步旋转讲清背面并非永远黑暗，也不是卫星停止转动。",
        [
            {
                "id": "moon-1",
                "topic": "解释月球自转周期与绕地公转周期相同造成的视觉结果。",
                "semantic_terms": terms,
                "semantic_vector": first["semantic_vector"],
            }
        ],
        terms,
    )
    assert second["scores"]["semantic_similarity"] >= 82
    assert second["duplicate_of"] == "moon-1"


def test_runner_queues_due_sources_without_waiting_for_collection(tmp_path):
    config = make_config(tmp_path, ready_target=0, daily_target=0)
    store = ProductionStore(config.database_path)
    source = store.create_content_source(
        "test_channel", "Example feed", "rss", "https://example.com/feed.xml"
    )
    calls = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request.url.path)
        if request.url.path == "/health":
            return httpx.Response(200, json={"status": "healthy"})
        if request.url.path == "/api/production/sources/poll-due":
            store.queue_content_source(source["id"], "source-task")
            return httpx.Response(
                202,
                json={
                    "count": 1,
                    "tasks": [{"source_id": source["id"], "task_id": "source-task"}],
                },
            )
        raise AssertionError(f"Unexpected request: {request.method} {request.url}")

    runner = ProductionRunner(config, store=store, transport=httpx.MockTransport(handler))
    try:
        first = runner.run_once()
        second = runner.run_once()
        assert first["sources_queued"] == 1
        assert second["sources_queued"] == 0
        assert calls.count("/api/production/sources/poll-due") == 1
    finally:
        runner.close()


def test_runner_waits_for_storyboard_approval_before_media_submission(tmp_path):
    tasks = {}
    planning_submissions = []
    video_submissions = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/health":
            return httpx.Response(200, json={"status": "healthy"})
        if request.url.path == "/api/production/storyboards/plan":
            planning_submissions.append(__import__("json").loads(request.content))
            tasks["plan-1"] = "running"
            return httpx.Response(202, json={"task_id": "plan-1"})
        if request.url.path == "/api/video/generate/async":
            video_submissions.append(__import__("json").loads(request.content))
            return httpx.Response(202, json={"task_id": "video-1"})
        if request.url.path == "/api/tasks/plan-1":
            result = None
            if tasks["plan-1"] == "completed":
                result = {
                    "title": "Approved plan",
                    "content_policy": "science",
                    "content_gate_status": "pass",
                    "content_checks": [{"name": "content_fact", "status": "pass", "detail": {}}],
                    "scenes": [
                        {
                            "position": 0,
                            "narration": "A verified explanation",
                            "visual_prompt": "A precise science animation",
                        }
                    ],
                }
            return httpx.Response(
                200,
                json={"task_id": "plan-1", "status": tasks["plan-1"], "result": result},
            )
        if request.url.path == "/api/tasks/video-1":
            return httpx.Response(200, json={"task_id": "video-1", "status": "running"})
        raise AssertionError(f"Unexpected request: {request.method} {request.url}")

    config = make_config(
        tmp_path,
        planning={
            "enabled": True,
            "approval": "manual",
            "content_policy": "science",
            "llm_review": True,
        },
    )
    runner = ProductionRunner(config, transport=httpx.MockTransport(handler))
    try:
        runner.run_once()
        assert len(planning_submissions) == 1
        assert video_submissions == []

        tasks["plan-1"] = "completed"
        runner.run_once()
        awaiting = runner.store.list_jobs(statuses=("awaiting_storyboard",))[0]
        assert awaiting["storyboard"]["title"] == "Approved plan"
        assert video_submissions == []

        runner.store.approve_storyboard(awaiting["id"])
        runner.run_once()
        assert video_submissions[0]["narrations"] == ["A verified explanation"]
        assert video_submissions[0]["image_prompts"] == ["A precise science animation"]
    finally:
        runner.close()


def test_psychology_content_gate_rejects_diagnostic_and_fear_language():
    checks = inspect_storyboard_content(
        "焦虑自测",
        [
            {
                "position": 0,
                "narration": "你就是焦虑症患者，再不改变就会越来越严重。",
                "visual_prompt": "A worried stick figure",
            }
        ],
        "psychology",
    )

    psychology_check = next(
        check for check in checks if check["name"] == "content_psychology_language"
    )
    assert psychology_check["status"] == "fail"
    assert psychology_check["detail"]["matches"]


@pytest.mark.asyncio
async def test_llm_content_review_uses_active_text_route_without_reasoning():
    calls = []

    class SettingsTextModel:
        def route_info(self):
            return {
                "channel_id": "model-channel-2",
                "channel_name": "CPA",
                "model": "deepseek-v4-flash",
                "reasoning_effort": "high",
            }

        async def __call__(self, **kwargs):
            calls.append(kwargs)
            return LLMAudit(status="pass", summary="事实边界清晰", issues=[])

    checks = await audit_storyboard_content(
        SettingsTextModel(),
        "为什么方便面是卷的？",
        [{"position": 0, "narration": "卷曲面饼能提高空间利用率。", "visual_prompt": "面饼剖面"}],
        "science",
    )

    review = next(check for check in checks if check["name"] == "content_llm_review")
    assert calls[0]["reasoning_effort"] == "none"
    assert calls[0]["max_tokens"] == 3000
    assert review["detail"]["model_route"]["model"] == "deepseek-v4-flash"


def test_runner_circuit_breaker_pauses_after_consecutive_failures(tmp_path):
    submissions = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal submissions
        if request.url.path == "/health":
            return httpx.Response(200, json={"status": "healthy"})
        if request.url.path == "/api/video/generate/async":
            submissions += 1
            return httpx.Response(200, json={"task_id": f"new-{submissions}"})
        raise AssertionError(f"Unexpected request: {request.method} {request.url}")

    config = make_config(tmp_path, ready_target=5, daily_target=5, max_in_flight=5)
    store = ProductionStore(config.database_path)
    for number in range(3):
        job = store.create_job(
            "test_channel",
            f"failed topic {number}",
            "failed",
            {"text": "failed"},
        )
        store.update_job(job["id"], status="failed", error="invalid API key")

    runner = ProductionRunner(config, store=store, transport=httpx.MockTransport(handler))
    try:
        result = runner.run_once()["channels"]["test_channel"]
        assert result["status"] == "paused"
        assert "consecutive failures" in result["reason"]
        assert submissions == 0
    finally:
        runner.close()


def test_manual_channel_pause_prevents_refill(tmp_path):
    submissions = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal submissions
        if request.url.path == "/health":
            return httpx.Response(200, json={"status": "healthy"})
        if request.url.path == "/api/video/generate/async":
            submissions += 1
            return httpx.Response(200, json={"task_id": f"task-{submissions}"})
        raise AssertionError(f"Unexpected request: {request.method} {request.url}")

    config = make_config(tmp_path)
    store = ProductionStore(config.database_path)
    store.set_channel_paused("test_channel", True)
    runner = ProductionRunner(config, store=store, transport=httpx.MockTransport(handler))
    try:
        result = runner.run_once()["channels"]["test_channel"]
        assert result["status"] == "paused"
        assert result["reason"] == "manually paused"
        assert submissions == 0
    finally:
        runner.close()


def test_sqlite_lease_allows_only_one_runner(tmp_path):
    path = str(tmp_path / "production.db")
    first = ProductionStore(path)
    second = ProductionStore(path)
    try:
        assert first.acquire_lease("runner", "one", 60) is True
        assert second.acquire_lease("runner", "two", 60) is False
        first.release_lease("runner", "one")
        assert second.acquire_lease("runner", "two", 60) is True
    finally:
        first.close()
        second.close()


def test_additive_migration_tolerates_a_concurrent_duplicate_column():
    class RacingConnection:
        def execute(self, _statement):
            raise sqlite3.OperationalError("duplicate column name: semantic_vector_json")

    store = object.__new__(ProductionStore)
    store._connection = RacingConnection()

    store._apply_column_migrations(
        set(),
        {"semantic_vector_json": "ALTER TABLE ignored"},
    )


def test_additive_migration_still_raises_unrelated_sqlite_errors():
    class BrokenConnection:
        def execute(self, _statement):
            raise sqlite3.OperationalError("database disk image is malformed")

    store = object.__new__(ProductionStore)
    store._connection = BrokenConnection()

    with pytest.raises(sqlite3.OperationalError, match="malformed"):
        store._apply_column_migrations(set(), {"new_column": "ALTER TABLE ignored"})


def test_example_channel_configuration_loads():
    config = load_runner_config("production/runner.yaml")
    channels = {channel.id: channel for channel in config.channels}
    assert {"stickman_psychology", "science_explainer", "morning_radio"}.issubset(channels)
    assert len(channels) == len(config.channels)
    assert all(isinstance(channel.enabled, bool) for channel in config.channels)
    assert channels["science_explainer"].planning.content_policy
    assert channels["morning_radio"].video["media_workflow"]
    assert channels["stickman_psychology"].inventory.daily_target >= 0
    assert all(isinstance(channel.quality.auto_repair, bool) for channel in config.channels)


def test_compose_runner_uses_persistent_state_and_api_health_dependency():
    compose = yaml.safe_load(Path("docker-compose.yml").read_text(encoding="utf-8"))
    assert "web" not in compose["services"]
    studio = compose["services"]["studio"]
    assert studio["build"]["context"] == "./studio"
    assert "3000:3000" in studio["ports"]
    assert "PIXELLE_API_URL=http://api:8000" in studio["environment"]
    runner = compose["services"]["runner"]
    assert runner["restart"] == "unless-stopped"
    assert runner["depends_on"]["api"]["condition"] == "service_healthy"
    assert "./data:/app/data" in runner["volumes"]
    assert "./output:/app/output" in runner["volumes"]
    assert "./production:/app/production:ro" in runner["volumes"]
    assert "PIXELLE_PRODUCTION_API_BASE_URL=http://api:8000" in runner["environment"]

    dockerfile = Path("Dockerfile").read_text(encoding="utf-8")
    assert "COPY scripts ./scripts" in dockerfile
    assert "COPY production ./production" in dockerfile


def test_store_blocks_same_topic_with_punctuation_variants(tmp_path: Path):
    with ProductionStore(str(tmp_path / "production.db")) as store:
        first = store.create_job(
            "science",
            "为什么天空是蓝色？",
            "天空为何呈蓝色",
            {"text": "为什么天空是蓝色？"},
        )

        with pytest.raises(ValueError, match=first["id"]):
            store.create_job(
                "science",
                "为什么天空是蓝色",
                "另一个标题",
                {"text": "为什么天空是蓝色"},
            )

        store.update_job(first["id"], status="cancelled")
        replacement = store.create_job(
            "science",
            "为什么天空是蓝色",
            "取消后重新创建",
            {"text": "为什么天空是蓝色"},
        )
        assert replacement["id"] != first["id"]
