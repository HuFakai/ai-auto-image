import json
from pathlib import Path

import pytest
from fastapi import HTTPException
from PIL import Image

from api.routers.resources import preview_hyperframes_template
from api.schemas.resources import (
    HyperFramesTemplateInfo,
    HyperFramesTemplatePreviewRequest,
)
from pixelle_video.services.frame_html import HTMLFrameGenerator
from pixelle_video.services.template_packs import TemplatePackRegistry, _build_preview_html


def test_f2_registry_publishes_six_versioned_templates():
    packs = TemplatePackRegistry().list()

    assert {(pack.template_id, pack.version) for pack in packs} == {
        ("stickman-psychology", 1),
        ("morning-radio", 1),
        ("knowledge-card", 1),
        ("cinematic-documentary", 1),
        ("paper-editorial", 1),
        ("neon-data", 1),
    }
    for pack in packs:
        assert len(pack.fingerprint) == 64
        assert Path("templates", pack.native_template).is_file()
        assert pack.resolve_variables()["brand_label"]
        assert pack.preview_width == 1080
        assert pack.preview_height == 1920
        assert set(pack.variables) == {
            "accent_color",
            "surface_color",
            "text_color",
            "brand_label",
            "eyebrow_label",
            "card_opacity",
        }
        native_document = Path("templates", pack.native_template).read_text(encoding="utf-8")
        assert (
            'data-pixelle-media-layer="full-canvas"' in native_document
            or 'data-pixelle-media-layer="inset"' in native_document
        )
        assert 'data-pixelle-safe="subtitle"' in native_document


def test_template_metadata_contains_inert_self_contained_actual_preview():
    for pack in TemplatePackRegistry().list():
        metadata = pack.public_metadata()
        model = HyperFramesTemplateInfo(**metadata)

        assert model.preview_html == pack.preview_html
        assert "data:image/svg+xml;base64," in model.preview_html
        assert "Content-Security-Policy" in model.preview_html
        assert "{{" not in model.preview_html
        assert "<script" not in model.preview_html.lower()
        assert "src=\"http" not in model.preview_html.lower()
        assert f"<title>{pack.display_name}" in model.preview_html
        assert pack.native_template.endswith(".html")


def test_template_preview_escapes_variables_and_removes_active_remote_content():
    preview = _build_preview_html(
        """<html><head><link href="https://evil.example/a.css"></head>
        <body onload="alert(1)"><script>alert(1)</script>
        <img src="//evil.example/a.png"><p>{{brand_label:text=栏目}}</p></body></html>""",
        {"brand_label": "</p><img src=x onerror=alert(1)>"},
        category="general",
    )

    assert "evil.example" not in preview
    assert "onload" not in preview
    assert "onerror" not in preview
    assert "<script" not in preview.lower()
    assert "&lt;/p&gt;&lt;img" in preview


@pytest.mark.asyncio
async def test_live_template_preview_applies_validated_variables():
    response = await preview_hyperframes_template(
        "cinematic-documentary",
        1,
        HyperFramesTemplatePreviewRequest(
            variables={
                "accent_color": "#12ABEF",
                "brand_label": "山河档案",
                "card_opacity": 0.63,
            }
        ),
    )

    assert response.variables["accent_color"] == "#12ABEF"
    assert response.variables["brand_label"] == "山河档案"
    assert response.variables["card_opacity"] == 0.63
    assert "#12ABEF" in response.preview_html
    assert "山河档案" in response.preview_html
    assert "rgba(17,16,14,0.63)" in response.preview_html
    assert "{{" not in response.preview_html


@pytest.mark.asyncio
async def test_live_template_preview_rejects_unknown_variables():
    with pytest.raises(HTTPException) as caught:
        await preview_hyperframes_template(
            "neon-data",
            1,
            HyperFramesTemplatePreviewRequest(variables={"raw_css": "display:none"}),
        )

    assert caught.value.status_code == 422
    assert "Unknown variables" in str(caught.value.detail)


def test_template_variables_are_typed_and_reject_unknown_values():
    pack = TemplatePackRegistry().load("knowledge-card", 1)

    resolved = pack.resolve_variables(
        {"accent_color": "#12ABEF", "card_opacity": "0.72"}
    )
    assert resolved["accent_color"] == "#12ABEF"
    assert resolved["card_opacity"] == 0.72

    with pytest.raises(ValueError, match="Unknown variables"):
        pack.resolve_variables({"raw_css": "body { display: none }"})
    with pytest.raises(ValueError, match="accent_color"):
        pack.resolve_variables({"accent_color": "red; background: black"})
    with pytest.raises(ValueError, match="card_opacity"):
        pack.resolve_variables({"card_opacity": 2})


def test_native_template_parameters_match_pack_defaults():
    for pack in TemplatePackRegistry().list():
        generator = HTMLFrameGenerator(str(Path("templates") / pack.native_template))
        parameters = generator.parse_template_parameters()
        defaults = pack.resolve_variables()

        for name, value in defaults.items():
            assert parameters[name]["default"] == value


def test_cinematic_documentary_protects_top_copy_contrast():
    css = TemplatePackRegistry().load("cinematic-documentary", 1).css

    assert "rgba(5,4,3,.62) 0%" in css
    assert "rgba(5,4,3,.5) 24%" in css
    assert "transparent 42%" in css


@pytest.mark.asyncio
async def test_f2_native_templates_render_inside_safe_area(tmp_path: Path):
    source = tmp_path / "source.png"
    Image.new("RGB", (1024, 1536), "#54766c").save(source)

    try:
        for pack in TemplatePackRegistry().list():
            output = tmp_path / f"{pack.template_id}.png"
            generator = HTMLFrameGenerator(str(Path("templates") / pack.native_template))
            await generator.generate_frame(
                "这是一条用于验证模板安全区的标题",
                "正文需要保持清晰可读，并且不能超出竖屏视频的文字安全区域。",
                str(source),
                ext={**pack.resolve_variables(), "index": 2, "progress_percent": 40},
                output_path=str(output),
            )
            layout = json.loads(output.with_suffix(".layout.json").read_text(encoding="utf-8"))
            assert output.stat().st_size > 0
            assert layout["elements"]
            assert all(item["in_safe_area"] for item in layout["elements"]), layout
    finally:
        await HTMLFrameGenerator.close_browser()
