from pathlib import Path

from PIL import Image, ImageDraw

from pixelle_video.services.focal_point import cover_crop, detect_focal_point


def test_local_detector_finds_off_centre_subject(tmp_path: Path):
    image_path = tmp_path / "off-centre.png"
    image = Image.new("RGB", (800, 450), "#d8d8d8")
    draw = ImageDraw.Draw(image)
    draw.ellipse((610, 110, 760, 310), fill="#161616", outline="#ff3b30", width=12)
    image.save(image_path)

    focus = detect_focal_point(image_path)

    assert focus.x > 0.7
    assert 0.35 < focus.y < 0.65
    assert focus.confidence > 0
    assert focus.source == "local_saliency_v1"


def test_cover_crop_keeps_right_hand_subject_in_vertical_frame():
    crop = cover_crop(1600, 900, 1080, 1920, 0.88, 0.5)

    assert crop.scaled_width > 1080
    assert crop.scaled_height == 1920
    assert crop.crop_x > (crop.scaled_width - 1080) / 2
    assert 0 <= crop.crop_x <= crop.scaled_width - 1080
    assert 0 <= crop.focus_x <= 1
    assert 0 <= crop.focus_y <= 1


def test_uniform_image_uses_stable_centre_fallback(tmp_path: Path):
    image_path = tmp_path / "flat.png"
    Image.new("RGB", (320, 180), "#334455").save(image_path)

    first = detect_focal_point(image_path)
    second = detect_focal_point(image_path)

    assert first == second
    assert first.x == first.y == 0.5
    assert first.source == "center_fallback"
