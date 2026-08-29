from pathlib import Path

import cv2
import numpy as np
from PIL import Image

from pixelle_video.whiteboard.renderer import WhiteboardRenderer
from pixelle_video.whiteboard.subtitle import render_whiteboard_subtitle


def _source(path: Path) -> None:
    image = np.full((568, 320, 3), 246, dtype=np.uint8)
    cv2.circle(image, (160, 190), 72, (20, 20, 20), 8)
    cv2.line(image, (92, 330), (228, 330), (30, 90, 220), 16)
    encoded, payload = cv2.imencode(path.suffix, image)
    assert encoded
    payload.tofile(str(path))


def test_whiteboard_analysis_is_deterministic(tmp_path: Path):
    source = tmp_path / "source.png"
    _source(source)
    renderer = WhiteboardRenderer()
    image = renderer._read_image(source)
    normalized, _ = renderer._normalize_canvas(image, 320, 568, {"background_mode": "light"})
    mask, dark = renderer._edge_mask(normalized, {"background_mode": "light"})
    first = renderer._ordered_points(mask, "skeleton", {"stroke_detail": "standard"})
    second = renderer._ordered_points(mask, "skeleton", {"stroke_detail": "standard"})
    assert dark is False
    assert first == second
    assert len(first) > 24


def test_whiteboard_subtitle_is_independent_transparent_layer(tmp_path: Path):
    target = tmp_path / "subtitle.png"
    render_whiteboard_subtitle(
        "稳定生产来自清晰流程",
        ["清晰流程"],
        target,
        width=320,
        height=568,
    )
    image = Image.open(target).convert("RGBA")
    assert image.size == (320, 568)
    assert image.getchannel("A").getbbox() is not None
    assert image.getpixel((0, 0))[3] == 0


def test_whiteboard_renderer_produces_real_seekable_mp4(tmp_path: Path):
    source = tmp_path / "source.png"
    output = tmp_path / "whiteboard.mp4"
    analysis = tmp_path / "whiteboard.analysis.json"
    _source(source)

    path, report = WhiteboardRenderer().render(
        image_path=source,
        output_path=output,
        duration=0.75,
        width=320,
        height=568,
        fps=8,
        settings={
            "render_profile": {
                "background_mode": "light",
                "path_mode": "skeleton",
                "stroke_detail": "light",
            },
            "hand_enabled": True,
            "fallback_policy": "grid",
        },
        analysis_path=analysis,
    )

    capture = cv2.VideoCapture(path)
    try:
        assert capture.isOpened()
        assert int(capture.get(cv2.CAP_PROP_FRAME_WIDTH)) == 320
        assert int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT)) == 568
        assert int(capture.get(cv2.CAP_PROP_FRAME_COUNT)) >= 5
    finally:
        capture.release()
    assert output.stat().st_size > 1000
    assert analysis.is_file()
    assert report.path_points > 24
