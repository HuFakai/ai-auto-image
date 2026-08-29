# Copyright (C) 2025 AIDC-AI
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#     http://www.apache.org/licenses/LICENSE-2.0
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

"""Durable task manager for asynchronous video generation jobs."""

import asyncio
import json
import math
import os
import threading
import time
import uuid
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Awaitable, Callable, Dict, List, Optional

from loguru import logger

from api.config import api_config
from api.tasks.models import Task, TaskProgress, TaskProgressStep, TaskStatus, TaskType

_TASK_START_MESSAGES = {
    TaskType.VIDEO_GENERATION: "正在准备视频生成",
    TaskType.STORYBOARD_PLANNING: "正在准备分镜规划",
    TaskType.STORYBOARD_REDIRECTION: "正在准备按审查建议重新导演",
    TaskType.SCENE_REGENERATION: "正在准备单镜重做",
    TaskType.QUALITY_REPAIR: "正在准备质量修复",
    TaskType.REVISION_RENDER: "正在准备同素材渲染对照",
    TaskType.SOURCE_INGESTION: "正在准备内容采集",
    TaskType.CUSTOM_SCRIPT_RECOMMENDATION: "正在准备自定义文案编排",
}


class TaskManager:
    """
    Task manager for handling async video generation tasks

    Task metadata is atomically persisted to JSON. Pending/running tasks are
    re-queued on startup through a registered task-type handler.
    """

    def __init__(
        self,
        store_path: Optional[str] = None,
        max_concurrent_tasks: Optional[int] = None,
        resume_interrupted_tasks: Optional[bool] = None,
        stall_timeout: Optional[float] = None,
        watchdog_interval: Optional[float] = None,
    ):
        self._tasks: Dict[str, Task] = {}
        self._task_futures: Dict[str, asyncio.Task] = {}
        self._handlers: Dict[TaskType, Callable[[Task], Awaitable[object]]] = {}
        self._cleanup_task: Optional[asyncio.Task] = None
        self._watchdog_task: Optional[asyncio.Task] = None
        self._running = False
        self._store_path = Path(store_path or api_config.task_store_path).expanduser().resolve()
        self._max_concurrent_tasks = (
            api_config.max_concurrent_tasks
            if max_concurrent_tasks is None
            else max_concurrent_tasks
        )
        self._resume_interrupted_tasks = (
            api_config.resume_interrupted_tasks
            if resume_interrupted_tasks is None
            else resume_interrupted_tasks
        )
        self._stall_timeout = (
            api_config.task_stall_timeout if stall_timeout is None else float(stall_timeout)
        )
        self._watchdog_interval = max(
            0.01,
            api_config.task_watchdog_interval
            if watchdog_interval is None
            else float(watchdog_interval),
        )
        self._semaphore: Optional[asyncio.Semaphore] = None
        self._store_lock = threading.RLock()
        self._last_progress_persist: Dict[str, float] = {}
        self._progress_persist_interval = 1.0

    def register_handler(
        self,
        task_type: TaskType,
        handler: Callable[[Task], Awaitable[object]],
    ) -> None:
        """Register the durable executor used for new and recovered tasks."""
        self._handlers[task_type] = handler

    async def start(self):
        """Start task manager and cleanup scheduler"""
        if self._running:
            logger.warning("Task manager already running")
            return

        self._load_tasks()
        self._running = True
        self._semaphore = (
            asyncio.Semaphore(self._max_concurrent_tasks)
            if self._max_concurrent_tasks > 0
            else None
        )
        self._cleanup_task = asyncio.create_task(self._cleanup_loop())
        if self._stall_timeout > 0:
            self._watchdog_task = asyncio.create_task(self._watchdog_loop())
        recovered = 0
        if self._resume_interrupted_tasks:
            for task in list(self._tasks.values()):
                if task.status not in {TaskStatus.PENDING, TaskStatus.RUNNING}:
                    continue
                if task.task_type not in self._handlers:
                    logger.warning(f"No recovery handler registered for {task.task_type}")
                    continue
                if task.status == TaskStatus.RUNNING:
                    task.recoveries += 1
                task.status = TaskStatus.PENDING
                task.completed_at = None
                task.error = None
                await self.execute_task(task.task_id)
                recovered += 1
        self._persist_tasks()
        logger.info(f"✅ Task manager started (loaded={len(self._tasks)}, recovered={recovered})")

    async def stop(self):
        """Stop task manager and cancel all tasks"""
        self._running = False

        # Cancel cleanup task
        if self._cleanup_task:
            self._cleanup_task.cancel()
            try:
                await self._cleanup_task
            except asyncio.CancelledError:
                pass

        if self._watchdog_task:
            self._watchdog_task.cancel()
            try:
                await self._watchdog_task
            except asyncio.CancelledError:
                pass

        # Cancel in-process futures. Their durable status remains pending/running
        # and will be recovered on the next start.
        futures = []
        for task_id, future in self._task_futures.items():
            if not future.done():
                future.cancel()
                futures.append(future)
                logger.info(f"Cancelled task: {task_id}")
        if futures:
            await asyncio.gather(*futures, return_exceptions=True)

        self._task_futures.clear()
        self._persist_tasks()
        logger.info("✅ Task manager stopped")

    def create_task(
        self,
        task_type: TaskType,
        request_params: Optional[dict] = None,
        idempotency_key: Optional[str] = None,
    ) -> Task:
        """
        Create a new task

        Args:
            task_type: Type of task
            request_params: Original request parameters

        Returns:
            Created task
        """
        if idempotency_key:
            existing = next(
                (
                    task
                    for task in self._tasks.values()
                    if task.idempotency_key == idempotency_key and task.task_type == task_type
                ),
                None,
            )
            # An explicit cancellation is a user decision to abandon this
            # attempt. Allow the same idempotency key to create a fresh task
            # when the user submits it again; completed/failed tasks retain
            # their existing exactly-once/retry behavior.
            if existing and existing.status != TaskStatus.CANCELLED:
                logger.info(f"Reused idempotent task {existing.task_id} ({task_type})")
                return existing

        task_id = str(uuid.uuid4())
        task = Task(
            task_id=task_id,
            task_type=task_type,
            idempotency_key=idempotency_key,
            status=TaskStatus.PENDING,
            progress=TaskProgress(
                current=0,
                total=100,
                percentage=0,
                message="等待执行资源",
            ),
            request_params=request_params,
        )

        self._tasks[task_id] = task
        self._persist_tasks()
        logger.info(f"Created task {task_id} ({task_type})")
        return task

    def restore_missing_failed_task(
        self,
        task_id: str,
        task_type: TaskType,
        request_params: dict,
        *,
        idempotency_key: Optional[str] = None,
    ) -> Task:
        """Rebuild missing durable metadata so an owning job can resume checkpoints."""
        existing = self._tasks.get(task_id)
        if existing is not None:
            return existing
        task = Task(
            task_id=task_id,
            task_type=task_type,
            idempotency_key=idempotency_key,
            status=TaskStatus.FAILED,
            progress=TaskProgress(
                current=1,
                total=100,
                percentage=1,
                message="持久任务索引已恢复，等待从检查点重试",
            ),
            error="Durable task metadata was missing and has been rebuilt",
            completed_at=datetime.now(),
            request_params=request_params,
        )
        self._tasks[task_id] = task
        self._persist_tasks()
        logger.warning(f"Restored missing task metadata: {task_id} ({task_type})")
        return task

    async def execute_task(
        self, task_id: str, coro_func: Optional[Callable] = None, *args, **kwargs
    ):
        """
        Execute task asynchronously

        Args:
            task_id: Task ID
            coro_func: Async function to execute
            *args: Positional arguments
            **kwargs: Keyword arguments
        """
        task = self._tasks.get(task_id)
        if not task:
            logger.error(f"Task {task_id} not found")
            return
        if task.status in {TaskStatus.COMPLETED, TaskStatus.FAILED, TaskStatus.CANCELLED}:
            logger.info(f"Task {task_id} is terminal ({task.status}); execution skipped")
            return

        if task_id in self._task_futures and not self._task_futures[task_id].done():
            logger.warning(f"Task {task_id} is already scheduled")
            return

        executor = coro_func
        if executor is None:
            handler = self._handlers.get(task.task_type)
            if handler is None:
                raise RuntimeError(f"No handler registered for task type {task.task_type}")

            async def registered_executor():
                return await handler(task)

            executor = registered_executor

        # Create async task
        async def _execute():
            try:

                async def run_executor():
                    previous_progress = task.progress
                    started_at = datetime.now()
                    task.status = TaskStatus.RUNNING
                    task.started_at = started_at
                    task.last_attempt_started_at = started_at
                    task.last_progress_at = started_at
                    if task.first_started_at is None:
                        task.first_started_at = started_at
                        task.queue_wait_ms = max(
                            0.0,
                            (started_at - task.created_at).total_seconds() * 1000,
                        )
                    task.attempts += 1
                    resumed_steps = list(previous_progress.steps) if previous_progress else []
                    resumed_percentage = min(
                        99,
                        max(
                            1,
                            float(previous_progress.percentage)
                            if previous_progress is not None
                            else 1,
                        ),
                    )
                    task.progress = TaskProgress(
                        current=int(resumed_percentage),
                        total=100,
                        percentage=resumed_percentage,
                        message=(
                            "正在从已有检查点继续"
                            if task.attempts > 1
                            else _TASK_START_MESSAGES.get(task.task_type, "任务已启动")
                        ),
                        steps=resumed_steps,
                    )
                    self._persist_tasks()
                    logger.info(f"Task {task_id} started (attempt={task.attempts})")

                    result = await executor(*args, **kwargs)

                    # A watchdog/user cancellation may have made the task
                    # terminal while a cancellation-resistant executor was
                    # unwinding. Never let a late result overwrite that state.
                    if task.status != TaskStatus.RUNNING or not self._running:
                        logger.info(
                            f"Task {task_id} returned after cancellation/status change "
                            f"({task.status}, manager_running={self._running})"
                        )
                        return

                    task.status = TaskStatus.COMPLETED
                    task.progress = TaskProgress(
                        current=100,
                        total=100,
                        percentage=100,
                        message="任务已完成",
                        steps=[
                            step.model_copy(update={"status": "completed"})
                            for step in (task.progress.steps if task.progress else [])
                        ],
                    )
                    task.result = result
                    task.completed_at = datetime.now()
                    self._finish_attempt_metrics(task, task.completed_at)
                    task.error = None
                    self._persist_tasks()
                    logger.info(f"Task {task_id} completed")

                if self._semaphore is None:
                    await run_executor()
                else:
                    async with self._semaphore:
                        await run_executor()
            except asyncio.CancelledError:
                self._persist_tasks()
                raise
            except Exception as e:
                if not self._running and task.status in {
                    TaskStatus.PENDING,
                    TaskStatus.RUNNING,
                }:
                    self._persist_tasks()
                    logger.info(f"Task {task_id} raised while manager was stopping: {e}")
                    return
                if task.status in {
                    TaskStatus.COMPLETED,
                    TaskStatus.FAILED,
                    TaskStatus.CANCELLED,
                }:
                    self._persist_tasks()
                    logger.info(
                        f"Task {task_id} raised after becoming terminal ({task.status}): {e}"
                    )
                    return
                task.status = TaskStatus.FAILED
                task.error = str(e)
                task.completed_at = datetime.now()
                self._finish_attempt_metrics(task, task.completed_at)
                if task.progress is None:
                    task.progress = TaskProgress(total=100)
                task.progress = task.progress.model_copy(
                    update={
                        "message": f"失败：{e}",
                        "steps": _mark_active_steps_failed(task.progress.steps),
                    }
                )
                self._persist_tasks()
                logger.error(f"Task {task_id} failed: {e}")
            finally:
                self._task_futures.pop(task_id, None)

        # Start execution
        future = asyncio.create_task(_execute())
        self._task_futures[task_id] = future

    def get_task(self, task_id: str) -> Optional[Task]:
        """Get task by ID"""
        return self._tasks.get(task_id)

    def list_tasks(self, status: Optional[TaskStatus] = None, limit: int = 100) -> List[Task]:
        """
        List tasks with optional filtering

        Args:
            status: Filter by status
            limit: Maximum number of tasks to return

        Returns:
            List of tasks
        """
        tasks = list(self._tasks.values())

        if status:
            tasks = [t for t in tasks if t.status == status]

        # Sort by created_at descending
        tasks.sort(key=lambda t: t.created_at, reverse=True)

        return tasks[:limit]

    def update_progress(
        self,
        task_id: str,
        current: int,
        total: int,
        message: str = "",
        steps: Optional[list[TaskProgressStep | dict[str, Any]]] = None,
    ):
        """
        Update task progress

        Args:
            task_id: Task ID
            current: Current progress
            total: Total steps
            message: Progress message
        """
        task = self._tasks.get(task_id)
        if not task:
            return
        if task.status in {
            TaskStatus.COMPLETED,
            TaskStatus.FAILED,
            TaskStatus.CANCELLED,
        }:
            return

        percentage = (current / total * 100) if total > 0 else 0
        if task.progress and task.status == TaskStatus.RUNNING:
            if percentage < task.progress.percentage:
                return
        next_steps = (
            [TaskProgressStep.model_validate(step) for step in steps]
            if steps is not None
            else list(task.progress.steps) if task.progress else []
        )
        task.progress = TaskProgress(
            current=current,
            total=total,
            percentage=percentage,
            message=message,
            steps=next_steps,
        )
        task.last_progress_at = datetime.now()
        now = time.monotonic()
        last_persisted = self._last_progress_persist.get(task_id, 0.0)
        if percentage >= 99 or now - last_persisted >= self._progress_persist_interval:
            self._last_progress_persist[task_id] = now
            self._persist_tasks()

    def cancel_task(self, task_id: str) -> bool:
        """
        Cancel a running task

        Args:
            task_id: Task ID

        Returns:
            True if cancelled, False otherwise
        """
        task = self._tasks.get(task_id)
        if not task:
            return False

        # Do not cancel already-terminal tasks
        if task.status in [TaskStatus.COMPLETED, TaskStatus.FAILED, TaskStatus.CANCELLED]:
            return False

        # Cancel future if running
        future = self._task_futures.get(task_id)
        if future and not future.done():
            future.cancel()

        # Update task status
        task.status = TaskStatus.CANCELLED
        task.completed_at = datetime.now()
        self._finish_attempt_metrics(task, task.completed_at)
        self._persist_tasks()
        logger.info(f"Cancelled task {task_id}")
        return True

    def remove_task(self, task_id: str) -> bool:
        """Remove terminal task metadata after its owning resource is deleted."""
        task = self._tasks.get(task_id)
        if task is None:
            return False
        if task.status not in {
            TaskStatus.COMPLETED,
            TaskStatus.FAILED,
            TaskStatus.CANCELLED,
        }:
            raise ValueError(f"Task {task_id} is still active")
        self._tasks.pop(task_id, None)
        self._task_futures.pop(task_id, None)
        self._last_progress_persist.pop(task_id, None)
        self._persist_tasks()
        logger.info(f"Removed terminal task metadata: {task_id}")
        return True

    async def retry_task(self, task_id: str) -> bool:
        """Retry a failed task with the same durable ID and output directory."""
        task = self._tasks.get(task_id)
        if not task or task.status != TaskStatus.FAILED:
            return False
        if task.task_type not in self._handlers:
            raise RuntimeError(f"No handler registered for task type {task.task_type}")

        task.status = TaskStatus.PENDING
        task.error = None
        task.completed_at = None
        if task.progress is None:
            task.progress = TaskProgress(
                current=1,
                total=100,
                percentage=1,
                message="准备从已有检查点继续",
            )
        else:
            task.progress.message = "准备从已有检查点继续"
        self._persist_tasks()
        await self.execute_task(task_id)
        logger.info(f"Retry scheduled for task {task_id}")
        return True

    def replace_failed_task_request(self, task_id: str, request_params: dict) -> None:
        """Repair durable parameters before retrying a failed task."""
        task = self._tasks.get(task_id)
        if task is None:
            raise KeyError(task_id)
        if task.status != TaskStatus.FAILED:
            raise ValueError("Only failed task parameters can be replaced")
        task.request_params = request_params
        self._persist_tasks()

    def metrics(self) -> dict:
        """Aggregate durable queue and latency metrics over retained tasks."""

        tasks = list(self._tasks.values())
        statuses = {
            status.value: sum(task.status == status for task in tasks) for status in TaskStatus
        }
        queue_values = [task.queue_wait_ms for task in tasks if task.queue_wait_ms is not None]
        run_values = [task.run_duration_ms for task in tasks if task.run_duration_ms is not None]
        terminal = [
            task
            for task in tasks
            if task.status in {TaskStatus.COMPLETED, TaskStatus.FAILED, TaskStatus.CANCELLED}
        ]
        by_type = {}
        for task_type in TaskType:
            matching = [task for task in tasks if task.task_type == task_type]
            if not matching:
                continue
            by_type[task_type.value] = {
                "total": len(matching),
                "completed": sum(task.status == TaskStatus.COMPLETED for task in matching),
                "failed": sum(task.status == TaskStatus.FAILED for task in matching),
                "running": sum(task.status == TaskStatus.RUNNING for task in matching),
                "pending": sum(task.status == TaskStatus.PENDING for task in matching),
            }
        return {
            "retained_tasks": len(tasks),
            "statuses": statuses,
            "active_futures": sum(not future.done() for future in self._task_futures.values()),
            "concurrency_limit": (
                self._max_concurrent_tasks if self._max_concurrent_tasks > 0 else None
            ),
            "unlimited_concurrency": self._max_concurrent_tasks <= 0,
            "success_rate": (
                sum(task.status == TaskStatus.COMPLETED for task in terminal) / len(terminal)
                if terminal
                else None
            ),
            "queue_wait_ms": _distribution(queue_values),
            "run_duration_ms": _distribution(run_values),
            "by_type": by_type,
        }

    async def _cleanup_loop(self):
        """Periodically clean up old completed tasks"""
        while self._running:
            try:
                await asyncio.sleep(api_config.task_cleanup_interval)
                self._cleanup_old_tasks()
            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.error(f"Error in cleanup loop: {e}")

    async def _watchdog_loop(self):
        """Fail running tasks that have stopped reporting progress."""
        while self._running:
            try:
                await asyncio.sleep(self._watchdog_interval)
                if self._running:
                    self._fail_stalled_tasks()
            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.error(f"Error in task watchdog loop: {e}")

    def _fail_stalled_tasks(self, now: Optional[datetime] = None) -> None:
        """Atomically mark and cancel tasks whose progress heartbeat expired."""
        if self._stall_timeout <= 0:
            return

        checked_at = now or datetime.now()
        stalled: list[tuple[str, asyncio.Task, float]] = []
        changed = False
        for task_id, task in list(self._tasks.items()):
            if task.status != TaskStatus.RUNNING:
                continue
            last_progress_at = task.last_progress_at or task.started_at
            if last_progress_at is None:
                continue
            stalled_for = max(0.0, (checked_at - last_progress_at).total_seconds())
            if stalled_for <= self._stall_timeout:
                continue

            message = (
                "Task stalled: no progress update for "
                f"{stalled_for:.1f}s (timeout {self._stall_timeout:.1f}s)"
            )
            task.status = TaskStatus.FAILED
            task.error = message
            task.completed_at = checked_at
            self._finish_attempt_metrics(task, checked_at)
            if task.progress is None:
                task.progress = TaskProgress(total=100)
            task.progress = task.progress.model_copy(
                update={
                    "message": f"失败：{message}",
                    "steps": _mark_active_steps_failed(task.progress.steps),
                }
            )
            future = self._task_futures.get(task_id)
            if future is not None and not future.done():
                stalled.append((task_id, future, stalled_for))
            changed = True

        # Persist terminal state before delivering cancellation. This also
        # makes failure durable if an executor delays or suppresses cancellation.
        if changed:
            self._persist_tasks()
        for task_id, future, stalled_for in stalled:
            future.cancel()
            logger.error(
                f"Task {task_id} failed watchdog after {stalled_for:.1f}s without progress"
            )

    def _cleanup_old_tasks(self):
        """Remove old completed/failed tasks"""
        cutoff_time = datetime.now() - timedelta(seconds=api_config.task_retention_time)

        tasks_to_remove = []
        for task_id, task in self._tasks.items():
            if task.status in [TaskStatus.COMPLETED, TaskStatus.FAILED, TaskStatus.CANCELLED]:
                if task.completed_at and task.completed_at < cutoff_time:
                    tasks_to_remove.append(task_id)

        for task_id in tasks_to_remove:
            del self._tasks[task_id]
            self._last_progress_persist.pop(task_id, None)
            if task_id in self._task_futures:
                del self._task_futures[task_id]

        if tasks_to_remove:
            self._persist_tasks()
            logger.info(f"Cleaned up {len(tasks_to_remove)} old tasks")

    def _load_tasks(self) -> None:
        """Load durable task metadata, tolerating an absent store."""
        with self._store_lock:
            if not self._store_path.exists():
                return
            try:
                with self._store_path.open("r", encoding="utf-8") as file:
                    data = json.load(file)
                self._tasks = {
                    item["task_id"]: Task.model_validate(item) for item in data.get("tasks", [])
                }
            except (OSError, json.JSONDecodeError, ValueError) as exc:
                raise RuntimeError(f"Failed to load task store {self._store_path}: {exc}") from exc

    def _persist_tasks(self) -> None:
        """Atomically save all task metadata without API credentials."""
        self._store_path.parent.mkdir(parents=True, exist_ok=True)
        temp_path = self._store_path.with_suffix(
            f"{self._store_path.suffix}.{os.getpid()}.{uuid.uuid4().hex}.tmp"
        )
        payload = {
            "version": 1,
            "tasks": [task.model_dump(mode="json") for task in self._tasks.values()],
        }
        with self._store_lock:
            try:
                with temp_path.open("w", encoding="utf-8") as file:
                    json.dump(payload, file, ensure_ascii=False, indent=2, sort_keys=True)
                    file.flush()
                    os.fsync(file.fileno())
                os.replace(temp_path, self._store_path)
            finally:
                if temp_path.exists():
                    temp_path.unlink()

    @staticmethod
    def _finish_attempt_metrics(task: Task, finished_at: datetime) -> None:
        started_at = task.last_attempt_started_at
        if started_at is None:
            return
        duration = max(0.0, (finished_at - started_at).total_seconds() * 1000)
        task.attempt_durations_ms.append(round(duration, 3))
        task.run_duration_ms = round(sum(task.attempt_durations_ms), 3)
        task.last_attempt_started_at = None


def _mark_active_steps_failed(
    steps: list[TaskProgressStep],
) -> list[TaskProgressStep]:
    """Keep visible task stages useful after an executor or watchdog failure."""
    return [
        step.model_copy(update={"status": "failed" if step.status == "active" else step.status})
        for step in steps
    ]


def _distribution(values: list[float]) -> dict[str, float | int | None]:
    if not values:
        return {"count": 0, "average": None, "p95": None, "maximum": None}
    ordered = sorted(values)
    p95_index = min(len(ordered) - 1, max(0, math.ceil(len(ordered) * 0.95) - 1))
    return {
        "count": len(ordered),
        "average": round(sum(ordered) / len(ordered), 3),
        "p95": round(ordered[p95_index], 3),
        "maximum": round(ordered[-1], 3),
    }


# Global task manager instance
task_manager = TaskManager()
