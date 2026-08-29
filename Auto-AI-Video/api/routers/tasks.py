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

"""
Task management endpoints

Endpoints for managing async tasks (checking status, canceling, etc.)
"""

from typing import List, Optional

from fastapi import APIRouter, HTTPException, Query
from loguru import logger

from api.tasks import Task, TaskStatus, task_manager

router = APIRouter(prefix="/tasks", tags=["Tasks"])


@router.get("", response_model=List[Task])
async def list_tasks(
    status: Optional[TaskStatus] = Query(None, description="Filter by status"),
    limit: int = Query(100, ge=1, le=1000, description="Maximum number of tasks")
):
    """
    List tasks
    
    Retrieve list of tasks with optional filtering.
    
    - **status**: Optional filter by status (pending/running/completed/failed/cancelled)
    - **limit**: Maximum number of tasks to return (default 100)
    
    Returns list of tasks sorted by creation time (newest first).
    """
    try:
        tasks = task_manager.list_tasks(status=status, limit=limit)
        return tasks
        
    except Exception as e:
        logger.error(f"List tasks error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/metrics")
async def get_task_metrics():
    """Return durable throughput metrics."""

    return {"tasks": task_manager.metrics()}


@router.get("/snapshots")
async def list_task_snapshots(
    limit: int = Query(1000, ge=1, le=1000, description="Maximum number of task snapshots")
):
    """Return lightweight task state for dashboards and completion monitors."""
    return [
        {
            "task_id": task.task_id,
            "task_type": task.task_type,
            "title": (task.request_params or {}).get("title"),
            "status": task.status,
            "progress": task.progress,
            "error": task.error,
            "created_at": task.created_at,
            "started_at": task.started_at,
            "last_progress_at": task.last_progress_at,
            "completed_at": task.completed_at,
            "attempts": task.attempts,
            "queue_wait_ms": task.queue_wait_ms,
            "run_duration_ms": task.run_duration_ms,
        }
        for task in task_manager.list_tasks(limit=limit)
    ]


@router.get("/{task_id}", response_model=Task)
async def get_task(task_id: str):
    """
    Get task details
    
    Retrieve detailed information about a specific task.
    
    - **task_id**: Task ID
    
    Returns task details including status, progress, and result (if completed).
    """
    try:
        task = task_manager.get_task(task_id)
        
        if not task:
            raise HTTPException(status_code=404, detail=f"Task {task_id} not found")
        
        return task
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Get task error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.delete("/{task_id}")
async def cancel_task(task_id: str):
    """
    Cancel task
    
    Cancel a running or pending task.
    
    - **task_id**: Task ID
    
    Returns success status.
    """
    try:
        success = task_manager.cancel_task(task_id)
        
        if not success:
            raise HTTPException(status_code=404, detail=f"Task {task_id} not found")
        
        return {
            "success": True,
            "message": f"Task {task_id} cancelled successfully"
        }
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Cancel task error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/{task_id}/retry", response_model=Task)
async def retry_task(task_id: str):
    """Retry a failed durable task without changing its task ID."""
    try:
        success = await task_manager.retry_task(task_id)
        if not success:
            raise HTTPException(
                status_code=409,
                detail=f"Task {task_id} is missing or is not failed",
            )
        return task_manager.get_task(task_id)
    except HTTPException:
        raise
    except Exception as exc:
        logger.error(f"Retry task error: {exc}")
        raise HTTPException(status_code=500, detail=str(exc))
