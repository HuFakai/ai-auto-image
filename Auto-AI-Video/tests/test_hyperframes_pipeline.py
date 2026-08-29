import asyncio
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from pixelle_video.models.storyboard import Storyboard, StoryboardConfig, StoryboardFrame
from pixelle_video.pipelines.linear import PipelineContext
from pixelle_video.pipelines.standard import StandardPipeline
from pixelle_video.services.frame_processor import FrameProcessor
from pixelle_video.services.hyperframes_renderer import HyperFramesRenderResult


@pytest.mark.asyncio
async def test_frame_processor_stops_after_assets_for_hyperframes(tmp_path: Path):
    image = tmp_path / "image.png"
    image.write_bytes(b"image")
    audio = tmp_path / "audio.mp3"
    audio.write_bytes(b"audio")
    processor = FrameProcessor(SimpleNamespace())
    processor._step_generate_media = AsyncMock()
    processor._step_compose_frame = AsyncMock()
    processor._step_create_video_segment = AsyncMock()
    frame = StoryboardFrame(
        index=0,
        narration="narration",
        image_prompt="existing prompt",
        audio_path=str(audio),
        media_type="image",
        image_path=str(image),
        duration=2,
    )
    config = StoryboardConfig(
        media_width=100,
        media_height=100,
        render_engine="hyperframes",
    )
    storyboard = Storyboard(title="title", config=config, frames=[frame])

    result = await processor(frame, storyboard, config)

    assert result is frame
    processor._step_generate_media.assert_not_awaited()
    processor._step_compose_frame.assert_not_awaited()
    processor._step_create_video_segment.assert_not_awaited()


@pytest.mark.asyncio
async def test_standard_pipeline_dispatches_built_project_to_renderer(tmp_path: Path, monkeypatch):
    final_path = tmp_path / "final.mp4"
    project_dir = tmp_path / "hyperframes"
    project_dir.mkdir()
    manifest = project_dir / "manifest.json"
    manifest.write_text("{}", encoding="utf-8")
    check = project_dir / "check-report.json"
    check.write_text("{}", encoding="utf-8")
    config = StoryboardConfig(
        media_width=100,
        media_height=100,
        render_engine="hyperframes",
        renderer_version="0.8.4",
        frame_template="1080x1920/image_default.html",
    )
    storyboard = Storyboard(title="title", config=config)
    progress = []
    ctx = PipelineContext(
        input_text="topic",
        params={"hyperframes": {"quality": "draft", "strictness": "strict"}},
        progress_callback=progress.append,
        task_dir=str(tmp_path),
        final_video_path=str(final_path),
        config=config,
        storyboard=storyboard,
    )

    class FakeBuilder:
        def build(self, *_args, **_kwargs):
            return SimpleNamespace(
                project_dir=str(project_dir),
                manifest_path=str(manifest),
                duration=5.0,
                template_id="knowledge-card",
                template_version=1,
                template_fingerprint="f" * 64,
                template_variables={"brand_label": "一分钟知识卡"},
            )

    class FakeAdapter:
        def __init__(self, **_options):
            pass

        async def ready(self):
            return {"ready": True}

        async def submit(self, submitted_project, **options):
            assert submitted_project == str(project_dir)
            assert options["quality"] == "draft"
            return {"id": "render-1"}

        async def wait(self, render_id, callback):
            assert render_id == "render-1"
            callback(50, "capture", "capturing")
            final_path.write_bytes(b"video")
            return HyperFramesRenderResult(
                render_id=render_id,
                output_path=str(final_path),
                duration=5,
                size_bytes=5,
                total_frames=150,
                warnings=[],
                perf_summary=None,
                check_report_path=str(check),
            )

        async def cancel(self, _render_id):
            raise AssertionError("cancel should not be called")

    monkeypatch.setattr(
        "pixelle_video.services.hyperframes_project.HyperFramesProjectBuilder",
        FakeBuilder,
    )
    monkeypatch.setattr(
        "pixelle_video.services.hyperframes_renderer.HyperFramesRendererAdapter",
        FakeAdapter,
    )
    core = SimpleNamespace(
        llm=None,
        tts=None,
        media=None,
        video=None,
        persistence=SimpleNamespace(save_storyboard=AsyncMock()),
    )

    await StandardPipeline(core)._render_hyperframes(ctx)

    assert config.hyperframes_render_id == "render-1"
    assert config.hyperframes_manifest_path == str(manifest)
    assert config.hyperframes_check_report_path == str(check)
    assert config.hyperframes_template_id == "knowledge-card"
    assert config.hyperframes_template_version == 1
    assert config.hyperframes_template_fingerprint == "f" * 64
    assert storyboard.final_video_path == str(final_path)
    assert storyboard.total_duration == 5
    assert any(event.event_type == "hyperframes_capture" for event in progress)


@pytest.mark.asyncio
async def test_hyperframes_reuses_valid_completed_video(tmp_path: Path, monkeypatch):
    final_path = tmp_path / "final.mp4"
    final_path.write_bytes(b"valid-video-placeholder")
    persistence = SimpleNamespace(save_storyboard=AsyncMock())
    config = StoryboardConfig(
        media_width=100,
        media_height=100,
        render_engine="hyperframes",
    )
    storyboard = Storyboard(title="title", config=config)
    ctx = PipelineContext(
        input_text="topic",
        params={},
        task_id="task-1",
        task_dir=str(tmp_path),
        final_video_path=str(final_path),
        config=config,
        storyboard=storyboard,
    )
    monkeypatch.setattr(
        "pixelle_video.services.video.VideoService._get_video_duration",
        lambda _self, _path: 4.25,
    )

    core = SimpleNamespace(
        llm=None,
        tts=None,
        media=None,
        video=None,
        persistence=persistence,
    )
    await StandardPipeline(core)._render_hyperframes(ctx)

    assert storyboard.final_video_path == str(final_path)
    assert storyboard.total_duration == 4.25
    persistence.save_storyboard.assert_awaited_once()


def test_legacy_manifest_recovers_existing_hyperframes_assets(tmp_path: Path):
    project_dir = tmp_path / "hyperframes"
    assets_dir = project_dir / "assets"
    assets_dir.mkdir(parents=True)
    image = assets_dir / "scene.png"
    audio = assets_dir / "scene.mp3"
    image.write_bytes(b"image")
    audio.write_bytes(b"audio")
    (project_dir / "manifest.json").write_text(
        """{
          "scenes": [{
            "narration": "旁白",
            "image": "assets/scene.png",
            "audio": "assets/scene.mp3",
            "duration": 3.5
          }]
        }""",
        encoding="utf-8",
    )
    current = StoryboardFrame(index=0, narration="旁白", image_prompt="提示词")
    ctx = PipelineContext(
        input_text="topic",
        params={"render_engine": "hyperframes"},
        task_dir=str(tmp_path),
    )

    recovered = StandardPipeline._load_hyperframes_manifest_checkpoint(ctx, [current])

    assert recovered[0].image_path == str(image.resolve())
    assert recovered[0].audio_path == str(audio.resolve())
    assert recovered[0].duration == 3.5


@pytest.mark.asyncio
async def test_serial_asset_production_saves_each_scene_checkpoint():
    frames = [
        StoryboardFrame(index=0, narration="一", image_prompt="一", duration=2),
        StoryboardFrame(index=1, narration="二", image_prompt="二", duration=3),
    ]
    config = StoryboardConfig(media_width=100, media_height=100)
    storyboard = Storyboard(title="title", config=config, frames=frames)
    persistence = SimpleNamespace(save_storyboard=AsyncMock())
    frame_processor = AsyncMock(side_effect=frames)
    core = SimpleNamespace(
        llm=None,
        tts=None,
        media=None,
        video=None,
        persistence=persistence,
        frame_processor=frame_processor,
    )
    ctx = PipelineContext(
        input_text="topic",
        params={},
        task_id="task-1",
        config=config,
        storyboard=storyboard,
    )

    await StandardPipeline(core).produce_assets(ctx)

    assert persistence.save_storyboard.await_count == 2
    assert storyboard.total_duration == 5


@pytest.mark.asyncio
async def test_image_assets_are_generated_in_parallel_before_serial_rendering(tmp_path: Path):
    frames = [
        StoryboardFrame(index=index, narration=f"旁白 {index}", image_prompt=f"画面 {index}")
        for index in range(4)
    ]
    config = StoryboardConfig(
        media_width=100,
        media_height=100,
        media_workflow="api/grok/image-model",
    )
    storyboard = Storyboard(title="title", config=config, frames=frames)
    persistence = SimpleNamespace(save_storyboard=AsyncMock())

    class Processor:
        def __init__(self):
            self.active = 0
            self.max_active = 0

        async def _step_generate_media(self, frame, _config):
            self.active += 1
            self.max_active = max(self.max_active, self.active)
            await asyncio.sleep(0.01)
            frame.image_path = str(tmp_path / f"{frame.index}.png")
            frame.media_type = "image"
            self.active -= 1

        async def __call__(self, frame, **_kwargs):
            frame.duration = 1
            return frame

    processor = Processor()
    core = SimpleNamespace(
        llm=None,
        tts=None,
        media=SimpleNamespace(resolve_media_type=lambda *_args, **_kwargs: "image"),
        video=None,
        persistence=persistence,
        frame_processor=processor,
    )
    ctx = PipelineContext(
        input_text="topic",
        params={"image_generation_concurrency": 4},
        task_id="parallel-images",
        config=config,
        storyboard=storyboard,
    )

    await StandardPipeline(core).produce_assets(ctx)

    assert processor.max_active == 4
    assert all(frame.image_path for frame in storyboard.frames)
    assert persistence.save_storyboard.await_count == 8


@pytest.mark.asyncio
async def test_hyperframes_failure_uses_native_renderer_without_regenerating_assets(
    tmp_path: Path,
    monkeypatch,
):
    final_path = tmp_path / "final.mp4"
    frames = [
        StoryboardFrame(index=0, narration="一", image_prompt="一", duration=2),
        StoryboardFrame(index=1, narration="二", image_prompt="二", duration=3),
    ]
    config = StoryboardConfig(
        media_width=100,
        media_height=100,
        task_id="task-1",
        render_engine="hyperframes",
        renderer_version="0.8.4",
    )
    storyboard = Storyboard(title="title", config=config, frames=frames)
    persistence = SimpleNamespace(save_storyboard=AsyncMock())

    async def native_frame_processor(**kwargs):
        frame = kwargs["frame"]
        segment = tmp_path / f"segment-{frame.index}.mp4"
        segment.write_bytes(b"segment")
        frame.video_segment_path = str(segment)
        return frame

    core = SimpleNamespace(
        llm=None,
        tts=None,
        media=None,
        video=None,
        persistence=persistence,
        frame_processor=AsyncMock(side_effect=native_frame_processor),
    )
    pipeline = StandardPipeline(core)
    pipeline._render_hyperframes = AsyncMock(side_effect=RuntimeError("structured check failed"))
    pipeline._finish_final_output = AsyncMock()

    def concat_videos(_self, **_kwargs):
        final_path.write_bytes(b"native-video")
        return str(final_path)

    monkeypatch.setattr(
        "pixelle_video.pipelines.standard.VideoService.concat_videos",
        concat_videos,
    )
    ctx = PipelineContext(
        input_text="topic",
        params={"hyperframes": {"fallback_to_native": True}},
        task_id="task-1",
        task_dir=str(tmp_path),
        final_video_path=str(final_path),
        config=config,
        storyboard=storyboard,
    )

    await pipeline.post_production(ctx)

    assert final_path.read_bytes() == b"native-video"
    assert config.render_engine == "native_image_html"
    assert config.renderer_version == "native-image-html-v2"
    assert "structured check failed" in (config.render_fallback_reason or "")
    assert ctx.params["render_fallback"]["from"] == "hyperframes"
    assert core.frame_processor.await_count == 2
    pipeline._finish_final_output.assert_awaited_once_with(ctx, str(final_path))


@pytest.mark.asyncio
async def test_hyperframes_success_also_finishes_with_persistent_cover(tmp_path: Path):
    final_path = tmp_path / "final.mp4"
    config = StoryboardConfig(
        media_width=100,
        media_height=100,
        render_engine="hyperframes",
    )
    storyboard = Storyboard(title="title", config=config)
    pipeline = StandardPipeline(
        SimpleNamespace(llm=None, tts=None, media=None, video=None)
    )
    pipeline._render_hyperframes = AsyncMock()
    pipeline._finish_final_output = AsyncMock()
    ctx = PipelineContext(
        input_text="topic",
        params={},
        task_id="task-1",
        task_dir=str(tmp_path),
        final_video_path=str(final_path),
        config=config,
        storyboard=storyboard,
    )

    await pipeline.post_production(ctx)

    pipeline._render_hyperframes.assert_awaited_once_with(ctx)
    pipeline._finish_final_output.assert_awaited_once_with(ctx, str(final_path))


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("render_engine", "extra_params"),
    [
        ("native_image_html", {}),
        ("whiteboard_cv", {}),
        ("native_image_html", {"production_mode": "direct_video"}),
    ],
)
async def test_native_whiteboard_and_direct_video_share_cover_finalization(
    tmp_path: Path,
    monkeypatch,
    render_engine: str,
    extra_params: dict,
):
    final_path = tmp_path / f"{render_engine}-{len(extra_params)}.mp4"
    segment = tmp_path / "segment.mp4"
    segment.write_bytes(b"segment")
    config = StoryboardConfig(
        media_width=100,
        media_height=100,
        render_engine=render_engine,
    )
    storyboard = Storyboard(
        title="title",
        config=config,
        frames=[
            StoryboardFrame(
                index=0,
                narration="scene",
                image_prompt="prompt",
                video_segment_path=str(segment),
                duration=2,
            )
        ],
    )
    pipeline = StandardPipeline(
        SimpleNamespace(llm=None, tts=None, media=None, video=None)
    )
    pipeline._finish_final_output = AsyncMock()
    monkeypatch.setattr(
        "pixelle_video.pipelines.standard.VideoService.concat_videos",
        lambda _self, **_kwargs: str(final_path),
    )
    ctx = PipelineContext(
        input_text="topic",
        params=extra_params,
        task_id="task-1",
        task_dir=str(tmp_path),
        final_video_path=str(final_path),
        config=config,
        storyboard=storyboard,
    )

    await pipeline.post_production(ctx)

    pipeline._finish_final_output.assert_awaited_once_with(ctx, str(final_path))


@pytest.mark.asyncio
async def test_hyperframes_failure_can_disable_native_fallback(tmp_path: Path):
    config = StoryboardConfig(
        media_width=100,
        media_height=100,
        render_engine="hyperframes",
    )
    storyboard = Storyboard(title="title", config=config)
    core = SimpleNamespace(llm=None, tts=None, media=None, video=None)
    pipeline = StandardPipeline(core)
    pipeline._render_hyperframes = AsyncMock(side_effect=RuntimeError("failed"))
    ctx = PipelineContext(
        input_text="topic",
        params={"hyperframes": {"fallback_to_native": False}},
        task_id="task-1",
        task_dir=str(tmp_path),
        final_video_path=str(tmp_path / "final.mp4"),
        config=config,
        storyboard=storyboard,
    )

    with pytest.raises(RuntimeError, match="failed"):
        await pipeline.post_production(ctx)
