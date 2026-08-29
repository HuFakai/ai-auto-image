import asyncio

import pytest

from api.tasks.manager import TaskManager
from api.tasks.models import TaskStatus, TaskType


async def wait_for_status(manager: TaskManager, task_id: str, status: TaskStatus) -> None:
    # Windows' default asyncio clock can coalesce sub-16ms timers and wake them
    # early. Use an elapsed-time deadline instead of assuming 100 sleeps equal
    # one second.
    # Give a just-created executor one scheduling turn before starting timers;
    # otherwise a 20ms Windows clock tick can jump straight past tiny watchdog
    # thresholds used by these tests.
    await asyncio.sleep(0)
    deadline = asyncio.get_running_loop().time() + 2
    while asyncio.get_running_loop().time() < deadline:
        task = manager.get_task(task_id)
        if task and task.status == status:
            return
        await asyncio.sleep(0.02)
    raise AssertionError(f"Task {task_id} did not reach {status}")


@pytest.mark.asyncio
async def test_zero_concurrency_limit_runs_tasks_without_a_global_ceiling(tmp_path):
    manager = TaskManager(
        str(tmp_path / "api_tasks.json"),
        max_concurrent_tasks=0,
        resume_interrupted_tasks=False,
    )
    await manager.start()
    release = asyncio.Event()
    both_started = asyncio.Event()
    started: set[str] = set()

    async def execute(label: str):
        started.add(label)
        if len(started) == 2:
            both_started.set()
        await release.wait()
        return label

    first = manager.create_task(TaskType.VIDEO_GENERATION)
    second = manager.create_task(TaskType.VIDEO_GENERATION)
    await manager.execute_task(first.task_id, execute, "first")
    await manager.execute_task(second.task_id, execute, "second")
    await asyncio.wait_for(both_started.wait(), timeout=1)

    assert manager._semaphore is None
    assert started == {"first", "second"}
    release.set()
    await wait_for_status(manager, first.task_id, TaskStatus.COMPLETED)
    await wait_for_status(manager, second.task_id, TaskStatus.COMPLETED)
    await manager.stop()


@pytest.mark.asyncio
async def test_failed_task_request_can_be_repaired_before_retry(tmp_path):
    manager = TaskManager(
        str(tmp_path / "api_tasks.json"),
        max_concurrent_tasks=1,
        resume_interrupted_tasks=False,
    )
    seen = []

    async def handler(task):
        seen.append(task.request_params)
        if len(seen) == 1:
            raise RuntimeError("legacy request")
        return {"ok": True}

    manager.register_handler(TaskType.VIDEO_GENERATION, handler)
    await manager.start()
    task = manager.create_task(TaskType.VIDEO_GENERATION, {"frame_template": "legacy.html"})
    await manager.execute_task(task.task_id)
    await wait_for_status(manager, task.task_id, TaskStatus.FAILED)

    manager.replace_failed_task_request(task.task_id, {"frame_template": None})
    assert await manager.retry_task(task.task_id) is True
    await wait_for_status(manager, task.task_id, TaskStatus.COMPLETED)

    assert seen == [{"frame_template": "legacy.html"}, {"frame_template": None}]
    await manager.stop()


@pytest.mark.asyncio
async def test_completed_task_survives_manager_restart(tmp_path):
    store = tmp_path / "api_tasks.json"
    manager = TaskManager(str(store), max_concurrent_tasks=1, resume_interrupted_tasks=False)
    await manager.start()
    task = manager.create_task(TaskType.VIDEO_GENERATION, {"text": "hello"})

    async def execute():
        return {"video_url": "http://localhost/video.mp4"}

    await manager.execute_task(task.task_id, execute)
    await wait_for_status(manager, task.task_id, TaskStatus.COMPLETED)
    await manager.stop()

    restored = TaskManager(str(store), max_concurrent_tasks=1, resume_interrupted_tasks=False)
    await restored.start()
    restored_task = restored.get_task(task.task_id)
    assert restored_task is not None
    assert restored_task.status == TaskStatus.COMPLETED
    assert restored_task.result == {"video_url": "http://localhost/video.mp4"}
    assert restored_task.attempts == 1
    assert restored_task.queue_wait_ms is not None
    assert restored_task.run_duration_ms is not None
    assert len(restored_task.attempt_durations_ms) == 1
    metrics = restored.metrics()
    assert metrics["statuses"]["completed"] == 1
    assert metrics["success_rate"] == 1
    assert metrics["run_duration_ms"]["count"] == 1
    await restored.stop()


@pytest.mark.asyncio
async def test_running_task_is_requeued_with_same_id_after_shutdown(tmp_path):
    store = tmp_path / "api_tasks.json"
    blocker = asyncio.Event()
    first = TaskManager(str(store), max_concurrent_tasks=1, resume_interrupted_tasks=True)

    async def interrupted_handler(_task):
        await blocker.wait()

    first.register_handler(TaskType.VIDEO_GENERATION, interrupted_handler)
    await first.start()
    task = first.create_task(TaskType.VIDEO_GENERATION, {"text": "resume me"})
    await first.execute_task(task.task_id)
    await wait_for_status(first, task.task_id, TaskStatus.RUNNING)
    await first.stop()

    recovered_ids = []
    second = TaskManager(str(store), max_concurrent_tasks=1, resume_interrupted_tasks=True)

    async def recovered_handler(recovered_task):
        recovered_ids.append(recovered_task.task_id)
        return {"status": "recovered"}

    second.register_handler(TaskType.VIDEO_GENERATION, recovered_handler)
    await second.start()
    await wait_for_status(second, task.task_id, TaskStatus.COMPLETED)

    recovered = second.get_task(task.task_id)
    assert recovered is not None
    assert recovered_ids == [task.task_id]
    assert recovered.recoveries == 1
    assert recovered.attempts == 2
    assert recovered.result == {"status": "recovered"}
    await second.stop()


@pytest.mark.asyncio
async def test_failed_task_retries_with_same_id(tmp_path):
    store = tmp_path / "api_tasks.json"
    manager = TaskManager(str(store), max_concurrent_tasks=1, resume_interrupted_tasks=False)
    calls = 0
    retry_start_progress = []

    async def handler(_task):
        nonlocal calls
        calls += 1
        if calls == 1:
            manager.update_progress(task.task_id, 84, 100, "正在检查 HyperFrames")
            raise RuntimeError("temporary provider failure")
        retry_start_progress.append(_task.progress.percentage)
        return {"video_url": "http://localhost/retried.mp4"}

    manager.register_handler(TaskType.VIDEO_GENERATION, handler)
    await manager.start()
    task = manager.create_task(TaskType.VIDEO_GENERATION, {"text": "retry me"})
    await manager.execute_task(task.task_id)
    await wait_for_status(manager, task.task_id, TaskStatus.FAILED)

    assert await manager.retry_task(task.task_id) is True
    await wait_for_status(manager, task.task_id, TaskStatus.COMPLETED)
    retried = manager.get_task(task.task_id)
    assert retried is not None
    assert retried.task_id == task.task_id
    assert retried.attempts == 2
    assert len(retried.attempt_durations_ms) == 2
    assert retried.run_duration_ms == pytest.approx(sum(retried.attempt_durations_ms))
    assert retry_start_progress == [84]
    assert retried.result == {"video_url": "http://localhost/retried.mp4"}
    await manager.stop()


def test_running_task_progress_is_monotonic(tmp_path):
    manager = TaskManager(
        str(tmp_path / "api_tasks.json"),
        max_concurrent_tasks=1,
        resume_interrupted_tasks=False,
    )
    task = manager.create_task(TaskType.VIDEO_GENERATION, {"text": "progress"})
    task.status = TaskStatus.RUNNING

    manager.update_progress(task.task_id, 42, 100, "镜头 2/6 · 生成画面")
    manager.update_progress(task.task_id, 5, 100, "晚到的旧事件")

    assert task.progress is not None
    assert task.progress.percentage == 42
    assert task.progress.current == 42
    assert task.progress.message == "镜头 2/6 · 生成画面"


@pytest.mark.asyncio
async def test_create_task_reuses_persisted_idempotency_key(tmp_path):
    store = tmp_path / "api_tasks.json"
    first = TaskManager(str(store), max_concurrent_tasks=1, resume_interrupted_tasks=False)
    await first.start()
    task = first.create_task(
        TaskType.VIDEO_GENERATION,
        {"text": "exactly once"},
        idempotency_key="production:job-1",
    )
    duplicate = first.create_task(
        TaskType.VIDEO_GENERATION,
        {"text": "exactly once"},
        idempotency_key="production:job-1",
    )
    assert duplicate.task_id == task.task_id
    await first.stop()

    restored = TaskManager(str(store), max_concurrent_tasks=1, resume_interrupted_tasks=False)
    await restored.start()
    after_restart = restored.create_task(
        TaskType.VIDEO_GENERATION,
        {"text": "exactly once"},
        idempotency_key="production:job-1",
    )
    assert after_restart.task_id == task.task_id
    assert len(restored.list_tasks()) == 1

    async def must_not_run():
        raise AssertionError("terminal idempotent task must not execute")

    after_restart.status = TaskStatus.COMPLETED
    await restored.execute_task(after_restart.task_id, must_not_run)
    assert after_restart.task_id not in restored._task_futures
    await restored.stop()


def test_cancelled_idempotent_task_can_be_submitted_again(tmp_path):
    manager = TaskManager(
        str(tmp_path / "api_tasks.json"),
        max_concurrent_tasks=1,
        resume_interrupted_tasks=False,
    )
    first = manager.create_task(
        TaskType.VIDEO_GENERATION,
        {"text": "cancel and submit again"},
        idempotency_key="production:retry-after-cancel",
    )
    first.status = TaskStatus.CANCELLED

    second = manager.create_task(
        TaskType.VIDEO_GENERATION,
        {"text": "cancel and submit again"},
        idempotency_key="production:retry-after-cancel",
    )

    assert second.task_id != first.task_id
    assert second.status == TaskStatus.PENDING


def test_missing_task_metadata_can_be_rebuilt_with_same_checkpoint_id(tmp_path):
    manager = TaskManager(
        str(tmp_path / "api_tasks.json"),
        max_concurrent_tasks=1,
        resume_interrupted_tasks=False,
    )
    restored = manager.restore_missing_failed_task(
        "checkpoint-task-id",
        TaskType.VIDEO_GENERATION,
        {"title": "resume", "text": "from checkpoint"},
        idempotency_key="production:job-id",
    )

    assert restored.task_id == "checkpoint-task-id"
    assert restored.status == TaskStatus.FAILED
    assert restored.request_params == {"title": "resume", "text": "from checkpoint"}
    assert restored.idempotency_key == "production:job-id"

    reloaded = TaskManager(
        str(tmp_path / "api_tasks.json"),
        max_concurrent_tasks=1,
        resume_interrupted_tasks=False,
    )
    reloaded._load_tasks()
    assert reloaded.get_task("checkpoint-task-id").status == TaskStatus.FAILED


@pytest.mark.asyncio
async def test_watchdog_fails_stalled_task_even_if_executor_swallows_cancellation(tmp_path):
    manager = TaskManager(
        str(tmp_path / "api_tasks.json"),
        max_concurrent_tasks=1,
        resume_interrupted_tasks=False,
        stall_timeout=0.04,
        watchdog_interval=0.01,
    )
    cancellation_seen = asyncio.Event()

    async def cancellation_resistant_executor():
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            cancellation_seen.set()
            return {"late": "result"}

    await manager.start()
    task = manager.create_task(TaskType.VIDEO_GENERATION)
    await manager.execute_task(task.task_id, cancellation_resistant_executor)
    await wait_for_status(manager, task.task_id, TaskStatus.FAILED)
    await asyncio.wait_for(cancellation_seen.wait(), timeout=1)
    await asyncio.sleep(0)

    failed = manager.get_task(task.task_id)
    assert failed is not None
    assert failed.status == TaskStatus.FAILED
    assert failed.result is None
    assert failed.last_progress_at is not None
    assert failed.error is not None
    assert "no progress update" in failed.error
    assert task.task_id not in manager._task_futures
    await manager.stop()


@pytest.mark.asyncio
async def test_progress_heartbeat_prevents_false_watchdog_failure(tmp_path):
    manager = TaskManager(
        str(tmp_path / "api_tasks.json"),
        max_concurrent_tasks=1,
        resume_interrupted_tasks=False,
        stall_timeout=0.05,
        watchdog_interval=0.01,
    )

    async def active_executor():
        for step in range(1, 7):
            await asyncio.sleep(0.02)
            manager.update_progress(task.task_id, step, 10, f"step {step}")
        return {"ok": True}

    await manager.start()
    task = manager.create_task(TaskType.VIDEO_GENERATION)
    await manager.execute_task(task.task_id, active_executor)
    await wait_for_status(manager, task.task_id, TaskStatus.COMPLETED)

    completed = manager.get_task(task.task_id)
    assert completed is not None
    assert completed.status == TaskStatus.COMPLETED
    assert completed.last_progress_at is not None
    await manager.stop()


@pytest.mark.asyncio
async def test_progress_steps_are_completed_and_marked_failed(tmp_path):
    manager = TaskManager(
        str(tmp_path / "api_tasks.json"),
        max_concurrent_tasks=1,
        resume_interrupted_tasks=False,
    )
    await manager.start()

    async def successful_executor():
        manager.update_progress(
            successful.task_id,
            35,
            100,
            "正在执行阶段二",
            steps=[
                {"id": "prepare", "label": "准备", "status": "completed"},
                {"id": "run", "label": "执行", "status": "active"},
                {"id": "save", "label": "保存", "status": "pending"},
            ],
        )
        return {"ok": True}

    successful = manager.create_task(TaskType.VIDEO_GENERATION)
    await manager.execute_task(successful.task_id, successful_executor)
    await wait_for_status(manager, successful.task_id, TaskStatus.COMPLETED)
    completed = manager.get_task(successful.task_id)
    assert completed is not None
    assert [step.status for step in completed.progress.steps] == [
        "completed",
        "completed",
        "completed",
    ]

    async def failing_executor():
        manager.update_progress(
            failing.task_id,
            20,
            100,
            "正在等待模型响应",
            steps=[
                {"id": "model", "label": "模型调用", "status": "active"},
                {"id": "save", "label": "保存", "status": "pending"},
            ],
        )
        raise RuntimeError("provider unavailable")

    failing = manager.create_task(TaskType.VIDEO_GENERATION)
    await manager.execute_task(failing.task_id, failing_executor)
    await wait_for_status(manager, failing.task_id, TaskStatus.FAILED)
    failed = manager.get_task(failing.task_id)
    assert failed is not None
    assert [step.status for step in failed.progress.steps] == ["failed", "pending"]
    await manager.stop()


@pytest.mark.asyncio
async def test_user_cancel_is_not_reclassified_by_watchdog(tmp_path):
    manager = TaskManager(
        str(tmp_path / "api_tasks.json"),
        max_concurrent_tasks=1,
        resume_interrupted_tasks=False,
        stall_timeout=0.03,
        watchdog_interval=0.01,
    )
    await manager.start()
    task = manager.create_task(TaskType.VIDEO_GENERATION)
    await manager.execute_task(task.task_id, asyncio.Event().wait)
    await wait_for_status(manager, task.task_id, TaskStatus.RUNNING)

    assert manager.cancel_task(task.task_id) is True
    await asyncio.sleep(0.06)
    assert manager.get_task(task.task_id).status == TaskStatus.CANCELLED
    await manager.stop()


@pytest.mark.asyncio
async def test_manager_stop_keeps_running_task_recoverable(tmp_path):
    manager = TaskManager(
        str(tmp_path / "api_tasks.json"),
        max_concurrent_tasks=1,
        resume_interrupted_tasks=False,
        stall_timeout=0.03,
        watchdog_interval=0.01,
    )

    async def cancellation_resistant_executor():
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError as exc:
            raise RuntimeError("late shutdown error") from exc

    await manager.start()
    task = manager.create_task(TaskType.VIDEO_GENERATION)
    await manager.execute_task(task.task_id, cancellation_resistant_executor)
    await wait_for_status(manager, task.task_id, TaskStatus.RUNNING)

    await manager.stop()
    assert manager.get_task(task.task_id).status == TaskStatus.RUNNING
