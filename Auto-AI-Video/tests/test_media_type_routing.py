from dataclasses import replace
from pathlib import Path

import pytest

from pixelle_video.models.media import MediaResult
from pixelle_video.models.storyboard import StoryboardConfig, StoryboardFrame
from pixelle_video.services.frame_processor import FrameProcessor


class _ImageMediaService:
    def __init__(self):
        self.calls = []

    def resolve_media_type(self, workflow, fallback="image"):
        assert workflow == "api/grok/image-model"
        return "image"

    async def __call__(self, **params):
        self.calls.append(params)
        target = Path(params["output_path"])
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(b"\xff\xd8\xff\xe0generated-jpeg")
        return MediaResult(media_type="image", url=str(target))


@pytest.mark.asyncio
async def test_image_model_stays_image_with_video_named_template(tmp_path, monkeypatch):
    monkeypatch.setenv("PIXELLE_VIDEO_ROOT", str(tmp_path))
    media = _ImageMediaService()
    processor = FrameProcessor(type("Core", (), {"media": media})())
    frame = StoryboardFrame(index=0, narration="旁白", image_prompt="海潮科普插画")
    config = StoryboardConfig(
        media_width=512,
        media_height=288,
        task_id="task-image",
        media_workflow="api/grok/image-model",
        frame_template="1080x1920/video_default.html",
    )

    await processor._step_generate_media(frame, config)

    assert media.calls[0]["media_type"] == "image"
    assert media.calls[0]["output_path"].endswith("01_image.png")
    assert frame.media_type == "image"
    assert frame.image_path and frame.image_path.endswith("01_image.png")
    assert Path(frame.image_path).is_file()
    assert frame.video_path is None

    second_frame = StoryboardFrame(index=0, narration="另一段旁白", image_prompt="海潮科普插画")
    second_config = replace(config, task_id="task-image-second-run")
    await processor._step_generate_media(second_frame, second_config)

    assert len(media.calls) == 2
    assert second_frame.image_path is not None
    assert "task-image-second-run" in second_frame.image_path
    assert Path(second_frame.image_path).is_file()


def test_downloaded_image_rejects_video_extension(tmp_path):
    wrong_path = tmp_path / "frame.mp4"
    wrong_path.write_bytes(b"\xff\xd8\xff\xe0generated-jpeg")

    with pytest.raises(ValueError, match="invalid extension"):
        FrameProcessor._require_local_media(str(wrong_path), "image")
