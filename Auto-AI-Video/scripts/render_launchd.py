#!/usr/bin/env python3
"""Render macOS LaunchAgent definitions for API, Studio, Runner, and backups."""

from __future__ import annotations

import argparse
import plistlib
from pathlib import Path


def render(project_root: Path, output_dir: Path) -> list[Path]:
    root = project_root.expanduser().resolve()
    output = output_dir.expanduser().resolve()
    output.mkdir(parents=True, exist_ok=True)
    logs = root / "data" / "logs"
    logs.mkdir(parents=True, exist_ok=True)
    uv = root / ".venv" / "bin" / "python"
    npm = "/usr/bin/env"
    definitions = {
        "com.pixelle.api.plist": {
            "Label": "com.pixelle.api",
            "ProgramArguments": [
                str(uv),
                "api/app.py",
                "--host",
                "127.0.0.1",
                "--port",
                "18123",
            ],
            "WorkingDirectory": str(root),
            "RunAtLoad": True,
            "KeepAlive": True,
            "ThrottleInterval": 10,
        },
        "com.pixelle.runner.plist": {
            "Label": "com.pixelle.runner",
            "ProgramArguments": [
                str(uv),
                "scripts/run_production.py",
                "--config",
                "production/runner.yaml",
                "run",
            ],
            "WorkingDirectory": str(root),
            "RunAtLoad": True,
            "KeepAlive": True,
            "ThrottleInterval": 30,
        },
        "com.pixelle.studio.plist": {
            "Label": "com.pixelle.studio",
            "ProgramArguments": [npm, "npm", "run", "start", "--", "--port", "13123"],
            "WorkingDirectory": str(root / "studio"),
            "EnvironmentVariables": {
                "PIXELLE_API_URL": "http://127.0.0.1:18123",
                "PATH": "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
            },
            "RunAtLoad": True,
            "KeepAlive": True,
            "ThrottleInterval": 10,
        },
        "com.pixelle.backup.plist": {
            "Label": "com.pixelle.backup",
            "ProgramArguments": [
                str(uv),
                "scripts/production_ops.py",
                "--config",
                "production/runner.yaml",
                "backup",
                "--app-config",
                "config.yaml",
            ],
            "WorkingDirectory": str(root),
            "StartCalendarInterval": {"Hour": 3, "Minute": 10},
        },
    }
    rendered = []
    for filename, definition in definitions.items():
        label = definition["Label"].removeprefix("com.pixelle.")
        definition["StandardOutPath"] = str(logs / f"{label}.log")
        definition["StandardErrorPath"] = str(logs / f"{label}.error.log")
        path = output / filename
        with path.open("wb") as handle:
            plistlib.dump(definition, handle, sort_keys=False)
        rendered.append(path)
    return rendered


def main() -> int:
    parser = argparse.ArgumentParser(description="Render Pixelle macOS LaunchAgents")
    parser.add_argument("--project-root", default=str(Path(__file__).resolve().parent.parent))
    parser.add_argument("--output", default="data/launchd")
    args = parser.parse_args()
    paths = render(Path(args.project_root), Path(args.output))
    for path in paths:
        print(path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
