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
Task data models
"""

from datetime import datetime
from enum import Enum
from typing import Any, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field


class TaskStatus(str, Enum):
    """Task status"""

    PENDING = "pending"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"


class TaskType(str, Enum):
    """Task type"""

    VIDEO_GENERATION = "video_generation"
    SCENE_REGENERATION = "scene_regeneration"
    QUALITY_REPAIR = "quality_repair"
    REVISION_RENDER = "revision_render"
    STORYBOARD_PLANNING = "storyboard_planning"
    STORYBOARD_REDIRECTION = "storyboard_redirection"
    SOURCE_INGESTION = "source_ingestion"
    CUSTOM_SCRIPT_RECOMMENDATION = "custom_script_recommendation"


class TaskProgressStep(BaseModel):
    """One visible stage in a durable background task."""

    id: str = Field(min_length=1, max_length=80)
    label: str = Field(min_length=1, max_length=200)
    status: Literal["pending", "active", "completed", "failed"] = "pending"


class TaskProgress(BaseModel):
    """Task progress information"""

    current: int = 0
    total: int = 0
    percentage: float = 0.0
    message: str = ""
    steps: list[TaskProgressStep] = Field(default_factory=list)


class Task(BaseModel):
    """Task model"""

    model_config = ConfigDict()

    task_id: str
    task_type: TaskType
    idempotency_key: Optional[str] = None
    status: TaskStatus = TaskStatus.PENDING

    # Progress tracking
    progress: Optional[TaskProgress] = None

    # Result
    result: Optional[Any] = None
    error: Optional[str] = None

    # Metadata
    created_at: datetime = Field(default_factory=datetime.now)
    started_at: Optional[datetime] = None
    first_started_at: Optional[datetime] = None
    last_attempt_started_at: Optional[datetime] = None
    last_progress_at: Optional[datetime] = None
    completed_at: Optional[datetime] = None
    attempts: int = 0
    recoveries: int = 0
    queue_wait_ms: Optional[float] = None
    run_duration_ms: Optional[float] = None
    attempt_durations_ms: list[float] = Field(default_factory=list)

    # Request parameters (for reference)
    request_params: Optional[dict] = None
