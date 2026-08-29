from pathlib import Path

import pytest
from PIL import Image

from pixelle_video.services.frame_html import HTMLFrameGenerator, TrustedHTML
from pixelle_video.utils.template_util import (
    resolve_template_fingerprint,
    snapshot_template_for_task,
    template_media_layer_mode,
    template_supports_layered_background,
)


def test_f2_templates_declare_inset_media_contract():
    for name in (
        "f2_knowledge_card_v1.html",
        "f2_neon_data_v1.html",
        "f2_paper_editorial_v1.html",
        "f2_stickman_psychology_v1.html",
    ):
        template = f"templates/1080x1920/{name}"
        assert template_media_layer_mode(template) == "inset"
        assert template_supports_layered_background(template) is False


def test_f2_full_bleed_templates_keep_separable_media_contract():
    for name in ("f2_cinematic_documentary_v1.html", "f2_morning_radio_v1.html"):
        template = f"templates/1080x1920/{name}"
        assert template_media_layer_mode(template) == "full-canvas"
        assert template_supports_layered_background(template) is True


def test_template_parameters_escape_user_html_and_allow_only_trusted_markup(tmp_path: Path):
    template = tmp_path / "320x568" / "safe.html"
    template.parent.mkdir()
    template.write_text(
        '<h1>{{title}}</h1><p>{{text}}</p><b>{{brand_label:text=Brand}}</b>',
        encoding="utf-8",
    )
    generator = HTMLFrameGenerator(str(template))

    rendered = generator._replace_parameters(
        generator.template,
        {
            "title": '<img src=x onerror="alert(1)">',
            "text": TrustedHTML("<mark>已转义的受控强调</mark>"),
            "brand_label": "</b><script>fetch('https://example.com')</script>",
        },
    )

    assert "<script>" not in rendered
    assert "<img " not in rendered
    assert '&lt;img src=x onerror=&quot;' in rendered
    assert "&lt;script&gt;" in rendered
    assert "<mark>已转义的受控强调</mark>" in rendered


@pytest.mark.asyncio
async def test_close_browser_is_best_effort_and_clears_shared_references():
    class BrokenBrowser:
        async def close(self):
            raise RuntimeError("browser connection already closed")

    class BrokenPlaywright:
        async def stop(self):
            raise RuntimeError("driver connection already closed")

    HTMLFrameGenerator._browser = BrokenBrowser()
    HTMLFrameGenerator._playwright = BrokenPlaywright()
    HTMLFrameGenerator._browser_loop = object()

    await HTMLFrameGenerator.close_browser()

    assert HTMLFrameGenerator._browser is None
    assert HTMLFrameGenerator._playwright is None
    assert HTMLFrameGenerator._browser_loop is None


def test_template_fingerprint_rejects_content_drift(tmp_path: Path):
    template_dir = tmp_path / "320x568"
    template_dir.mkdir()
    template = template_dir / "layered.html"
    template.write_text("<html><body>v1</body></html>", encoding="utf-8")
    _, frozen = resolve_template_fingerprint(str(template))

    template.write_text("<html><body>v2</body></html>", encoding="utf-8")

    with pytest.raises(RuntimeError, match="changed after the task was created"):
        resolve_template_fingerprint(str(template), frozen)


def test_task_template_snapshot_survives_source_changes(tmp_path: Path):
    template_dir = tmp_path / "source" / "320x568"
    template_dir.mkdir(parents=True)
    template = template_dir / "layered.html"
    template.write_text("<html><body>v1</body></html>", encoding="utf-8")
    task_dir = tmp_path / "task"

    snapshot, frozen = snapshot_template_for_task(str(template), task_dir)
    template.write_text("<html><body>v2</body></html>", encoding="utf-8")
    recovered, recovered_hash = snapshot_template_for_task(
        str(template),
        task_dir,
        frozen,
    )

    assert recovered == snapshot
    assert recovered_hash == frozen
    assert Path(recovered).read_text(encoding="utf-8") == "<html><body>v1</body></html>"


@pytest.mark.asyncio
async def test_transparent_frame_keeps_text_and_removes_media_layer(tmp_path: Path):
    template_dir = tmp_path / "320x568"
    template_dir.mkdir()
    template = template_dir / "layered.html"
    template.write_text(
        """<!doctype html>
<html><head><style>
html,body{width:320px;height:568px;margin:0}
body{background:#d22;display:grid;place-items:center}
#label{color:#00ff00;font:700 48px sans-serif}
</style></head><body data-pixelle-media-layer="full-canvas"><div id="label">TEXT</div></body></html>
""",
        encoding="utf-8",
    )
    _, fingerprint = resolve_template_fingerprint(str(template))
    assert template_supports_layered_background(str(template)) is True
    generator = HTMLFrameGenerator(str(template), expected_sha256=fingerprint)
    full = tmp_path / "full.png"
    overlay = tmp_path / "overlay.png"

    try:
        await generator.generate_frame("", "", "", output_path=str(full))
        await generator.generate_frame(
            "",
            "",
            "",
            output_path=str(overlay),
            transparent_background=True,
        )
    finally:
        await HTMLFrameGenerator.close_browser()

    with Image.open(full).convert("RGBA") as full_image:
        assert full_image.getpixel((0, 0))[3] == 255
    with Image.open(overlay).convert("RGBA") as overlay_image:
        alpha = overlay_image.getchannel("A")
        assert alpha.getpixel((0, 0)) == 0
        assert alpha.getextrema() == (0, 255)


@pytest.mark.asyncio
async def test_video_default_template_places_downloaded_image_in_media_panel(tmp_path: Path):
    source = tmp_path / "downloaded.png"
    Image.new("RGB", (480, 270), (20, 190, 80)).save(source)
    template, fingerprint = resolve_template_fingerprint(
        "1080x1920/video_default.html"
    )
    output = tmp_path / "composed.png"
    generator = HTMLFrameGenerator(template, expected_sha256=fingerprint)

    try:
        await generator.generate_frame(
            "图片已应用",
            "下载后的图片必须进入合成画面",
            str(source),
            output_path=str(output),
        )
    finally:
        await HTMLFrameGenerator.close_browser()

    with Image.open(output).convert("RGB") as composed:
        red, green, blue = composed.getpixel((540, 960))
        assert green > 150
        assert green > red * 3
        assert green > blue * 2
