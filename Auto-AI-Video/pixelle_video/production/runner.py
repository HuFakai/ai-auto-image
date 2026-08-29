"""Inventory-driven scheduler that submits work to Pixelle's durable API."""

from __future__ import annotations

import json
import re
import threading
import time
import uuid
from datetime import datetime, timezone
from typing import Any
from zoneinfo import ZoneInfo

import httpx
from loguru import logger

from .catalog import sync_job_project
from .models import ChannelConfig, RunnerConfig, load_channel_configs
from .ops import WebhookNotifier
from .presets import resolve_channel_policies, resolve_channel_request
from .quality import build_quality_repair_plan
from .store import ProductionStore

_HEALTH_CHECK_TIMEOUT_SECONDS = 5.0
_NO_REPAIRABLE_CHECKS_DETAIL = "No repairable failed technical quality checks"


class ProductionRunner:
    """Reconcile channel inventory with durable Pixelle API tasks."""

    def __init__(
        self,
        config: RunnerConfig,
        store: ProductionStore | None = None,
        transport: httpx.BaseTransport | None = None,
    ):
        self.config = config
        self.store = store or ProductionStore(config.database_path)
        self.holder = f"{uuid.uuid4()}"
        self.timezone = ZoneInfo(config.timezone)
        self.channels = {channel.id: channel for channel in config.channels}
        self.notifier = WebhookNotifier(config, self.store)
        self._transport = transport
        self.client = httpx.Client(
            base_url=config.api_base_url.rstrip("/"),
            timeout=config.request_timeout_seconds,
            trust_env=False,
            transport=transport,
        )
        self.health_client = self._new_health_client()

    def close(self) -> None:
        self.store.release_lease("production-runner", self.holder)
        self.health_client.close()
        self.client.close()
        self.store.close()

    def _new_health_client(self) -> httpx.Client:
        return httpx.Client(
            base_url=self.config.api_base_url.rstrip("/"),
            timeout=min(
                self.config.request_timeout_seconds,
                _HEALTH_CHECK_TIMEOUT_SECONDS,
            ),
            trust_env=False,
            transport=self._transport,
        )

    def _reset_health_client(self) -> None:
        """Discard a timed-out health connection before the next probe."""
        self.health_client.close()
        self.health_client = self._new_health_client()

    def run_forever(self, stop_event: threading.Event | None = None) -> None:
        logger.info(
            "Production runner started: channels={}, interval={}s",
            len(self.channels),
            self.config.poll_interval_seconds,
        )
        try:
            while stop_event is None or not stop_event.is_set():
                try:
                    self.run_once()
                except Exception as exc:
                    logger.exception("Production reconciliation failed; will retry")
                    bucket = datetime.now(timezone.utc).strftime("%Y%m%d%H")
                    self.notifier.emit(
                        "runner_error",
                        f"runner-error:{bucket}:{type(exc).__name__}",
                        {"error": str(exc), "error_type": type(exc).__name__},
                    )
                    self.notifier.flush()
                if stop_event is None:
                    time.sleep(self.config.poll_interval_seconds)
                elif stop_event.wait(self.config.poll_interval_seconds):
                    break
        finally:
            self.close()

    def run_once(self) -> dict[str, Any]:
        if not self.store.acquire_lease(
            "production-runner", self.holder, self.config.lease_seconds
        ):
            return {"status": "standby", "reason": "lease-held-by-another-runner"}

        self._reload_channels()
        delivered_before = self.notifier.flush()
        try:
            health = self.health_client.get("/health")
        except httpx.TransportError as exc:
            timeout_seconds = min(
                self.config.request_timeout_seconds,
                _HEALTH_CHECK_TIMEOUT_SECONDS,
            )
            is_timeout = isinstance(exc, httpx.TimeoutException)
            reason = "api-health-timeout" if is_timeout else "api-health-unreachable"
            status = "timeout" if is_timeout else "unreachable"
            logger.warning(
                "API health check {} ({}); skipping this reconciliation "
                "cycle and retrying next cycle",
                f"timed out after {timeout_seconds}s" if is_timeout else "is unreachable",
                type(exc).__name__,
            )
            self._reset_health_client()
            return {
                "status": "degraded",
                "reason": reason,
                "health": {
                    "status": status,
                    "error_type": type(exc).__name__,
                    "timeout_seconds": timeout_seconds,
                },
                "sources_queued": 0,
                "channels": {},
                "notifications": delivered_before,
            }
        health.raise_for_status()
        sources_queued = self._trigger_due_sources()
        self._sync_storyboard_tasks()
        self._sync_api_tasks()
        self._sync_project_catalog()

        channels: dict[str, Any] = {}
        for channel in self.channels.values():
            if not channel.enabled:
                channels[channel.id] = {"status": "disabled"}
                continue
            channels[channel.id] = self._reconcile_channel(channel)
        delivered_after = self.notifier.flush()
        return {
            "status": "ok",
            "sources_queued": sources_queued,
            "channels": channels,
            "notifications": {
                "sent": delivered_before["sent"] + delivered_after["sent"],
                "failed": delivered_before["failed"] + delivered_after["failed"],
            },
        }

    def _trigger_due_sources(self) -> int:
        """Ask the API to enqueue due collectors without waiting for their work."""
        if not self.store.due_content_sources(limit=1):
            return 0
        response = self.client.post("/api/production/sources/poll-due?limit=5")
        response.raise_for_status()
        return int(response.json().get("count") or 0)

    def _reload_channels(self) -> None:
        channels = load_channel_configs(self.config.channels_dir)
        self.config.channels = channels
        self.channels = {channel.id: channel for channel in channels}

    def status(self) -> dict[str, Any]:
        bucket = self._today_bucket()
        return {
            "database": str(self.store.path),
            "channels": {
                channel.id: {
                    "name": channel.name,
                    "enabled": channel.enabled,
                    **self.store.snapshot(channel.id, bucket),
                }
                for channel in self.channels.values()
            },
        }

    def publish(self, channel_id: str, count: int = 1) -> list[dict[str, Any]]:
        if channel_id not in self.channels:
            raise KeyError(f"Unknown channel: {channel_id}")
        return self.store.mark_published(channel_id, count)

    def _sync_api_tasks(self) -> None:
        unsubmitted = self.store.list_jobs(statuses=("planned", "submitting"), limit=10000)
        for job in reversed(unsubmitted):
            if not job.get("api_task_id"):
                channel = self.channels.get(job["channel_id"])
                if (
                    channel
                    and self._planning_policy(job, channel)["enabled"]
                    and job.get("storyboard_status") != "approved"
                ):
                    self._start_storyboard_plan(job, channel)
                else:
                    self._submit_job(job)

        jobs = self.store.list_jobs(statuses=("pending", "running"), limit=10000)
        for job in reversed(jobs):
            task_id = job.get("api_task_id")
            if not task_id:
                continue
            response = self.client.get(f"/api/tasks/{task_id}")
            if response.status_code == 404:
                self._record_failure(job, "Pixelle API task was not found")
                continue
            response.raise_for_status()
            task = response.json()
            status = task.get("status")
            if status in {"pending", "running"}:
                self.store.update_job(job["id"], status=status, error=None)
            elif status == "completed":
                completed_job = self.store.update_job(
                    job["id"],
                    status="ready",
                    review_status="pending",
                    review_note=None,
                    reviewed_at=None,
                    result_json=task.get("result") or {},
                    error=None,
                    completed_at=datetime.now(self.timezone).isoformat(),
                    completed_bucket=self._today_bucket(),
                )
                self.notifier.emit(
                    "job_ready",
                    f"job-ready:{completed_job['id']}",
                    {
                        "job_id": completed_job["id"],
                        "channel_id": completed_job["channel_id"],
                        "title": completed_job.get("title") or completed_job["topic"],
                    },
                )
                self._sync_completed_project(completed_job)
            elif status == "failed":
                self._retry_or_fail(
                    job,
                    task.get("error") or "Pixelle task failed",
                    task_id=task_id,
                    retry_status="pending",
                )
            elif status == "cancelled":
                self.store.update_job(job["id"], status="cancelled", error=task.get("error"))

    def _sync_storyboard_tasks(self) -> None:
        jobs = self.store.list_jobs(statuses=("planning",), limit=10000)
        for job in reversed(jobs):
            task_id = job.get("storyboard_task_id")
            if not task_id:
                self._record_failure(job, "Storyboard task is missing")
                continue
            response = self.client.get(f"/api/tasks/{task_id}")
            if response.status_code == 404:
                self._record_failure(job, "Storyboard task was not found")
                continue
            response.raise_for_status()
            task = response.json()
            status = task.get("status")
            if status in {"pending", "running"}:
                continue
            if status == "completed":
                plan = task.get("result") or {}
                if not plan.get("title") or not plan.get("scenes"):
                    self._record_failure(
                        job, "Storyboard planning returned an incomplete result"
                    )
                    continue
                channel = self.channels.get(job["channel_id"])
                saved = self.store.save_storyboard_plan(job["id"], task_id, plan)
                should_auto_approve = bool(
                    channel
                    and self._planning_policy(saved, channel)["approval"] == "auto"
                    and saved.get("content_gate_status") != "fail"
                )
                if should_auto_approve:
                    approved = self.store.approve_storyboard(job["id"])
                    self._submit_job(approved)
                continue
            if status == "failed":
                self._retry_or_fail(
                    job,
                    task.get("error") or "Storyboard planning failed",
                    task_id=task_id,
                    retry_status="planning",
                )
            elif status == "cancelled":
                self.store.update_job(job["id"], status="cancelled", error=task.get("error"))

    def _sync_project_catalog(self) -> None:
        jobs = self.store.list_jobs(statuses=("ready", "published"), limit=10000)
        for job in reversed(jobs):
            try:
                self.store.get_project_by_job(job["id"])
            except KeyError:
                self._sync_completed_project(job)

    def _sync_completed_project(self, job: dict[str, Any]) -> None:
        try:
            project = sync_job_project(self.store, job)
            revision = next(
                item
                for item in project["revisions"]
                if item["id"] == project["current_revision_id"]
            )
            if revision["quality_status"] == "fail" and job["status"] == "ready":
                self.store.update_job(
                    job["id"],
                    review_status="rejected",
                    review_note="Automatic technical quality gate failed",
                    reviewed_at=datetime.now(timezone.utc).isoformat(),
                )
                channel = self.channels.get(job["channel_id"])
                if channel and self._quality_policy(job, channel)["auto_repair"]:
                    self._request_quality_repair(revision)
        except (FileNotFoundError, KeyError, ValueError) as exc:
            logger.warning("Project catalog sync skipped for {}: {}", job["id"], exc)

    def _request_quality_repair(self, revision: dict[str, Any]) -> None:
        """Queue repair only when the failed revision has an actionable plan."""
        revision_id = revision["id"]
        if revision.get("repair_status") in {"pending", "running", "completed"}:
            logger.debug(
                "Automatic quality repair already {} for {}; skipping duplicate request",
                revision["repair_status"],
                revision_id,
            )
            return

        plan = build_quality_repair_plan(revision)
        if not plan["steps"]:
            logger.debug(
                "Automatic quality repair skipped for {}: no repairable failed checks "
                "(manual_checks={}, locked_scenes={})",
                revision_id,
                plan["manual_checks"],
                plan["locked_scenes"],
            )
            return

        response = self.client.post(
            f"/api/projects/revisions/{revision_id}/auto-repair"
        )
        if response.is_success:
            return

        detail = None
        if response.status_code == 409:
            try:
                detail = response.json().get("detail")
            except (json.JSONDecodeError, AttributeError, TypeError):
                pass
        if detail == _NO_REPAIRABLE_CHECKS_DETAIL:
            logger.debug(
                "Automatic quality repair became unnecessary for {}; skipping",
                revision_id,
            )
            return

        logger.warning(
            "Automatic quality repair was rejected for {}: {} {}",
            revision_id,
            response.status_code,
            response.text,
        )

    def _retry_or_fail(
        self,
        job: dict[str, Any],
        error: str,
        task_id: str,
        retry_status: str,
    ) -> None:
        channel = self.channels.get(job["channel_id"])
        max_retries = channel.inventory.max_task_retries if channel else 0
        if job["retries"] >= max_retries:
            self._record_failure(job, error)
            return

        response = self.client.post(f"/api/tasks/{task_id}/retry")
        if response.is_success:
            self.store.update_job(
                job["id"],
                status=retry_status,
                retries=job["retries"] + 1,
                error=None,
            )
            return
        self._record_failure(job, f"Retry rejected ({response.status_code}): {error}")

    def _reconcile_channel(self, channel: ChannelConfig) -> dict[str, Any]:
        snapshot = self.store.snapshot(channel.id, self._today_bucket())
        if self.store.is_channel_paused(channel.id):
            return {
                **snapshot,
                "status": "paused",
                "reason": "manually paused",
                "submitted": [],
            }
        circuit = self._circuit_breaker(channel)
        if circuit:
            return {**snapshot, "status": "paused", "reason": circuit, "submitted": []}
        available_slots = max(channel.inventory.max_in_flight - snapshot["in_flight"], 0)
        buffer_gap = max(
            channel.inventory.ready_target - snapshot["ready"] - snapshot["in_flight"],
            0,
        )
        daily_gap = max(
            channel.inventory.daily_target
            - snapshot["completed_today"]
            - snapshot["in_flight"],
            0,
        )
        needed = max(buffer_gap, daily_gap)
        to_submit = min(available_slots, channel.inventory.refill_batch, needed)

        submitted: list[dict[str, str]] = []
        duplicate_blocker: str | None = None
        for _ in range(to_submit):
            try:
                candidate, topic, title = self._next_unique_topic(channel)
            except RuntimeError as exc:
                duplicate_blocker = str(exc)
                break
            request = resolve_channel_request(self.store, channel, topic, title)
            if candidate:
                request["_production"]["topic_candidate"] = candidate
            if candidate:
                job = self.store.create_job_from_topic_candidate(candidate["id"], request)
            else:
                job = self.store.create_job(channel.id, topic, title, request)
            if self._planning_policy(job, channel)["enabled"]:
                submitted.append(self._start_storyboard_plan(job, channel))
            else:
                submitted.append(self._submit_job(job))

        return {
            **snapshot,
            "needed": needed,
            "available_slots": available_slots,
            "submitted": submitted,
            "duplicate_blocker": duplicate_blocker,
        }

    def _next_unique_topic(
        self,
        channel: ChannelConfig,
    ) -> tuple[dict[str, Any] | None, str, str]:
        """Skip stale approved candidates and reject repeated generated topics."""
        for _ in range(20):
            candidate = self.store.next_topic_candidate(channel.id)
            if candidate is None:
                break
            duplicate = self.store.topic_already_queued(
                channel.id, candidate["topic"], candidate["title"]
            )
            if duplicate is None:
                return candidate, candidate["topic"], candidate["title"]
            self.store.update_topic_candidate(
                candidate["id"],
                "discarded",
                f"与已有任务 {duplicate['id']} 重复，Runner 已自动跳过",
            )

        for _ in range(3):
            topic, title = self._next_topic(channel)
            if self.store.topic_already_queued(channel.id, topic, title) is None:
                return None, topic, title
        raise RuntimeError(
            f"Channel {channel.id} could not produce a unique topic after three attempts"
        )

    def _circuit_breaker(self, channel: ChannelConfig) -> str | None:
        recent = self.store.list_jobs(
            channel_id=channel.id,
            limit=channel.inventory.circuit_breaker_failures,
        )
        if len(recent) < channel.inventory.circuit_breaker_failures:
            return None
        if any(job["status"] != "failed" for job in recent):
            return None
        latest = datetime.fromisoformat(recent[0]["updated_at"])
        age = (datetime.now(timezone.utc) - latest.astimezone(timezone.utc)).total_seconds()
        if age < channel.inventory.failure_cooldown_seconds:
            self.notifier.emit(
                "channel_circuit_open",
                f"channel-circuit:{channel.id}:{recent[0]['id']}",
                {
                    "channel_id": channel.id,
                    "failures": len(recent),
                    "latest_job_id": recent[0]["id"],
                    "retry_after_seconds": int(
                        channel.inventory.failure_cooldown_seconds - age
                    ),
                    "error": recent[0].get("error"),
                },
            )
            return (
                f"{len(recent)} consecutive failures; retry in "
                f"{int(channel.inventory.failure_cooldown_seconds - age)}s"
            )
        return None

    def _submit_job(self, job: dict[str, Any]) -> dict[str, str]:
        self.store.update_job(job["id"], status="submitting")
        try:
            response = self.client.post(
                "/api/video/generate/async",
                json=job["request"],
                headers={"Idempotency-Key": f"production:{job['id']}"},
            )
            response.raise_for_status()
            task_id = response.json()["task_id"]
            self.store.update_job(
                job["id"], status="pending", api_task_id=task_id, error=None
            )
            return {"job_id": job["id"], "task_id": task_id, "topic": job["topic"]}
        except Exception as exc:
            self._record_failure(job, str(exc))
            raise

    def _start_storyboard_plan(
        self,
        job: dict[str, Any],
        channel: ChannelConfig,
    ) -> dict[str, str]:
        self.store.update_job(job["id"], status="planning")
        try:
            planning = self._planning_policy(job, channel)
            response = self.client.post(
                "/api/production/storyboards/plan",
                json={
                    **job["request"],
                    "content_policy": planning["content_policy"],
                    "llm_review": planning["llm_review"],
                },
                headers={"Idempotency-Key": f"storyboard:{job['id']}"},
            )
            response.raise_for_status()
            task_id = response.json()["task_id"]
            self.store.update_job(
                job["id"],
                status="planning",
                storyboard_task_id=task_id,
                storyboard_status="planning",
                error=None,
            )
            return {"job_id": job["id"], "task_id": task_id, "topic": job["topic"]}
        except Exception as exc:
            self._record_failure(job, str(exc))
            raise

    def _record_failure(self, job: dict[str, Any], error: str) -> dict[str, Any]:
        failed = self.store.update_job(job["id"], status="failed", error=error)
        self.notifier.emit(
            "job_failed",
            f"job-failed:{job['id']}:{job.get('retries', 0)}",
            {
                "job_id": job["id"],
                "channel_id": job["channel_id"],
                "title": job.get("title") or job["topic"],
                "error": error,
            },
        )
        return failed

    def _next_topic(self, channel: ChannelConfig) -> tuple[str, str]:
        history = self.store.recent_topics(channel.id, channel.topic.history_window)
        if channel.topic.strategy == "llm":
            try:
                return self._llm_topic(channel, history)
            except Exception as exc:
                if not channel.topic.fallback_to_seeds:
                    raise
                logger.warning("LLM topic generation failed for {}: {}", channel.id, exc)

        if not channel.topic.seeds:
            raise RuntimeError(f"Channel {channel.id} has no usable seed topics")
        for seed in channel.topic.seeds:
            if seed not in history:
                return seed, seed
        usage = {seed: history.index(seed) if seed in history else len(history) for seed in channel.topic.seeds}
        selected = max(channel.topic.seeds, key=lambda seed: usage[seed])
        return selected, selected

    def _llm_topic(self, channel: ChannelConfig, history: list[str]) -> tuple[str, str]:
        history_text = "\n".join(f"- {topic}" for topic in history) or "（暂无）"
        _, _, recipe_prompt = resolve_channel_policies(self.store, channel)
        prompt = recipe_prompt.strip() or f"为栏目《{channel.name}》策划一个短视频选题。"
        prompt += (
            "\n避免与下列近期选题重复：\n"
            f"{history_text}\n"
            '只输出 JSON：{"topic":"供视频脚本生成的具体选题","title":"短视频标题"}'
        )
        response = self.client.post(
            "/api/llm/chat",
            json={"prompt": prompt, "temperature": 0.9, "max_tokens": 400},
        )
        response.raise_for_status()
        content = response.json().get("content", "")
        match = re.search(r"\{.*\}", content, flags=re.DOTALL)
        if not match:
            raise ValueError("LLM topic response did not contain JSON")
        value = json.loads(match.group(0))
        topic = str(value.get("topic") or "").strip()
        title = str(value.get("title") or topic).strip()
        if not topic:
            raise ValueError("LLM topic response had an empty topic")
        return topic, title

    @staticmethod
    def _planning_policy(job: dict[str, Any], channel: ChannelConfig) -> dict[str, Any]:
        production = job.get("request", {}).get("_production", {})
        return production.get("planning") or channel.planning.model_dump()

    @staticmethod
    def _quality_policy(job: dict[str, Any], channel: ChannelConfig) -> dict[str, Any]:
        production = job.get("request", {}).get("_production", {})
        return production.get("quality") or channel.quality.model_dump()

    def _today_bucket(self) -> str:
        return datetime.now(self.timezone).date().isoformat()
