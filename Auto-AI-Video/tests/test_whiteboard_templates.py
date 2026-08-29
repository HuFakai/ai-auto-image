from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from api.app import app
from pixelle_video.whiteboard.templates import WhiteboardTemplateRegistry


def test_whiteboard_registry_keeps_all_cs_board_visual_presets():
    templates = WhiteboardTemplateRegistry().list()
    assert len(templates) == 12
    assert {item.template_id for item in templates} == {
        "minimal-whiteboard",
        "business-doodle",
        "warm-pencil",
        "guofeng-flat",
        "viral-pop",
        "black-gold-tech",
        "healing-journal",
        "retro-collage",
        "paper-metaphor",
        "comic-ink-explainer",
        "clay-3d",
        "cyber-neon",
    }
    assert all(item.preview_path.is_file() for item in templates)
    assert all(len(item.fingerprint) == 64 for item in templates)


def test_whiteboard_config_resolves_template_owned_prompt_and_profile():
    resolved = WhiteboardTemplateRegistry().resolve(
        {"template_id": "black-gold-tech", "template_version": 1, "hand_enabled": False}
    )
    assert resolved["render_profile"]["background_mode"] == "dark"
    assert resolved["render_profile"]["path_mode"] == "edge"
    assert resolved["hand_enabled"] is False
    assert "深黑" in resolved["prompt_recipe"]


def test_whiteboard_registry_rejects_unknown_template():
    with pytest.raises(FileNotFoundError):
        WhiteboardTemplateRegistry().load("html-template", 1)


def test_whiteboard_template_api_serves_registry_and_real_preview():
    client = TestClient(app)
    response = client.get("/api/resources/whiteboard/templates")
    assert response.status_code == 200
    templates = response.json()["templates"]
    assert len(templates) == 12
    selected = templates[0]
    preview = client.get(
        f"/api/resources/whiteboard/templates/{selected['template_id']}/versions/"
        f"{selected['version']}/preview"
    )
    assert preview.status_code == 200
    assert preview.headers["content-type"].startswith("image/")
    assert len(preview.content) > 1000


def test_whiteboard_preview_cannot_escape_asset_root(tmp_path: Path):
    registry = WhiteboardTemplateRegistry(tmp_path)
    registry.registry_path.parent.mkdir(parents=True)
    registry.registry_path.write_text(
        "schema_version: 1\ntemplates:\n"
        "  - id: bad\n    version: 1\n    name: bad\n    description: bad\n"
        "    preview: ../secret.png\n    prompt_recipe: bad\n",
        encoding="utf-8",
    )
    (tmp_path.parent / "secret.png").write_bytes(b"secret")
    with pytest.raises(ValueError, match="Invalid whiteboard preview"):
        registry.list()
