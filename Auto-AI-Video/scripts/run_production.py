#!/usr/bin/env python3
"""CLI for the durable production runner."""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

os.environ.setdefault("PIXELLE_VIDEO_ROOT", str(PROJECT_ROOT))
from pixelle_video.utils.os_util import ensure_local_ffmpeg_on_path  # noqa: E402

ensure_local_ffmpeg_on_path()

from pixelle_video.production import ProductionRunner, load_runner_config  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(description="Run continuous Pixelle video production")
    parser.add_argument(
        "--config", default="production/runner.yaml", help="Runner YAML path"
    )
    subparsers = parser.add_subparsers(dest="command", required=True)
    subparsers.add_parser("once", help="Run one reconciliation cycle")
    subparsers.add_parser("run", help="Keep reconciling forever")
    subparsers.add_parser("status", help="Show durable inventory status")
    publish = subparsers.add_parser("publish", help="Mark ready videos as published")
    publish.add_argument("--channel", required=True)
    publish.add_argument("--count", type=int, default=1)
    args = parser.parse_args()

    runner = ProductionRunner(load_runner_config(args.config))
    try:
        if args.command == "run":
            runner.run_forever()
            return 0
        if args.command == "once":
            result = runner.run_once()
        elif args.command == "status":
            result = runner.status()
        else:
            if args.count < 1:
                parser.error("--count must be at least 1")
            result = runner.publish(args.channel, args.count)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    finally:
        if args.command != "run":
            runner.close()


if __name__ == "__main__":
    raise SystemExit(main())
