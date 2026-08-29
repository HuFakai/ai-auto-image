import json
from pathlib import Path

from PIL import Image

from pixelle_video.models.storyboard import Storyboard, StoryboardConfig, StoryboardFrame
from pixelle_video.services.hyperframes_project import HyperFramesProjectBuilder


def test_project_builder_freezes_images_audio_and_timeline(tmp_path: Path):
    image = tmp_path / "source.png"
    Image.new("RGB", (120, 180), "#27405d").save(image)
    audio = tmp_path / "narration.mp3"
    audio.write_bytes(b"ID3-local-audio")
    runtime = tmp_path / "repo/services/hyperframes-renderer/node_modules/gsap/dist"
    runtime.mkdir(parents=True)
    (runtime / "gsap.min.js").write_text("window.gsap={timeline:()=>({})};", encoding="utf-8")
    config = StoryboardConfig(
        media_width=120,
        media_height=180,
        task_id="task-1",
        render_engine="hyperframes",
        renderer_version="0.8.4",
        frame_template="1080x1920/image_default.html",
    )
    storyboard = Storyboard(
        title="潮汐为什么一天两次",
        config=config,
        frames=[
            StoryboardFrame(
                index=0,
                narration="月球引力让海洋形成两个潮汐隆起。",
                image_prompt="潮汐示意图",
                audio_path=str(audio),
                media_type="image",
                image_path=str(image),
                duration=4.25,
            )
        ],
    )

    result = HyperFramesProjectBuilder(tmp_path / "repo").build(
        storyboard,
        tmp_path / "task",
    )

    entry = Path(result.entry_path).read_text(encoding="utf-8")
    manifest = json.loads(Path(result.manifest_path).read_text(encoding="utf-8"))
    assert 'data-composition-id="main"' in entry
    assert "data-composition-variables=" in entry
    assert 'data-var-text="brand_label"' in entry
    assert 'data-var-text="video_title"' in entry
    assert 'data-start="0"' in entry
    assert 'class="clip scene"' in entry
    assert 'window.__timelines["main"] = tl' in entry
    assert 'tl.set("#scene-1-media"' in entry
    assert 'tl.to("#scene-1-media"' in entry
    assert "force3D: true" in entry
    assert "autoRound: false" in entry
    assert 'ease: "none"' in entry
    assert 'tl.fromTo("#scene-1-media"' not in entry
    assert 'data-track-index="101"' in entry
    assert "http://" not in entry and "https://" not in entry
    assert manifest["duration"] == 4.25
    assert manifest["network_required"] is False
    assert manifest["template"]["template_id"] == "knowledge-card"
    assert manifest["template"]["version"] == 1
    assert len(manifest["template"]["fingerprint"]) == 64
    assert manifest["template"]["variables"]["brand_label"] == "一分钟知识卡"
    assert (Path(result.project_dir) / "template/manifest.json").is_file()
    assert (Path(result.project_dir) / "template/scene.css").is_file()
    assert len(manifest["assets"]) == 3
    assert all((Path(result.project_dir) / item["path"]).is_file() for item in manifest["assets"])
    assert (Path(result.project_dir) / "assets/gsap.min.js").is_file()


def test_project_builder_freezes_per_scene_direction(tmp_path: Path):
    image = tmp_path / "source.png"
    Image.new("RGB", (120, 180), "#27405d").save(image)
    audio = tmp_path / "narration.mp3"
    audio.write_bytes(b"ID3-local-audio")
    runtime = tmp_path / "repo/services/hyperframes-renderer/node_modules/gsap/dist"
    runtime.mkdir(parents=True)
    (runtime / "gsap.min.js").write_text("window.gsap={timeline:()=>({})};", encoding="utf-8")
    storyboard = Storyboard(
        title="director",
        config=StoryboardConfig(
            media_width=120, media_height=180, frame_template="1080x1920/image_default.html"
        ),
        frames=[
            StoryboardFrame(
                index=0,
                narration="一",
                image_prompt="一",
                audio_path=str(audio),
                media_type="image",
                image_path=str(image),
                duration=2,
                image_motion="pan_up",
                transition="none",
                focus_x=0.82,
                focus_y=0.24,
                focus_confidence=0.7,
                focus_source="test",
            ),
            StoryboardFrame(
                index=1,
                narration="二",
                image_prompt="二",
                audio_path=str(audio),
                media_type="image",
                image_path=str(image),
                duration=2,
                image_motion="pull_out",
                transition="slide_left",
                transition_duration=0.4,
                direction_reason="观点转折",
            ),
        ],
    )

    result = HyperFramesProjectBuilder(tmp_path / "repo").build(storyboard, tmp_path / "task")
    stale = Path(result.project_dir) / "assets" / "stale-from-previous-attempt.png"
    stale.write_bytes(b"stale")
    result = HyperFramesProjectBuilder(tmp_path / "repo").build(storyboard, tmp_path / "task")
    entry = Path(result.entry_path).read_text(encoding="utf-8")
    manifest = json.loads(Path(result.manifest_path).read_text(encoding="utf-8"))

    assert manifest["scenes"][1]["visual_start"] == 1.6
    assert manifest["scenes"][1]["transition"] == "slide_left"
    assert manifest["scenes"][1]["direction_reason"] == "观点转折"
    assert manifest["scenes"][0]["focus_x"] == 0.82
    assert manifest["scenes"][0]["focus_source"] == "test"
    assert "object-position: 82.000% 24.000%" in entry
    assert "transform-origin: 82.000% 24.000%" in entry
    assert "xPercent: 100" in entry
    assert "scale: 1.12" in entry
    assert 'data-track-index="101"' in entry
    assert 'data-track-index="102"' in entry
    assert 'id="scene-2-content" class="scene-content" style="opacity: 0"' in entry
    assert 'id="scene-2-copy" class="scene-copy" data-layout-allow-overlap' in entry
    assert not stale.exists()


def test_all_image_motions_use_one_frozen_pose_and_linear_tween():
    motions = (
        "none",
        "push_in",
        "pull_out",
        "pan_left",
        "pan_right",
        "pan_up",
        "pan_down",
        "ken_burns",
    )

    for index, motion in enumerate(motions, start=1):
        tween = HyperFramesProjectBuilder._motion_tween(
            index,
            motion,
            start=1.25,
            duration=4.5,
            focus_x=0.37,
            focus_y=0.62,
        )
        assert f'tl.set("#scene-{index}-media"' in tween
        assert "force3D: true" in tween
        assert "autoRound: false" in tween
        assert "smoothOrigin: false" in tween
        assert 'transformOrigin: "37.000% 62.000%"' in tween
        assert "fromTo" not in tween
        if motion == "none":
            assert "tl.to(" not in tween
        else:
            assert f'tl.to("#scene-{index}-media"' in tween
            assert 'ease: "none"' in tween
            assert "duration: 4.5" in tween


def test_project_builder_selects_and_freezes_template_variables(tmp_path: Path):
    image = tmp_path / "source.png"
    Image.new("RGB", (120, 180), "#ffffff").save(image)
    audio = tmp_path / "narration.mp3"
    audio.write_bytes(b"ID3-local-audio")
    runtime = tmp_path / "repo/services/hyperframes-renderer/node_modules/gsap/dist"
    runtime.mkdir(parents=True)
    (runtime / "gsap.min.js").write_text("window.gsap={timeline:()=>({})};", encoding="utf-8")
    storyboard = Storyboard(
        title="边界感不是冷漠",
        config=StoryboardConfig(
            media_width=120,
            media_height=180,
            frame_template="1080x1920/f2_stickman_psychology_v1.html",
        ),
        frames=[
            StoryboardFrame(
                index=0,
                narration="先说清楚自己的感受。",
                image_prompt="stickman",
                audio_path=str(audio),
                media_type="image",
                image_path=str(image),
                duration=2,
            )
        ],
    )

    result = HyperFramesProjectBuilder(tmp_path / "repo").build(
        storyboard,
        tmp_path / "task",
        template_id="stickman-psychology",
        template_version=1,
        template_variables={"accent_color": "#12ABEF", "brand_label": "边界练习"},
    )
    entry = Path(result.entry_path).read_text(encoding="utf-8")
    manifest = json.loads(Path(result.manifest_path).read_text(encoding="utf-8"))

    assert result.template_id == "stickman-psychology"
    assert result.template_variables["accent_color"] == "#12ABEF"
    assert "--accent_color: #12ABEF" in entry
    assert "边界练习" in entry
    assert '<span data-var-text="eyebrow_label">MENTAL NOTE</span> · 01' in entry
    assert manifest["template"]["variables"]["brand_label"] == "边界练习"
    assert "火柴人心理学 V1" in Path(result.design_path).read_text(encoding="utf-8")


def test_project_builder_omits_empty_scene_label_and_number(tmp_path: Path):
    image = tmp_path / "source.png"
    Image.new("RGB", (120, 180), "#ffffff").save(image)
    audio = tmp_path / "narration.mp3"
    audio.write_bytes(b"ID3-local-audio")
    runtime = tmp_path / "repo/services/hyperframes-renderer/node_modules/gsap/dist"
    runtime.mkdir(parents=True)
    (runtime / "gsap.min.js").write_text(
        "window.gsap={timeline:()=>({})};", encoding="utf-8"
    )
    storyboard = Storyboard(
        title="无分镜标签",
        config=StoryboardConfig(
            media_width=120,
            media_height=180,
            frame_template="1080x1920/f2_knowledge_card_v1.html",
        ),
        frames=[
            StoryboardFrame(
                index=0,
                narration="只显示字幕，不显示空标签或分镜序号。",
                image_prompt="minimal card",
                audio_path=str(audio),
                media_type="image",
                image_path=str(image),
                duration=2,
            )
        ],
    )

    result = HyperFramesProjectBuilder(tmp_path / "repo").build(
        storyboard,
        tmp_path / "task",
        template_variables={"eyebrow_label": "   "},
    )
    entry = Path(result.entry_path).read_text(encoding="utf-8")

    assert 'class="scene-index"' not in entry
    assert 'data-var-text="eyebrow_label"' not in entry
    assert " · 01</span>" not in entry
    assert '<p class="subtitle-text">只显示字幕' in entry


def test_project_builder_rejects_video_scene_in_image_html_stage(tmp_path: Path):
    runtime = tmp_path / "repo/services/hyperframes-renderer/node_modules/gsap/dist"
    runtime.mkdir(parents=True)
    (runtime / "gsap.min.js").write_text("runtime", encoding="utf-8")
    video = tmp_path / "video.mp4"
    video.write_bytes(b"video")
    audio = tmp_path / "audio.mp3"
    audio.write_bytes(b"audio")
    storyboard = Storyboard(
        title="video",
        config=StoryboardConfig(
            media_width=100,
            media_height=100,
            frame_template="1080x1920/image_default.html",
        ),
        frames=[
            StoryboardFrame(
                index=0,
                narration="narration",
                image_prompt="prompt",
                audio_path=str(audio),
                media_type="video",
                video_path=str(video),
                duration=2,
            )
        ],
    )

    try:
        HyperFramesProjectBuilder(tmp_path / "repo").build(storyboard, tmp_path / "task")
    except ValueError as exc:
        assert "requires a local image" in str(exc)
    else:
        raise AssertionError("video scene should be rejected during image+HTML F1")
