from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pytest
from PIL import Image, ImageDraw

from api.routers.video import build_video_params
from api.schemas.video import VideoGenerateRequest
from pixelle_video.models.storyboard import Storyboard, StoryboardConfig, StoryboardFrame
from pixelle_video.rendering.subtitle_effects import (
    highlight_subtitle_text,
    resolve_native_subtitle_effect,
)
from pixelle_video.services.frame_html import HTMLFrameGenerator
from pixelle_video.services.frame_processor import FrameProcessor
from pixelle_video.services.hyperframes_project import HyperFramesProjectBuilder
from pixelle_video.services.video import VideoService


def test_video_request_freezes_subtitle_effect_into_pipeline_params():
    request = VideoGenerateRequest.model_validate(
        {
            "text": "字幕动效",
            "frame_template": "1080x1920/image_default.html",
            "subtitle_effect": "word_pop",
        }
    )

    assert build_video_params(request)["subtitle_effect"] == "word_pop"
    with pytest.raises(ValueError, match="subtitle_effect"):
        VideoGenerateRequest.model_validate(
            {
                "text": "bad",
                "frame_template": "1080x1920/image_default.html",
                "subtitle_effect": "blink",
            }
        )


def test_native_effect_resolution_records_advanced_fallback():
    native = resolve_native_subtitle_effect("typewriter")

    assert native.requested == "typewriter"
    assert native.applied == "fade_up"
    assert "降级" in (native.fallback_reason or "")
    assert resolve_native_subtitle_effect("fade_up").fallback_reason is None


def test_native_keyword_markup_is_escaped_and_emphasized():
    markup = highlight_subtitle_text("情绪 <边界感>", ["情绪", "边界感"])

    assert '<mark class="pixelle-subtitle-keyword"' in markup
    assert "<边界感>" not in markup
    assert "&lt;" in markup and "&gt;" in markup


@pytest.mark.skipif(not shutil.which("ffmpeg"), reason="FFmpeg is required")
def test_native_fade_up_changes_overlay_alpha_deterministically(tmp_path: Path):
    image = tmp_path / "background.png"
    Image.new("RGB", (160, 284), "#151515").save(image)
    chrome = tmp_path / "chrome.png"
    transparent = Image.new("RGBA", (160, 284), (0, 0, 0, 0))
    ImageDraw.Draw(transparent).rectangle((30, 20, 130, 55), fill=(255, 0, 0, 255))
    transparent.save(chrome)
    subtitle = tmp_path / "subtitle.png"
    transparent = Image.new("RGBA", (160, 284), (0, 0, 0, 0))
    ImageDraw.Draw(transparent).rectangle((50, 110, 110, 170), fill=(0, 255, 0, 255))
    transparent.save(subtitle)
    audio = tmp_path / "audio.wav"
    subprocess.run(
        [
            "ffmpeg",
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:sample_rate=44100:duration=1",
            str(audio),
        ],
        check=True,
    )
    output = tmp_path / "fade-up.mp4"
    VideoService().create_video_from_image(
        str(image),
        str(audio),
        str(output),
        fps=30,
        overlay=str(chrome),
        subtitle_overlay=str(subtitle),
        subtitle_effect="fade_up",
    )

    samples = []
    for name, at in (("early", "0.03"), ("late", "0.75")):
        frame = tmp_path / f"{name}.png"
        subprocess.run(
            [
                "ffmpeg",
                "-hide_banner",
                "-loglevel",
                "error",
                "-y",
                "-ss",
                at,
                "-i",
                str(output),
                "-frames:v",
                "1",
                str(frame),
            ],
            check=True,
        )
        with Image.open(frame).convert("RGB") as rendered:
            samples.append(
                (
                    sum(
                        red > green * 1.8 and red > blue * 1.8
                        for red, green, blue in rendered.getdata()
                    ),
                    sum(
                    green > red * 1.8 and green > blue * 1.8
                    for red, green, blue in rendered.getdata()
                    ),
                )
            )

    assert samples[0][0] > 2500
    assert abs(samples[0][0] - samples[1][0]) < 250
    assert samples[0][1] < 50
    assert samples[1][1] > 2500


@pytest.mark.skipif(not shutil.which("ffmpeg"), reason="FFmpeg is required")
def test_native_video_path_keeps_chrome_static_while_subtitle_fades(tmp_path: Path):
    source = tmp_path / "source.mp4"
    subprocess.run(
        [
            "ffmpeg",
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-f",
            "lavfi",
            "-i",
            "color=c=#151515:s=160x284:d=1:r=30",
            "-an",
            str(source),
        ],
        check=True,
    )
    chrome = tmp_path / "chrome.png"
    layer = Image.new("RGBA", (160, 284), (0, 0, 0, 0))
    ImageDraw.Draw(layer).rectangle((30, 20, 130, 55), fill=(255, 0, 0, 255))
    layer.save(chrome)
    subtitle = tmp_path / "subtitle.png"
    layer = Image.new("RGBA", (160, 284), (0, 0, 0, 0))
    ImageDraw.Draw(layer).rectangle((50, 110, 110, 170), fill=(0, 255, 0, 255))
    layer.save(subtitle)
    output = tmp_path / "layered.mp4"

    VideoService().overlay_image_on_video(
        str(source),
        str(chrome),
        str(output),
        subtitle_overlay=str(subtitle),
        subtitle_effect="fade_up",
    )

    counts = []
    for name, at in (("early", "0.03"), ("late", "0.75")):
        frame = tmp_path / f"video-{name}.png"
        subprocess.run(
            [
                "ffmpeg",
                "-hide_banner",
                "-loglevel",
                "error",
                "-y",
                "-ss",
                at,
                "-i",
                str(output),
                "-frames:v",
                "1",
                str(frame),
            ],
            check=True,
        )
        with Image.open(frame).convert("RGB") as rendered:
            counts.append(
                (
                    sum(
                        red > green * 1.8 and red > blue * 1.8
                        for red, green, blue in rendered.getdata()
                    ),
                    sum(
                        green > red * 1.8 and green > blue * 1.8
                        for red, green, blue in rendered.getdata()
                    ),
                )
            )

    assert counts[0][0] > 2500
    assert abs(counts[0][0] - counts[1][0]) < 250
    assert counts[0][1] < 50
    assert counts[1][1] > 2500


def test_html_frame_generator_isolates_subtitle_from_static_chrome():
    generator = HTMLFrameGenerator("templates/1080x1920/f2_knowledge_card_v1.html")

    assert generator.has_safe_layer("subtitle") is True
    chrome_css = generator._layer_visibility_css("chrome")
    subtitle_css = generator._layer_visibility_css("subtitle")
    assert '[data-pixelle-safe="subtitle"]' in chrome_css
    assert "body *" not in chrome_css
    assert "body * { visibility: hidden" in subtitle_css
    assert "visibility: visible" in subtitle_css


@pytest.mark.asyncio
async def test_html_frame_generator_renders_true_split_layers(tmp_path: Path):
    template_dir = tmp_path / "160x284"
    template_dir.mkdir()
    template = template_dir / "layers.html"
    template.write_text(
        """<!doctype html><html><head><style>
html,body{width:160px;height:284px;margin:0;background:#111}
#media{position:absolute;inset:0;background:#2244aa}
#chrome{position:absolute;left:20px;top:20px;width:120px;height:36px;background:#ff0000}
#subtitle{position:absolute;left:40px;top:120px;width:80px;height:44px;background:#00ff00}
</style></head><body>
<div id="media" data-pixelle-media-layer="full-canvas"></div>
<div id="chrome"></div>
<div id="subtitle" data-pixelle-safe="subtitle">字幕</div>
</body></html>""",
        encoding="utf-8",
    )
    generator = HTMLFrameGenerator(str(template))
    chrome = tmp_path / "chrome.png"
    subtitle = tmp_path / "subtitle.png"
    try:
        await generator.generate_frame(
            "",
            "",
            "",
            output_path=str(chrome),
            transparent_background=True,
            layer_mode="chrome",
        )
        await generator.generate_frame(
            "",
            "",
            "",
            output_path=str(subtitle),
            transparent_background=True,
            layer_mode="subtitle",
        )
    finally:
        await HTMLFrameGenerator.close_browser()

    with Image.open(chrome).convert("RGBA") as rendered_chrome:
        assert rendered_chrome.getpixel((30, 30))[:3] == (255, 0, 0)
        assert rendered_chrome.getpixel((100, 150))[3] == 0
    with Image.open(subtitle).convert("RGBA") as rendered_subtitle:
        assert rendered_subtitle.getpixel((30, 30))[3] == 0
        assert rendered_subtitle.getpixel((100, 150))[:3] == (0, 255, 0)


@pytest.mark.asyncio
@pytest.mark.parametrize("media_type", ["image", "video"])
async def test_frame_processor_builds_static_chrome_and_subtitle_only_layers(
    tmp_path: Path,
    monkeypatch,
    media_type: str,
):
    monkeypatch.setenv("PIXELLE_VIDEO_ROOT", str(tmp_path))
    media = tmp_path / ("source.png" if media_type == "image" else "source.mp4")
    media.write_bytes(b"local-media")
    frame = StoryboardFrame(
        index=0,
        narration="只让这句字幕动起来",
        image_prompt="prompt",
        media_type=media_type,
        image_path=str(media) if media_type == "image" else None,
        video_path=str(media) if media_type == "video" else None,
    )
    config = StoryboardConfig(
        media_width=1024,
        media_height=1536,
        task_id=f"split-{media_type}",
        renderer_version="native-image-html-v2",
        frame_template="1080x1920/f2_knowledge_card_v1.html",
        template_snapshot_path=str(
            Path.cwd() / "templates/1080x1920/f2_knowledge_card_v1.html"
        ),
        subtitle_effect="fade_up",
        subtitle_effect_applied="fade_up",
    )
    storyboard = Storyboard(title="固定标题", config=config, frames=[frame])
    processor = FrameProcessor(object())
    calls: list[tuple[bool, str, str]] = []

    async def fake_compose(
        _frame,
        _storyboard,
        _config,
        output_path,
        transparent_background=False,
        layer_mode="full",
    ):
        calls.append((transparent_background, layer_mode, output_path))
        return output_path

    monkeypatch.setattr(processor, "_compose_frame_html", fake_compose)

    await processor._step_compose_frame(frame, storyboard, config)

    if media_type == "image":
        assert [item[:2] for item in calls] == [
            (False, "full"),
            (False, "chrome"),
            (True, "subtitle"),
        ]
        assert frame.overlay_image_path is None
        assert frame.subtitle_overlay_path and frame.subtitle_overlay_path.endswith(
            "_subtitle.png"
        )
        assert frame.subtitle_effect_applied == "fade_up"
    else:
        assert [item[:2] for item in calls] == [(True, "full")]
        assert frame.subtitle_effect_applied == "static"
        assert "降级" in (frame.subtitle_effect_fallback_reason or "")


@pytest.mark.asyncio
async def test_frame_processor_keeps_full_bleed_media_as_separable_base(
    tmp_path: Path,
    monkeypatch,
):
    monkeypatch.setenv("PIXELLE_VIDEO_ROOT", str(tmp_path))
    media = tmp_path / "source.png"
    media.write_bytes(b"local-media")
    frame = StoryboardFrame(
        index=0,
        narration="全画布模板字幕",
        image_prompt="prompt",
        media_type="image",
        image_path=str(media),
        duration=2,
    )
    config = StoryboardConfig(
        media_width=1024,
        media_height=1536,
        task_id="full-bleed-split",
        renderer_version="native-image-html-v2",
        frame_template="1080x1920/f2_morning_radio_v1.html",
        template_snapshot_path=str(
            Path.cwd() / "templates/1080x1920/f2_morning_radio_v1.html"
        ),
        subtitle_effect="fade_up",
    )
    storyboard = Storyboard(title="全画布", config=config, frames=[frame])
    processor = FrameProcessor(object())
    calls: list[tuple[bool, str, str]] = []

    async def fake_compose(
        _frame,
        _storyboard,
        _config,
        output_path,
        transparent_background=False,
        layer_mode="full",
    ):
        calls.append((transparent_background, layer_mode, output_path))
        return output_path

    monkeypatch.setattr(processor, "_compose_frame_html", fake_compose)
    await processor._step_compose_frame(frame, storyboard, config)

    assert [item[:2] for item in calls] == [
        (False, "full"),
        (True, "chrome"),
        (True, "subtitle"),
    ]
    assert frame.overlay_image_path and frame.overlay_image_path.endswith("_overlay.png")
    assert frame.subtitle_effect_applied == "fade_up"


@pytest.mark.parametrize(
    ("effect", "markup", "timeline"),
    [
        ("static", '<p class="subtitle-text">你好 世界</p>', None),
        ("fade_up", '<p class="subtitle-text">你好 世界</p>', 'tl.set("#scene-1-copy p"'),
        ("typewriter", 'class="subtitle-char"', "stagger: { each:"),
        (
            "word_pop",
            '<span class="subtitle-word">你</span><span class="subtitle-word">好</span>',
            'ease: "back.out(1.35)"',
        ),
    ],
)
def test_hyperframes_builds_seek_safe_subtitle_effect(
    tmp_path: Path,
    effect: str,
    markup: str,
    timeline: str | None,
):
    image = tmp_path / "source.png"
    Image.new("RGB", (120, 180), "#27405d").save(image)
    audio = tmp_path / "narration.mp3"
    audio.write_bytes(b"ID3-local-audio")
    runtime = tmp_path / "repo/services/hyperframes-renderer/node_modules/gsap/dist"
    runtime.mkdir(parents=True)
    (runtime / "gsap.min.js").write_text("window.gsap={timeline:()=>({})};", encoding="utf-8")
    storyboard = Storyboard(
        title="字幕动效",
        config=StoryboardConfig(
            media_width=120,
            media_height=180,
            render_engine="hyperframes",
            renderer_version="0.8.4",
            frame_template="1080x1920/image_default.html",
            subtitle_effect=effect,
            subtitle_effect_applied=effect,
        ),
        frames=[
            StoryboardFrame(
                index=0,
                narration="你好 世界",
                image_prompt="prompt",
                audio_path=str(audio),
                media_type="image",
                image_path=str(image),
                duration=2.5,
            )
        ],
    )

    result = HyperFramesProjectBuilder(tmp_path / "repo").build(
        storyboard, tmp_path / "task"
    )
    entry = Path(result.entry_path).read_text(encoding="utf-8")
    manifest = json.loads(Path(result.manifest_path).read_text(encoding="utf-8"))

    assert markup in entry
    assert manifest["subtitle_effect"] == effect
    assert manifest["scenes"][0]["subtitle_effect"] == effect
    if timeline:
        assert timeline in entry
    else:
        assert 'tl.set("#scene-1-copy p"' not in entry
        assert ".subtitle-char" not in entry.split("<body>", 1)[1]


def test_hyperframes_freezes_scene_subtitle_override_keywords_and_window(
    tmp_path: Path,
):
    image = tmp_path / "source.png"
    Image.new("RGB", (120, 180), "#27405d").save(image)
    audio = tmp_path / "narration.mp3"
    audio.write_bytes(b"ID3-local-audio")
    runtime = tmp_path / "repo/services/hyperframes-renderer/node_modules/gsap/dist"
    runtime.mkdir(parents=True)
    (runtime / "gsap.min.js").write_text(
        "window.gsap={timeline:()=>({})};", encoding="utf-8"
    )
    storyboard = Storyboard(
        title="逐镜字幕",
        config=StoryboardConfig(
            media_width=120,
            media_height=180,
            render_engine="hyperframes",
            renderer_version="0.8.4",
            frame_template="1080x1920/image_default.html",
            subtitle_effect="static",
        ),
        frames=[
            StoryboardFrame(
                index=0,
                narration="看见情绪，建立边界感",
                image_prompt="prompt",
                audio_path=str(audio),
                media_type="image",
                image_path=str(image),
                duration=3,
                subtitle_effect="typewriter",
                subtitle_keywords=["情绪", "边界感"],
                subtitle_start_offset=0.25,
                subtitle_end_offset=0.4,
            )
        ],
    )

    result = HyperFramesProjectBuilder(tmp_path / "repo").build(
        storyboard, tmp_path / "task"
    )
    entry = Path(result.entry_path).read_text(encoding="utf-8")
    manifest = json.loads(Path(result.manifest_path).read_text(encoding="utf-8"))
    scene = manifest["scenes"][0]

    assert scene["subtitle_effect"] == "typewriter"
    assert scene["subtitle_effect_applied"] == "typewriter"
    assert scene["subtitle_keywords"] == ["情绪", "边界感"]
    assert scene["subtitle_start_offset"] == 0.25
    assert scene["subtitle_end_offset"] == 0.4
    assert 'class="subtitle-char subtitle-keyword"' in entry
    assert '}, 0.25);' in entry
    assert 'tl.set("#scene-1-copy p", { opacity: 0 }, 2.6);' in entry


def test_word_pop_tokenizer_groups_latin_words_and_splits_chinese_glyphs():
    assert HyperFramesProjectBuilder._subtitle_units("AI explains 中文！") == [
        "AI",
        " ",
        "explains",
        " ",
        "中",
        "文",
        "！",
    ]


def test_hyperframes_no_transition_uses_seek_safe_hard_cut(tmp_path: Path):
    image = tmp_path / "source.png"
    Image.new("RGB", (120, 180), "#27405d").save(image)
    audio = tmp_path / "narration.mp3"
    audio.write_bytes(b"ID3-local-audio")
    runtime = tmp_path / "repo/services/hyperframes-renderer/node_modules/gsap/dist"
    runtime.mkdir(parents=True)
    (runtime / "gsap.min.js").write_text("window.gsap={timeline:()=>({})};", encoding="utf-8")
    storyboard = Storyboard(
        title="直切",
        config=StoryboardConfig(
            media_width=120,
            media_height=180,
            render_engine="hyperframes",
            renderer_version="0.8.4",
            frame_template="1080x1920/image_default.html",
        ),
        frames=[
            StoryboardFrame(
                index=index,
                narration=f"第 {index + 1} 镜",
                image_prompt="prompt",
                audio_path=str(audio),
                media_type="image",
                image_path=str(image),
                duration=2,
                transition="none",
            )
            for index in range(2)
        ],
    )

    result = HyperFramesProjectBuilder(tmp_path / "repo").build(
        storyboard, tmp_path / "task"
    )
    entry = Path(result.entry_path).read_text(encoding="utf-8")

    assert 'tl.set("#scene-2-content", { opacity: 1 }, 2.0);' in entry
    assert 'tl.set("#scene-1-content", { opacity: 0 }, 2.0);' in entry


def test_hyperframes_hides_incoming_animated_subtitle_before_transition_overlap(
    tmp_path: Path,
):
    image = tmp_path / "source.png"
    Image.new("RGB", (120, 180), "#27405d").save(image)
    audio = tmp_path / "narration.mp3"
    audio.write_bytes(b"ID3-local-audio")
    runtime = tmp_path / "repo/services/hyperframes-renderer/node_modules/gsap/dist"
    runtime.mkdir(parents=True)
    (runtime / "gsap.min.js").write_text(
        "window.gsap={timeline:()=>({})};", encoding="utf-8"
    )
    storyboard = Storyboard(
        title="转场字幕",
        config=StoryboardConfig(
            media_width=120,
            media_height=180,
            render_engine="hyperframes",
            renderer_version="0.8.4",
            frame_template="1080x1920/image_default.html",
            subtitle_effect="typewriter",
            subtitle_effect_applied="typewriter",
        ),
        frames=[
            StoryboardFrame(
                index=index,
                narration=f"第{index + 1}镜",
                image_prompt="prompt",
                audio_path=str(audio),
                media_type="image",
                image_path=str(image),
                duration=2,
                transition="none" if index == 0 else "slide_left",
                transition_duration=0.4,
            )
            for index in range(2)
        ],
    )

    result = HyperFramesProjectBuilder(tmp_path / "repo").build(
        storyboard, tmp_path / "task"
    )
    entry = Path(result.entry_path).read_text(encoding="utf-8")

    assert 'tl.set("#scene-2-copy .subtitle-char", { opacity: 0 }, 1.6);' in entry
    assert (
        'tl.to("#scene-2-copy .subtitle-char", { opacity: 1, duration: 0.001,'
        in entry
    )
    assert "}, 2.06);" in entry
