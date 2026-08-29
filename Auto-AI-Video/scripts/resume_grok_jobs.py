"""Resume persisted grok2api video jobs without resubmitting generation."""

import json
import sys

from pixelle_video.config import config_manager
from pixelle_video.services.api_services.grok_client import GrokClient


def main() -> int:
    results = []
    for channel_id, grok in _configured_grok_channels():
        local_proxy = (
            config_manager.config.runtime.local_proxy if grok.get("use_proxy") else None
        )
        client = GrokClient(
            api_key=grok.get("api_key") or "",
            base_url=grok.get("base_url") or "",
            local_proxy=local_proxy,
            job_store_dir=grok.get("job_store_dir") or f"data/model_jobs/{channel_id}",
            request_timeout=float(grok.get("request_timeout", 300.0)),
            poll_interval=float(grok.get("poll_interval", 5.0)),
            poll_timeout=float(grok.get("poll_timeout", 1800.0)),
            retry_count=int(grok.get("retry_count", 3)),
        )
        try:
            channel_results = client.resume_pending_jobs()
            results.extend({"channel_id": channel_id, **result} for result in channel_results)
        finally:
            client.close()

    print(json.dumps({"resumed": len(results), "results": results}, ensure_ascii=False, indent=2))
    return 1 if any(result["status"] == "error" for result in results) else 0


def _configured_grok_channels() -> list[tuple[str, dict]]:
    channels = [
        (channel_id, channel.model_dump())
        for channel_id, channel in config_manager.config.model_settings.channels.items()
        if channel.enabled and channel.api_format == "grok2api"
    ]
    return channels


if __name__ == "__main__":
    sys.exit(main())
