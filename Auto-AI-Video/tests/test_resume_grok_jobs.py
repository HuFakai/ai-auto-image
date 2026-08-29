from pixelle_video.config import config_manager
from pixelle_video.config.schema import PixelleVideoConfig
from scripts import resume_grok_jobs


def test_resume_uses_every_enabled_grok2api_channel(monkeypatch, capsys, tmp_path):
    config = PixelleVideoConfig.model_validate(
        {
            "model_settings": {
                "channels": {
                    "first": {
                        "name": "First",
                        "api_format": "grok2api",
                        "base_url": "https://first.example.com/v1",
                        "api_key": "first-key",
                        "models": {"video": ["video-one"]},
                        "job_store_dir": str(tmp_path / "first"),
                    },
                    "second": {
                        "name": "Second",
                        "api_format": "grok2api",
                        "base_url": "https://second.example.com/v1",
                        "api_key": "second-key",
                        "models": {"video": ["video-two"]},
                        "job_store_dir": str(tmp_path / "second"),
                    },
                    "disabled": {
                        "name": "Disabled",
                        "api_format": "grok2api",
                        "base_url": "https://disabled.example.com/v1",
                        "api_key": "disabled-key",
                        "enabled": False,
                    },
                }
            }
        }
    )
    monkeypatch.setattr(config_manager, "config", config)
    created = []

    class FakeClient:
        def __init__(self, **options):
            self.options = options
            created.append(self)

        def resume_pending_jobs(self):
            return [{"job_key": "job", "status": "completed"}]

        def close(self):
            pass

    monkeypatch.setattr(resume_grok_jobs, "GrokClient", FakeClient)

    assert resume_grok_jobs.main() == 0

    assert [client.options["api_key"] for client in created] == ["first-key", "second-key"]
    output = capsys.readouterr().out
    assert '"channel_id": "first"' in output
    assert '"channel_id": "second"' in output
    assert "first-key" not in output
    assert "second-key" not in output


def test_resume_without_configured_grok_channel_is_a_noop(monkeypatch, capsys):
    monkeypatch.setattr(config_manager, "config", PixelleVideoConfig())

    assert resume_grok_jobs.main() == 0
    assert '"resumed": 0' in capsys.readouterr().out
