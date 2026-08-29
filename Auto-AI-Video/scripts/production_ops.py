#!/usr/bin/env python3
"""Operational CLI for readiness checks and consistent production backups."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from pixelle_video.production.ops import (  # noqa: E402
    create_production_backup,
    inspect_operational_health,
    verify_production_backup,
)


def main() -> int:
    parser = argparse.ArgumentParser(description="Operate durable Pixelle production")
    parser.add_argument("--config", default="production/runner.yaml")
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("check", help="Run local readiness checks without production writes")
    backup = commands.add_parser("backup", help="Create a consistent private backup")
    backup.add_argument("--app-config", default="config.yaml")
    verify = commands.add_parser("verify", help="Verify one backup manifest and database")
    verify.add_argument("path")
    args = parser.parse_args()

    if args.command == "check":
        result = inspect_operational_health(args.config)
        exit_code = 0 if result["ready"] else 1
    elif args.command == "backup":
        result = create_production_backup(args.config, args.app_config)
        verification = verify_production_backup(result["backup"])
        result["verification"] = verification
        exit_code = 0 if verification["valid"] else 1
    else:
        result = verify_production_backup(args.path)
        exit_code = 0 if result["valid"] else 1
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
