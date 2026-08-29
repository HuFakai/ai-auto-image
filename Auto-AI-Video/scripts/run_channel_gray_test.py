#!/usr/bin/env python3
"""Submit and observe a bounded, single-channel production gray test."""

from __future__ import annotations

import argparse
import json
import sys
import time
from copy import deepcopy
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import httpx

PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from pixelle_video.config import config_manager  # noqa: E402
from pixelle_video.production import load_runner_config  # noqa: E402
from pixelle_video.production.presets import resolve_channel_request  # noqa: E402
from pixelle_video.production.store import ProductionStore  # noqa: E402
from pixelle_video.rendering_versions import HYPERFRAMES_RENDERER_VERSION  # noqa: E402

TERMINAL_STATUSES = {"completed", "failed", "cancelled"}


def main() -> int:
    args = _parse_args()
    config = load_runner_config(args.config)
    channel = next((item for item in config.channels if item.id == args.channel), None)
    if channel is None:
        raise SystemExit(f"未知频道：{args.channel}")

    run_id = args.run_id or f"{args.channel}-{datetime.now().strftime('%Y%m%d-%H%M%S')}"
    report_path = PROJECT_ROOT / "data" / "gray-tests" / f"{run_id}.json"
    report = _load_or_create_report(report_path, run_id, channel.id, args)
    _write_report(report_path, report)

    store = ProductionStore(config.database_path)
    client = httpx.Client(
        base_url=args.api_base_url or config.api_base_url.rstrip("/"),
        timeout=args.request_timeout,
        trust_env=False,
    )
    try:
        seed = channel.topic.seeds[0] if channel.topic.seeds else channel.name
        base_request = resolve_channel_request(store, channel, seed, f"[灰度] {channel.name}")
        image_selection = config_manager.resolve_model("image")
        image_workflow = f"api/{image_selection['channel_id']}/{image_selection['model']}"
        requests = [
            _build_request(
                base_request,
                channel,
                index,
                args.engine,
                args.allow_native_fallback,
                image_workflow,
            )
            for index in range(1, args.count + 1)
        ]
        _run_gray_test(client, requests, report, report_path, args)
    except KeyboardInterrupt:
        report["status"] = "interrupted"
        report["completed_at"] = _now()
        report["summary"] = _summarize(report["tasks"], args)
        _write_report(report_path, report)
        print(f"灰度测试已中断，进度已保存：{report_path}", file=sys.stderr)
        return 130
    finally:
        client.close()
        store.close()

    summary = _summarize(report["tasks"], args)
    report["summary"] = summary
    report["status"] = "passed" if summary["passed"] else "failed"
    report["completed_at"] = _now()
    _write_report(report_path, report)
    print(json.dumps({**summary, "report": str(report_path)}, ensure_ascii=False, indent=2))
    return 0 if summary["passed"] else 1


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="执行 20 条单频道生产灰度测试")
    parser.add_argument("--channel", required=True, help="频道 ID")
    parser.add_argument("--config", default="production/runner.yaml")
    parser.add_argument("--api-base-url", default=None)
    parser.add_argument("--count", type=int, default=20)
    parser.add_argument("--max-in-flight", type=int, default=2)
    parser.add_argument("--poll-seconds", type=float, default=2.0)
    parser.add_argument("--timeout-seconds", type=int, default=14400)
    parser.add_argument("--request-timeout", type=float, default=30.0)
    parser.add_argument("--run-id", default=None)
    parser.add_argument(
        "--max-task-retries",
        type=int,
        default=2,
        help="失败任务沿用同一任务 ID 和已有检查点的最大重试次数",
    )
    parser.add_argument(
        "--resume",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="同一 run-id 已有报告时继续接管，而不是覆盖进度",
    )
    parser.add_argument(
        "--engine",
        choices=("channel", "hyperframes"),
        default="channel",
        help="使用频道配置，或强制指定渲染器",
    )
    parser.add_argument(
        "--allow-native-fallback",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="HyperFrames 失败时是否允许原生引擎接管",
    )
    parser.add_argument(
        "--require-engine",
        action="store_true",
        help="实际渲染器必须等于请求渲染器；用于 HyperFrames 独立验收",
    )
    args = parser.parse_args()
    if not 1 <= args.count <= 100:
        parser.error("--count 必须在 1 到 100 之间")
    if not 1 <= args.max_in_flight <= 8:
        parser.error("--max-in-flight 必须在 1 到 8 之间")
    if args.poll_seconds < 0.2:
        parser.error("--poll-seconds 不能小于 0.2")
    if not 0 <= args.max_task_retries <= 10:
        parser.error("--max-task-retries 必须在 0 到 10 之间")
    return args


def _load_or_create_report(
    path: Path,
    run_id: str,
    channel_id: str,
    args: argparse.Namespace,
) -> dict[str, Any]:
    if args.resume and path.is_file():
        existing = json.loads(path.read_text(encoding="utf-8"))
        expected = {
            "run_id": run_id,
            "channel_id": channel_id,
            "requested_engine": args.engine,
            "require_engine": args.require_engine,
            "count": args.count,
        }
        mismatches = [key for key, value in expected.items() if existing.get(key) != value]
        if mismatches:
            raise ValueError("已有灰度报告与当前参数不一致：" + ", ".join(mismatches))
        existing.update(
            status="running",
            completed_at=None,
            max_in_flight=args.max_in_flight,
            max_task_retries=args.max_task_retries,
        )
        existing.setdefault("tasks", [])
        existing.setdefault("summary", {})
        return existing
    return {
        "run_id": run_id,
        "channel_id": channel_id,
        "requested_engine": args.engine,
        "require_engine": args.require_engine,
        "count": args.count,
        "max_in_flight": args.max_in_flight,
        "max_task_retries": args.max_task_retries,
        "started_at": _now(),
        "completed_at": None,
        "status": "running",
        "tasks": [],
        "summary": {},
    }


def _build_request(
    base_request: dict[str, Any],
    channel: Any,
    index: int,
    engine: str,
    allow_native_fallback: bool,
    image_workflow: str,
) -> dict[str, Any]:
    request = deepcopy(base_request)
    seeds = channel.topic.seeds
    seed = seeds[(index - 1) % len(seeds)] if seeds else channel.name
    request["text"] = f"{seed}（灰度样本 {index:02d}）"
    request["title"] = f"[灰度 {index:02d}] {seed}"
    if engine == "channel":
        requested = str(request.get("render_engine") or "hyperframes")
    else:
        requested = engine
        request["production_mode"] = engine
        request["render_engine"] = engine
        request["renderer_version"] = (
            HYPERFRAMES_RENDERER_VERSION if engine == "hyperframes" else "native-image-html-v2"
        )
        request["media_workflow"] = image_workflow
    if requested == "hyperframes":
        settings = dict(request.get("hyperframes") or {})
        settings["fallback_to_native"] = allow_native_fallback
        request["hyperframes"] = settings
    request.setdefault("_production", {})["gray_test"] = {
        "sample": index,
        "requested_engine": requested,
    }
    return request


def _run_gray_test(
    client: httpx.Client,
    requests: list[dict[str, Any]],
    report: dict[str, Any],
    report_path: Path,
    args: argparse.Namespace,
) -> None:
    known_samples = {int(item["sample"]) for item in report["tasks"]}
    pending = [
        (index, request)
        for index, request in enumerate(requests, start=1)
        if index not in known_samples
    ]
    active: dict[str, dict[str, Any]] = {}
    for entry in list(report["tasks"]):
        task_id = str(entry.get("task_id") or "")
        if not task_id or entry.get("status") == "completed":
            continue
        response = client.get(f"/api/tasks/{task_id}")
        if response.status_code == 404:
            report["tasks"].remove(entry)
            pending.append((int(entry["sample"]), requests[int(entry["sample"]) - 1]))
            continue
        response.raise_for_status()
        _update_entry(entry, response.json())
        if entry["status"] == "failed" and _retry_entry(client, entry, args):
            active[task_id] = entry
        elif entry["status"] not in TERMINAL_STATUSES:
            active[task_id] = entry
    pending.sort(key=lambda item: item[0])
    _write_report(report_path, report)
    deadline = time.monotonic() + args.timeout_seconds
    while pending or active:
        while pending and len(active) < args.max_in_flight:
            index, request = pending.pop(0)
            response = client.post(
                "/api/video/generate/async",
                json=request,
                headers={"Idempotency-Key": f"gray:{report['run_id']}:{index}"},
            )
            response.raise_for_status()
            task_id = str(response.json()["task_id"])
            entry = {
                "sample": index,
                "task_id": task_id,
                "topic": request["text"],
                "requested_engine": request.get("render_engine"),
                "status": "pending",
                "progress": 0,
                "message": "任务已提交",
                "actual_engine": None,
                "fallback_reason": None,
                "error": None,
                "output_url": None,
                "retry_count": 0,
            }
            report["tasks"].append(entry)
            active[task_id] = entry
            _write_report(report_path, report)
            print(f"[{index}/{args.count}] 已提交 {task_id}")

        if time.monotonic() >= deadline:
            for entry in active.values():
                entry["status"] = "timed_out"
                entry["error"] = "灰度测试等待超时；服务端任务未被取消"
            _write_report(report_path, report)
            return

        for task_id, entry in list(active.items()):
            response = client.get(f"/api/tasks/{task_id}")
            response.raise_for_status()
            task = response.json()
            _update_entry(entry, task)
            if entry["status"] not in TERMINAL_STATUSES:
                continue
            if entry["status"] == "failed" and _retry_entry(client, entry, args):
                print(
                    f"[{entry['sample']}/{args.count}] 失败后从检查点重试 "
                    f"{entry['retry_count']}/{args.max_task_retries}"
                )
                continue
            active.pop(task_id)
            print(
                f"[{entry['sample']}/{args.count}] {entry['status']} "
                f"engine={entry['actual_engine'] or '-'} {entry['message']}"
            )
        _write_report(report_path, report)
        if pending or active:
            time.sleep(args.poll_seconds)


def _update_entry(entry: dict[str, Any], task: dict[str, Any]) -> None:
    entry["status"] = str(task.get("status") or "unknown")
    progress = task.get("progress") or {}
    entry["progress"] = float(progress.get("percentage") or 0)
    entry["message"] = str(progress.get("message") or "")
    result = task.get("result") or {}
    entry["actual_engine"] = result.get("render_engine")
    entry["fallback_reason"] = result.get("render_fallback_reason")
    entry["output_url"] = result.get("video_url")
    entry["error"] = task.get("error")
    entry.setdefault("retry_count", max(0, int(task.get("attempts") or 1) - 1))


def _retry_entry(
    client: httpx.Client,
    entry: dict[str, Any],
    args: argparse.Namespace,
) -> bool:
    retries = int(entry.get("retry_count") or 0)
    if retries >= args.max_task_retries:
        return False
    response = client.post(f"/api/tasks/{entry['task_id']}/retry")
    response.raise_for_status()
    task = response.json()
    entry["retry_count"] = retries + 1
    entry["status"] = str(task.get("status") or "pending")
    entry["error"] = None
    entry["message"] = f"从已有检查点重试 {entry['retry_count']}/{args.max_task_retries}"
    return True


def _summarize(tasks: list[dict[str, Any]], args: argparse.Namespace) -> dict[str, Any]:
    completed = [item for item in tasks if item.get("status") == "completed"]
    failed = [item for item in tasks if item.get("status") != "completed"]
    fallbacks = [item for item in completed if item.get("fallback_reason")]
    engine_mismatches = [
        item
        for item in completed
        if item.get("requested_engine")
        and item.get("actual_engine")
        and item["requested_engine"] != item["actual_engine"]
    ]
    passed = (
        len(tasks) == args.count
        and not failed
        and (not args.require_engine or not engine_mismatches)
    )
    return {
        "passed": passed,
        "submitted": len(tasks),
        "completed": len(completed),
        "failed": len(failed),
        "retried_tasks": sum(int(item.get("retry_count") or 0) > 0 for item in tasks),
        "total_retries": sum(int(item.get("retry_count") or 0) for item in tasks),
        "native_fallbacks": len(fallbacks),
        "engine_mismatches": len(engine_mismatches),
    }


def _write_report(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(path)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


if __name__ == "__main__":
    raise SystemExit(main())
