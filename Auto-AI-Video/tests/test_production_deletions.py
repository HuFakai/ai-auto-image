from pathlib import Path

from fastapi.testclient import TestClient

from api.app import app
from api.config import api_config
from pixelle_video.production import ProductionStore


def _write_config(tmp_path: Path, channel_count: int = 2) -> Path:
    channels = tmp_path / "channels"
    channels.mkdir()
    for channel_id in ("science", "morning")[:channel_count]:
        (channels / f"{channel_id}.yaml").write_text(
            f"""id: {channel_id}
name: {channel_id.title()}
topic:
  strategy: seed
  seeds: [space]
inventory:
  ready_target: 2
  daily_target: 1
  max_in_flight: 1
video:
  frame_template: 1080x1920/video_default.html
  media_workflow: api/grok/grok-imagine-video
""",
            encoding="utf-8",
        )
    config = tmp_path / "runner.yaml"
    config.write_text(
        f"database_path: {tmp_path / 'production.db'}\nchannels_dir: {channels}\n",
        encoding="utf-8",
    )
    return config


def _candidate(store: ProductionStore):
    candidate = store.create_topic_candidate(
        "science",
        "天空为什么是蓝色",
        "解释瑞利散射",
        {
            "source_type": "manual",
            "status": "approved",
            "fingerprint": "blue-sky",
            "scores": {"overall": 90},
        },
    )
    return candidate


def _import_video(store: ProductionStore, tmp_path: Path, from_candidate: bool = False):
    output = tmp_path / "output" / "video-one"
    output.mkdir(parents=True)
    final = output / "final.mp4"
    audio = output / "audio.mp3"
    media = output / "scene.mp4"
    segment = output / "segment.mp4"
    for path in (final, audio, media, segment):
        path.write_bytes(path.name.encode())
    if from_candidate:
        candidate = _candidate(store)
        job = store.create_job_from_topic_candidate(candidate["id"], {"text": "sky"})
    else:
        candidate = None
        job = store.create_job("science", "sky", "Blue sky", {"text": "sky"})
    job = store.update_job(
        job["id"],
        status="ready",
        review_status="pending",
        result_json={"video_path": str(final)},
    )
    project = store.import_project_revision(
        job["id"],
        {
            "title": "Blue sky",
            "frames": [
                {
                    "narration": "Rayleigh scattering",
                    "image_prompt": "Blue daylight sky",
                    "audio_path": str(audio),
                    "video_path": str(media),
                    "video_segment_path": str(segment),
                    "duration": 5,
                }
            ],
            "final_video_path": str(final),
            "total_duration": 5,
        },
        {"config": {"llm_model": "grok-4.5"}, "input": {}},
        [{"name": "video_codec", "status": "pass", "detail": {}}],
    )
    return candidate, job, project, (final, audio, media, segment)


def test_whole_video_delete_cascades_and_removes_output_and_temp_directories(
    tmp_path: Path, monkeypatch
):
    monkeypatch.setenv("PIXELLE_VIDEO_ROOT", str(tmp_path))
    original = api_config.production_config_path
    api_config.production_config_path = str(_write_config(tmp_path))
    try:
        with ProductionStore(str(tmp_path / "production.db")) as store:
            candidate, job, project, paths = _import_video(store, tmp_path, True)
        unindexed = paths[0].parent / "unindexed-sidecar.json"
        unindexed.write_text("owned by task directory", encoding="utf-8")
        task_temp = tmp_path / "temp" / paths[0].parent.name
        task_temp.mkdir(parents=True)
        transient = task_temp / "padded-scene.mp4"
        transient.write_bytes(b"temporary")
        client = TestClient(app)
        preview = client.get(f"/api/production/deletions/job/{job['id']}")
        assert preview.status_code == 200
        assert preview.json()["allowed"] is True
        assert preview.json()["files_count"] == 6
        assert preview.json()["counts"] == {
            "jobs": 1,
            "projects": 1,
            "revisions": 1,
            "scenes": 1,
            "artifacts": 4,
            "restored_topics": 1,
        }

        deleted = client.request(
            "DELETE",
            f"/api/production/deletions/job/{job['id']}",
            json={"confirm_id": job["id"], "delete_files": True},
        )
        assert deleted.status_code == 200
        assert deleted.json()["file_deletion"]["permanent"] is True
        assert set(deleted.json()["file_deletion"]["directories"]) == {
            str(paths[0].parent),
            str(task_temp),
        }
        assert deleted.json()["file_deletion"]["skipped"] == []
        assert all(not path.exists() for path in paths)
        assert not unindexed.exists()
        assert not paths[0].parent.exists()
        assert not transient.exists()
        assert not task_temp.exists()
        with ProductionStore(str(tmp_path / "production.db")) as store:
            assert store.list_jobs() == []
            assert store.list_projects() == []
            restored = store.get_topic_candidate(candidate["id"])
            assert restored["status"] == "approved"
            assert restored["consumed_job_id"] is None
            assert project["id"] not in {item["id"] for item in store.list_projects()}
    finally:
        api_config.production_config_path = original


def test_active_job_and_channel_resources_are_blocked(tmp_path: Path):
    original = api_config.production_config_path
    api_config.production_config_path = str(_write_config(tmp_path))
    try:
        with ProductionStore(str(tmp_path / "production.db")) as store:
            job = store.create_job("science", "space", "Space", {"text": "space"})
        client = TestClient(app)
        active = client.get(f"/api/production/deletions/job/{job['id']}")
        channel = client.get("/api/production/deletions/channel/science")
        assert active.json()["allowed"] is False
        assert "取消" in active.json()["blocked_reason"]
        assert channel.json()["allowed"] is False
        refused = client.request(
            "DELETE",
            f"/api/production/deletions/job/{job['id']}",
            json={"confirm_id": job["id"]},
        )
        assert refused.status_code == 409
    finally:
        api_config.production_config_path = original


def test_source_topic_channel_and_thread_can_be_deleted(tmp_path: Path):
    original = api_config.production_config_path
    api_config.production_config_path = str(_write_config(tmp_path))
    try:
        with ProductionStore(str(tmp_path / "production.db")) as store:
            source = store.create_content_source(
                "science", "Feed", "rss", "https://example.com/feed"
            )
            topic = _candidate(store)
            thread = store.create_assistant_thread("Disposable audit")
            store.append_assistant_message(thread["id"], "user", "hello")
        client = TestClient(app)
        for resource, target_id in (
            ("source", source["id"]),
            ("topic", topic["id"]),
            ("assistant-thread", thread["id"]),
        ):
            response = client.request(
                "DELETE",
                f"/api/production/deletions/{resource}/{target_id}",
                json={"confirm_id": target_id},
            )
            assert response.status_code == 200, response.text

        retired_preset = client.request(
            "DELETE",
            "/api/production/deletions/preset/retired",
            json={"confirm_id": "retired"},
        )
        assert retired_preset.status_code == 404

        channel = client.request(
            "DELETE",
            "/api/production/deletions/channel/science",
            json={"confirm_id": "science"},
        )
        assert channel.status_code == 200
        assert not (tmp_path / "channels" / "science.yaml").exists()
        assert channel.json()["file_deletion"]["permanent"] is True
        assert str(tmp_path / "channels" / "science.yaml") in channel.json()["file_deletion"]["files"]
    finally:
        api_config.production_config_path = original


def test_draft_scene_and_revision_delete_preserve_shared_active_media(tmp_path: Path):
    original = api_config.production_config_path
    api_config.production_config_path = str(_write_config(tmp_path))
    try:
        with ProductionStore(str(tmp_path / "production.db")) as store:
            _candidate_row, _job, project, paths = _import_video(store, tmp_path)
            draft = store.create_revision(project["id"], "draft")
            draft = store.split_scene(draft["scenes"][0]["id"], "Second", "Second visual")
            scene_id = draft["scenes"][1]["id"]
            draft_id = draft["id"]
        client = TestClient(app)
        scene = client.request(
            "DELETE",
            f"/api/production/deletions/scene/{scene_id}",
            json={"confirm_id": scene_id},
        )
        assert scene.status_code == 200
        revision = client.request(
            "DELETE",
            f"/api/production/deletions/revision/{draft_id}",
            json={"confirm_id": draft_id},
        )
        assert revision.status_code == 200
        assert all(path.exists() for path in paths)
        with ProductionStore(str(tmp_path / "production.db")) as store:
            remaining = store.get_project(project["id"])
            assert [item["number"] for item in remaining["revisions"]] == [1]
    finally:
        api_config.production_config_path = original
