from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi.testclient import TestClient

from api.app import app
from api.config import api_config
from api.routers.production import _channel_path_fingerprint, _write_channel
from pixelle_video.production import (
    ProducerAction,
    ProducerDraft,
    ProductionStore,
    build_producer_snapshot,
    load_runner_config,
)


def _write_config(tmp_path: Path, *, image_workflow: bool = False) -> Path:
    channels = tmp_path / "channels"
    channels.mkdir()
    frame_template = "image_default.html" if image_workflow else "video_default.html"
    media_model = "grok-imagine-image-quality" if image_workflow else "grok-imagine-video"
    (channels / "science.yaml").write_text(
        f"""id: science
name: Science
topic:
  strategy: llm
  seeds: [space]
  prompt: Explain daily science
inventory:
  ready_target: 2
  daily_target: 1
  max_in_flight: 1
planning:
  enabled: true
  content_policy: science
video:
  frame_template: 1080x1920/{frame_template}
  media_workflow: api/grok/{media_model}
""",
        encoding="utf-8",
    )
    config = tmp_path / "runner.yaml"
    config.write_text(
        f"database_path: {tmp_path / 'production.db'}\nchannels_dir: {channels}\n",
        encoding="utf-8",
    )
    return config


def test_producer_read_only_answer_is_persisted(tmp_path: Path, monkeypatch):
    original = api_config.production_config_path
    api_config.production_config_path = str(_write_config(tmp_path))
    llm = AsyncMock(
        return_value=ProducerDraft(
            reply="当前没有失败任务，Science 频道保持运行。",
            observations=["失败任务 0 条", "频道未暂停"],
        )
    )
    monkeypatch.setattr(
        "api.routers.production.get_pixelle_video",
        AsyncMock(return_value=SimpleNamespace(llm=llm)),
    )
    try:
        client = TestClient(app)
        response = client.post(
            "/api/production/assistant/messages",
            json={"message": "检查失败任务并告诉我原因"},
        )
        assert response.status_code == 201
        assert response.json()["plan"] is None
        thread_id = response.json()["thread_id"]
        thread = client.get(f"/api/production/assistant/threads/{thread_id}")
        assert thread.status_code == 200
        assert [item["role"] for item in thread.json()["messages"]] == [
            "user",
            "assistant",
        ]
        assert thread.json()["messages"][1]["payload"]["observations"]
        prompt = llm.await_args.kwargs["prompt"]
        assert "set_channel_template" in prompt
        assert "set_channel_whiteboard" in prompt
        assert '"legal_whiteboard_templates"' in prompt
        assert "update_scene_subtitle" in prompt
        assert "跟随当前版本默认" in prompt
        assert '"legal_subtitle_effects"' in prompt
    finally:
        api_config.production_config_path = original


def test_producer_write_plan_requires_approval_and_executes_once(tmp_path: Path, monkeypatch):
    original = api_config.production_config_path
    api_config.production_config_path = str(_write_config(tmp_path))
    llm = AsyncMock(
        return_value=ProducerDraft(
            reply="我建议暂停 Science 频道，等待你批准。",
            observations=["频道当前正在运行"],
            actions=[
                ProducerAction(
                    action="pause_channel",
                    target_id="science",
                    rationale="用户要求暂停补货",
                    impact="Runner 将不再为该频道创建新任务",
                    reversible=True,
                )
            ],
        )
    )
    monkeypatch.setattr(
        "api.routers.production.get_pixelle_video",
        AsyncMock(return_value=SimpleNamespace(llm=llm)),
    )
    try:
        client = TestClient(app)
        drafted = client.post(
            "/api/production/assistant/messages",
            json={"message": "暂停 Science 频道"},
        )
        assert drafted.status_code == 201
        plan = drafted.json()["plan"]
        assert plan["status"] == "pending"
        with ProductionStore(str(tmp_path / "production.db")) as store:
            assert store.is_channel_paused("science") is False

        executed = client.post(
            f"/api/production/assistant/plans/{plan['id']}/decision",
            json={"approved": True, "note": "确认暂停"},
        )
        assert executed.status_code == 200
        assert executed.json()["status"] == "completed", executed.json()
        with ProductionStore(str(tmp_path / "production.db")) as store:
            assert store.is_channel_paused("science") is True

        repeated = client.post(
            f"/api/production/assistant/plans/{plan['id']}/decision",
            json={"approved": True},
        )
        assert repeated.status_code == 409
    finally:
        api_config.production_config_path = original


def test_producer_rejects_hallucinated_targets_without_plan(tmp_path: Path, monkeypatch):
    original = api_config.production_config_path
    api_config.production_config_path = str(_write_config(tmp_path))
    llm = AsyncMock(
        return_value=ProducerDraft(
            reply="建议暂停未知频道。",
            actions=[
                ProducerAction(
                    action="pause_channel",
                    target_id="invented-channel",
                    rationale="测试",
                    impact="测试",
                )
            ],
        )
    )
    monkeypatch.setattr(
        "api.routers.production.get_pixelle_video",
        AsyncMock(return_value=SimpleNamespace(llm=llm)),
    )
    try:
        client = TestClient(app)
        response = client.post(
            "/api/production/assistant/messages",
            json={"message": "暂停不存在的频道"},
        )
        assert response.status_code == 201
        assert response.json()["plan"] is None
        assert "安全策略拦截" in response.json()["observations"][-1]
    finally:
        api_config.production_config_path = original


def test_producer_atomically_creates_a_complete_topic_specific_channel(
    tmp_path: Path,
    monkeypatch,
):
    original = api_config.production_config_path
    config_path = _write_config(tmp_path)
    api_config.production_config_path = str(config_path)
    topic_prompt = "生活小技巧，以漫画形式展示，每期讲清一个实用技巧"
    llm = AsyncMock(
        return_value=ProducerDraft(
            reply="已形成完整频道创建方案，等待批准。",
            actions=[
                ProducerAction(
                    action="create_channel",
                    target_id="life_tips_comic",
                    params={
                        "name": "生活小技巧漫画",
                        "enabled": True,
                        "topic_prompt": topic_prompt,
                        "daily_target": 3,
                        "visual_memory": {
                            "characters": ["围裙生活达人"],
                            "palette": ["暖黄", "炭黑"],
                            "composition": ["主体居中"],
                            "forbidden_elements": [],
                            "exemplars": [],
                        },
                        "voice_preset": {
                            "voice_id": "zh-CN-XiaoxiaoNeural",
                            "emotion": "warm",
                        },
                    },
                    rationale="创建生活技巧频道",
                    impact="创建一个新频道",
                ),
                ProducerAction(
                    action="set_channel_whiteboard",
                    target_id="life_tips_comic",
                    params={
                        "template_id": "comic-ink-explainer",
                        "template_version": 1,
                        "hand_enabled": True,
                    },
                    rationale="漫画内容适合墨线白板",
                    impact="切换为漫画白板视觉",
                ),
                ProducerAction(
                    action="set_channel_subtitle_effect",
                    target_id="life_tips_comic",
                    params={"subtitle_effect": "typewriter"},
                    rationale="强化讲解节奏",
                    impact="使用打字机字幕",
                ),
            ],
        )
    )
    monkeypatch.setattr(
        "api.routers.production.get_pixelle_video",
        AsyncMock(return_value=SimpleNamespace(llm=llm)),
    )
    try:
        client = TestClient(app)
        drafted = client.post(
            "/api/production/assistant/messages",
            json={"message": "创建生活小技巧漫画频道"},
        )
        assert drafted.status_code == 201
        assert drafted.json()["observations"] == []
        plan = drafted.json()["plan"]
        assert [action["action"] for action in plan["actions"]] == ["create_channel"]
        assert plan["actions"][0]["params"]["production_mode"] == "whiteboard_animation"
        assert plan["actions"][0]["params"]["subtitle_effect"] == "typewriter"

        executed = client.post(
            f"/api/production/assistant/plans/{plan['id']}/decision",
            json={"approved": True},
        )
        assert executed.status_code == 200
        assert executed.json()["status"] == "completed", executed.json()
        created = next(
            channel
            for channel in load_runner_config(config_path).channels
            if channel.id == "life_tips_comic"
        )
        assert created.video["production_mode"] == "whiteboard_animation"
        assert created.video["subtitle_effect"] == "typewriter"
        assert created.video["whiteboard"]["template_id"] == "comic-ink-explainer"
        assert created.topic.prompt == topic_prompt
        assert len(created.topic.seeds) >= 3
        assert all(topic_prompt in seed for seed in created.topic.seeds)
        assert "space" not in created.topic.seeds
        assert "生活小技巧" in created.video["prompt_prefix"]
        assert "山水" not in created.video["prompt_prefix"]
        assert created.visual_memory.characters == ["围裙生活达人"]
        assert created.video["voice_preset"]["voice_id"] == "zh-CN-XiaoxiaoNeural"
        assert created.video["voice_id"] == "zh-CN-XiaoxiaoNeural"
    finally:
        api_config.production_config_path = original


def test_producer_storyboard_approval_is_gated_and_uses_real_job(tmp_path: Path, monkeypatch):
    original = api_config.production_config_path
    config_path = _write_config(tmp_path)
    api_config.production_config_path = str(config_path)
    with ProductionStore(str(tmp_path / "production.db")) as store:
        job = store.create_job("science", "Why the sky is blue", "Blue sky", {})
        job = store.update_job(
            job["id"],
            status="awaiting_storyboard",
            storyboard_json={
                "title": "Blue sky",
                "scenes": [{"narration": "Rayleigh scattering", "visual_prompt": "sky"}],
            },
            storyboard_status="review_pending",
            content_gate_status="pass",
        )
    llm = AsyncMock(
        return_value=ProducerDraft(
            reply="分镜通过内容门禁，等待批准。",
            actions=[
                ProducerAction(
                    action="approve_storyboard",
                    target_id=job["id"],
                    rationale="内容门禁已通过",
                    impact="分镜将冻结为待生成请求",
                    reversible=True,
                )
            ],
        )
    )
    monkeypatch.setattr(
        "api.routers.production.get_pixelle_video",
        AsyncMock(return_value=SimpleNamespace(llm=llm)),
    )
    try:
        client = TestClient(app)
        drafted = client.post(
            "/api/production/assistant/messages",
            json={"message": "批准 Blue sky 的分镜"},
        )
        assert drafted.status_code == 201
        plan = drafted.json()["plan"]
        with ProductionStore(str(tmp_path / "production.db")) as store:
            assert store.get_job(job["id"])["status"] == "awaiting_storyboard"

        executed = client.post(
            f"/api/production/assistant/plans/{plan['id']}/decision",
            json={"approved": True},
        )
        assert executed.status_code == 200
        assert executed.json()["status"] == "completed"
        with ProductionStore(str(tmp_path / "production.db")) as store:
            assert store.get_job(job["id"])["status"] == "planned"
    finally:
        api_config.production_config_path = original


def test_producer_snapshot_exposes_attention_targets_without_guessing_ids(tmp_path: Path):
    config = load_runner_config(_write_config(tmp_path))
    with ProductionStore(config.database_path) as store:
        job = store.create_job("science", "A topic", "A title", {})
        store.update_job(
            job["id"],
            status="awaiting_storyboard",
            storyboard_json={"title": "A title", "scenes": [{"narration": "n"}]},
            storyboard_status="review_pending",
            content_gate_status="warn",
        )
        snapshot = build_producer_snapshot(store, config.channels, config.timezone)
    assert job["id"] in snapshot
    assert '"awaiting_storyboards"' in snapshot
    assert '"projects"' in snapshot
    assert '"legal_templates"' in snapshot
    assert '"knowledge-card"' in snapshot
    assert '"legal_subtitle_effects"' in snapshot


def _create_editable_scene(store: ProductionStore, tmp_path: Path) -> dict:
    frames = tmp_path / "output" / "assistant-task" / "frames"
    frames.mkdir(parents=True)
    paths = {
        "audio_path": frames / "01_audio.mp3",
        "image_path": frames / "01_image.png",
        "video_segment_path": frames / "01_segment.mp4",
    }
    final = frames.parent / "final.mp4"
    for path in [*paths.values(), final]:
        path.write_bytes(b"test-media")
    job = store.create_job("science", "subtitle topic", "Subtitle title", {})
    store.update_job(job["id"], status="ready", api_task_id="assistant-task")
    project = store.import_project_revision(
        job["id"],
        {
            "title": "Subtitle title",
            "config": {"subtitle_effect": "static"},
            "frames": [
                {
                    "narration": "光线进入大气后发生散射",
                    "image_prompt": "blue sky",
                    "duration": 5,
                    "image_motion": "none",
                    "transition": "none",
                    "transition_duration": 0,
                    **{key: str(value) for key, value in paths.items()},
                }
            ],
            "final_video_path": str(final),
            "total_duration": 5,
        },
        {},
        [{"name": "video_codec", "status": "pass", "detail": {}}],
    )
    return store.create_revision(project["id"], "AI producer edit")["scenes"][0]


def test_producer_can_approve_template_variables_and_channel_subtitle(tmp_path: Path, monkeypatch):
    original = api_config.production_config_path
    config_path = _write_config(tmp_path, image_workflow=True)
    api_config.production_config_path = str(config_path)
    llm = AsyncMock(
        return_value=ProducerDraft(
            reply="建议切换模板并设置默认字幕，等待批准。",
            actions=[
                ProducerAction(
                    action="set_channel_template",
                    target_id="science",
                    params={
                        "template_id": "knowledge-card",
                        "template_version": 1,
                        "variables": {
                            "brand_label": "天空一分钟",
                            "card_opacity": 0.8,
                        },
                    },
                    rationale="让知识频道形成统一栏目风格",
                    impact="频道后续任务将使用知识卡模板和新栏目名",
                ),
                ProducerAction(
                    action="set_channel_subtitle_effect",
                    target_id="science",
                    params={"subtitle_effect": "typewriter"},
                    rationale="匹配解释型内容节奏",
                    impact="频道后续镜头默认使用打字机字幕",
                ),
                ProducerAction(
                    action="update_channel",
                    target_id="science",
                    params={"inventory": {"ready_target": 7}},
                    rationale="增加待发布库存",
                    impact="频道库存水位将调整为 7",
                ),
            ],
        )
    )
    monkeypatch.setattr(
        "api.routers.production.get_pixelle_video",
        AsyncMock(return_value=SimpleNamespace(llm=llm)),
    )
    try:
        client = TestClient(app)
        drafted = client.post(
            "/api/production/assistant/messages",
            json={"message": "设置知识卡模板和打字机字幕"},
        )
        assert drafted.status_code == 201
        plan = drafted.json()["plan"]
        assert [item["action"] for item in plan["actions"]] == [
            "set_channel_template",
            "set_channel_subtitle_effect",
            "update_channel",
        ]

        executed = client.post(
            f"/api/production/assistant/plans/{plan['id']}/decision",
            json={"approved": True},
        )
        assert executed.status_code == 200
        assert executed.json()["status"] == "completed", executed.json()
        channel = load_runner_config(config_path).channels[0]
        assert channel.video["hyperframes"]["template_id"] == "knowledge-card"
        assert channel.video["hyperframes"]["variables"]["brand_label"] == "天空一分钟"
        assert channel.video["template_params"]["card_opacity"] == 0.8
        assert channel.video["subtitle_effect"] == "typewriter"
        assert channel.inventory.ready_target == 7
    finally:
        api_config.production_config_path = original


def test_producer_can_switch_channel_to_independent_whiteboard_mode(
    tmp_path: Path,
    monkeypatch,
):
    original = api_config.production_config_path
    config_path = _write_config(tmp_path, image_workflow=True)
    api_config.production_config_path = str(config_path)
    llm = AsyncMock(
        return_value=ProducerDraft(
            reply="建议切换为手绘白板动画，等待批准。",
            actions=[
                ProducerAction(
                    action="set_channel_whiteboard",
                    target_id="science",
                    params={
                        "template_id": "comic-ink-explainer",
                        "template_version": 1,
                        "hand_enabled": False,
                        "fallback_policy": "region",
                    },
                    rationale="机制讲解适合漫画墨线视觉",
                    impact="后续任务将使用独立白板渲染，不再调用 HTML 或 HyperFrames",
                )
            ],
        )
    )
    monkeypatch.setattr(
        "api.routers.production.get_pixelle_video",
        AsyncMock(return_value=SimpleNamespace(llm=llm)),
    )
    try:
        client = TestClient(app)
        drafted = client.post(
            "/api/production/assistant/messages",
            json={"message": "把 Science 切成漫画墨线白板动画"},
        )
        assert drafted.status_code == 201
        plan = drafted.json()["plan"]
        assert plan["actions"][0]["action"] == "set_channel_whiteboard"

        executed = client.post(
            f"/api/production/assistant/plans/{plan['id']}/decision",
            json={"approved": True},
        )
        assert executed.status_code == 200
        assert executed.json()["status"] == "completed", executed.json()
        channel = load_runner_config(config_path).channels[0]
        assert channel.video["production_mode"] == "whiteboard_animation"
        assert channel.video["render_engine"] == "whiteboard_cv"
        assert channel.video["renderer_version"] == "whiteboard-cv-v1"
        assert channel.video["frame_template"] is None
        assert channel.video["whiteboard"]["template_id"] == "comic-ink-explainer"
        assert channel.video["whiteboard"]["hand_enabled"] is False
    finally:
        api_config.production_config_path = original


def test_producer_scene_subtitle_and_direction_respect_draft_lock_gate(
    tmp_path: Path,
    monkeypatch,
):
    original = api_config.production_config_path
    config_path = _write_config(tmp_path, image_workflow=True)
    api_config.production_config_path = str(config_path)
    with ProductionStore(str(tmp_path / "production.db")) as store:
        scene = _create_editable_scene(store, tmp_path)
        config = load_runner_config(config_path)
        snapshot = build_producer_snapshot(store, config.channels, config.timezone)
        assert '"subtitle_effect_default": "static"' in snapshot
    llm = AsyncMock(
        return_value=ProducerDraft(
            reply="建议调整逐镜字幕与运镜，等待批准。",
            actions=[
                ProducerAction(
                    action="update_scene_subtitle",
                    target_id=scene["id"],
                    params={
                        "subtitle_effect": "word_pop",
                        "subtitle_keywords": ["光线", "LIGHT", "light", "散射"],
                        "subtitle_start_offset": 0.2,
                        "subtitle_end_offset": 0.3,
                    },
                    rationale="突出关键科学概念",
                    impact="只修改这个草稿镜头的字幕表现和显示区间",
                ),
                ProducerAction(
                    action="update_scene_direction",
                    target_id=scene["id"],
                    params={
                        "image_motion": "push_in",
                        "transition": "none",
                        "transition_duration": 0,
                    },
                    rationale="首镜使用缓慢推进建立注意力",
                    impact="只修改这个草稿镜头的运镜；首镜仍保持直切",
                ),
            ],
        )
    )
    monkeypatch.setattr(
        "api.routers.production.get_pixelle_video",
        AsyncMock(return_value=SimpleNamespace(llm=llm)),
    )
    try:
        client = TestClient(app)
        drafted = client.post(
            "/api/production/assistant/messages",
            json={"message": "优化这个草稿镜头的字幕与运镜"},
        )
        plan = drafted.json()["plan"]
        assert all(
            action["preconditions"]["scene_updated_at"] == scene["updated_at"]
            for action in plan["actions"]
        )
        executed = client.post(
            f"/api/production/assistant/plans/{plan['id']}/decision",
            json={"approved": True},
        )
        assert executed.json()["status"] == "completed"
        with ProductionStore(str(tmp_path / "production.db")) as store:
            updated = store.get_scene_context(scene["id"])["scene"]
            assert updated["subtitle_effect"] == "word_pop"
            assert updated["subtitle_keywords"] == ["光线", "LIGHT", "散射"]
            assert updated["subtitle_start_offset"] == 0.2
            assert updated["subtitle_end_offset"] == 0.3
            assert updated["image_motion"] == "push_in"
            project = store.get_scene_context(scene["id"])["project"]
            active_scene_id = store.get_revision(project["current_revision_id"])["scenes"][0][
                "id"
            ]

        stale_drafted = client.post(
            "/api/production/assistant/messages",
            json={"message": "再调整一次这个草稿镜头"},
        )
        stale_plan = stale_drafted.json()["plan"]
        assert stale_plan["status"] == "pending"
        with ProductionStore(str(tmp_path / "production.db")) as store:
            store.update_scene(scene["id"], locked=True)

        stale_execution = client.post(
            f"/api/production/assistant/plans/{stale_plan['id']}/decision",
            json={"approved": True},
        )
        assert stale_execution.json()["status"] == "failed"
        assert "scene is locked" in stale_execution.json()["error"]

        blocked = client.post(
            "/api/production/assistant/messages",
            json={"message": "再改一次已锁定镜头"},
        )
        assert blocked.status_code == 201
        assert blocked.json()["plan"] is None
        assert "scene is locked" in blocked.json()["observations"][-1]

        llm.return_value = ProducerDraft(
            reply="建议修改当前版本字幕，等待批准。",
            actions=[
                ProducerAction(
                    action="update_scene_subtitle",
                    target_id=active_scene_id,
                    params={"subtitle_effect": "fade_up"},
                    rationale="测试版本门禁",
                    impact="尝试修改非草稿镜头",
                )
            ],
        )
        active_blocked = client.post(
            "/api/production/assistant/messages",
            json={"message": "修改当前生效版本的字幕"},
        )
        assert active_blocked.json()["plan"] is None
        assert "scene revision is not a draft" in active_blocked.json()["observations"][-1]
    finally:
        api_config.production_config_path = original


def test_variables_only_template_action_uses_migrated_hyperframes_pack(
    tmp_path: Path,
    monkeypatch,
):
    original = api_config.production_config_path
    api_config.production_config_path = str(_write_config(tmp_path, image_workflow=True))
    llm = AsyncMock(
        return_value=ProducerDraft(
            reply="建议调整模板变量，等待批准。",
            actions=[
                ProducerAction(
                    action="set_channel_template",
                    target_id="science",
                    params={"variables": {"brand_label": "不能静默换模板"}},
                    rationale="测试模板归属门禁",
                    impact="尝试只修改模板变量",
                )
            ],
        )
    )
    monkeypatch.setattr(
        "api.routers.production.get_pixelle_video",
        AsyncMock(return_value=SimpleNamespace(llm=llm)),
    )
    try:
        response = TestClient(app).post(
            "/api/production/assistant/messages",
            json={"message": "只修改当前模板栏目名"},
        )
        assert response.status_code == 201
        plan = response.json()["plan"]
        assert plan is not None
        executed = TestClient(app).post(
            f"/api/production/assistant/plans/{plan['id']}/decision",
            json={"approved": True},
        )
        assert executed.json()["status"] == "completed"
        channel = load_runner_config(api_config.production_config_path).channels[0]
        assert channel.video["frame_template"] == "1080x1920/f2_knowledge_card_v1.html"
        assert channel.video["hyperframes"]["variables"]["brand_label"] == "不能静默换模板"
    finally:
        api_config.production_config_path = original


def test_variables_only_template_action_uses_native_template_params_baseline(
    tmp_path: Path,
    monkeypatch,
):
    original = api_config.production_config_path
    config_path = _write_config(tmp_path, image_workflow=True)
    channel_path = tmp_path / "channels" / "science.yaml"
    raw = channel_path.read_text(encoding="utf-8")
    channel_path.write_text(
        raw.replace(
            "frame_template: 1080x1920/image_default.html",
            "frame_template: 1080x1920/f2_knowledge_card_v1.html",
        ).replace(
            "  media_workflow: api/grok/grok-imagine-image-quality",
            "  media_workflow: api/grok/grok-imagine-image-quality\n"
            "  template_params:\n"
            "    brand_label: 已有栏目\n"
            "    card_opacity: 0.66",
        ),
        encoding="utf-8",
    )
    api_config.production_config_path = str(config_path)
    llm = AsyncMock(
        return_value=ProducerDraft(
            reply="建议更新强调色，等待批准。",
            actions=[
                ProducerAction(
                    action="set_channel_template",
                    target_id="science",
                    params={"variables": {"accent_color": "#224466"}},
                    rationale="更新频道强调色",
                    impact="保留现有栏目名和透明度，只更新强调色",
                )
            ],
        )
    )
    monkeypatch.setattr(
        "api.routers.production.get_pixelle_video",
        AsyncMock(return_value=SimpleNamespace(llm=llm)),
    )
    try:
        client = TestClient(app)
        drafted = client.post(
            "/api/production/assistant/messages",
            json={"message": "只把当前模板强调色改成蓝色"},
        )
        plan = drafted.json()["plan"]
        executed = client.post(
            f"/api/production/assistant/plans/{plan['id']}/decision",
            json={"approved": True},
        )
        assert executed.json()["status"] == "completed"
        channel = load_runner_config(config_path).channels[0]
        variables = channel.video["hyperframes"]["variables"]
        assert variables["brand_label"] == "已有栏目"
        assert variables["card_opacity"] == 0.66
        assert variables["accent_color"] == "#224466"
    finally:
        api_config.production_config_path = original


def test_failed_multi_action_plan_records_applied_actions_without_fake_rollback(
    tmp_path: Path,
    monkeypatch,
):
    original = api_config.production_config_path
    api_config.production_config_path = str(_write_config(tmp_path))
    llm = AsyncMock(
        return_value=ProducerDraft(
            reply="建议先暂停频道再创建补充频道，等待批准。",
            actions=[
                ProducerAction(
                    action="pause_channel",
                    target_id="science",
                    rationale="先停止补货",
                    impact="Science 频道暂停",
                ),
                ProducerAction(
                    action="create_channel",
                    target_id="broken-channel",
                    params={"daily_target": "not-an-integer"},
                    rationale="触发执行期校验",
                    impact="无效频道不会写入",
                ),
            ],
        )
    )
    monkeypatch.setattr(
        "api.routers.production.get_pixelle_video",
        AsyncMock(return_value=SimpleNamespace(llm=llm)),
    )
    try:
        client = TestClient(app)
        drafted = client.post(
            "/api/production/assistant/messages",
            json={"message": "执行一个包含后序失败的计划"},
        )
        plan = drafted.json()["plan"]
        executed = client.post(
            f"/api/production/assistant/plans/{plan['id']}/decision",
            json={"approved": True},
        )
        payload = executed.json()
        assert payload["status"] == "failed"
        assert len(payload["result"]["actions"]) == 1
        assert payload["result"]["actions"][0]["action"] == "pause_channel"
        assert "without automatic rollback" in payload["error"]
        with ProductionStore(str(tmp_path / "production.db")) as store:
            assert store.is_channel_paused("science") is True
            thread = store.get_assistant_thread(drafted.json()["thread_id"])
        assert "已有 1 个操作成功且不会自动回滚" in thread["messages"][-1]["content"]
        assert not (tmp_path / "channels" / "broken-channel.yaml").exists()
    finally:
        api_config.production_config_path = original


def test_channel_write_compare_and_swap_preserves_external_change(tmp_path: Path):
    config_path = _write_config(tmp_path)
    config = load_runner_config(config_path)
    channel = config.channels[0]
    channel_path = tmp_path / "channels" / "science.yaml"
    fingerprint = _channel_path_fingerprint(channel_path)
    external_content = channel_path.read_text(encoding="utf-8") + "# external edit\n"
    channel_path.write_text(external_content, encoding="utf-8")

    with pytest.raises(ValueError, match="changed concurrently"):
        _write_channel(
            channel_path.parent,
            channel.model_copy(update={"name": "Should not win"}),
            replace_id="science",
            expected_fingerprint=fingerprint,
        )

    assert channel_path.read_text(encoding="utf-8") == external_content
    assert not list(channel_path.parent.glob(".*.yaml.tmp"))


def test_scene_conditional_update_does_not_clear_started_regeneration(tmp_path: Path):
    _write_config(tmp_path, image_workflow=True)
    with ProductionStore(str(tmp_path / "production.db")) as store:
        scene = _create_editable_scene(store, tmp_path)
        expected_updated_at = scene["updated_at"]
        started = store.begin_scene_regeneration(scene["id"], "task-race", "composition")
        assert started["regeneration_status"] == "pending"

        with pytest.raises(ValueError, match="changed since it was read"):
            store.update_scene(
                scene["id"],
                expected_updated_at=expected_updated_at,
                require_idle=True,
                subtitle_effect="fade_up",
            )

        current = store.get_scene_context(scene["id"])["scene"]
        assert current["regeneration_status"] == "pending"
        assert current["regeneration_task_id"] == "task-race"
        assert current["subtitle_effect"] is None
