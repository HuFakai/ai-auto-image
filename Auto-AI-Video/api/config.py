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

"""API Configuration."""

import os
from typing import Optional

from pydantic import BaseModel


class APIConfig(BaseModel):
    """API configuration"""
    
    # Server settings
    host: str = "0.0.0.0"
    port: int = int(os.getenv("PIXELLE_API_PORT", "18123"))
    reload: bool = False
    
    # CORS settings
    cors_enabled: bool = True
    cors_origins: list[str] = ["*"]
    
    # Task settings
    # 0 means unlimited. Long-running production is controlled by each
    # channel's max_in_flight rather than a hidden process-wide ceiling.
    max_concurrent_tasks: int = int(os.getenv("PIXELLE_MAX_CONCURRENT_TASKS", "0"))
    task_cleanup_interval: int = 3600  # Clean completed tasks every hour
    task_retention_time: int = 86400   # Keep task results for 24 hours
    task_store_path: str = os.getenv("PIXELLE_TASK_STORE_PATH", "data/api_tasks.json")
    resume_interrupted_tasks: bool = True
    # Grok media polling can legitimately run for up to 30 minutes. Allow a
    # five-minute margin while still bounding providers that never return.
    task_stall_timeout: float = float(os.getenv("PIXELLE_TASK_STALL_TIMEOUT", "2100"))
    task_watchdog_interval: float = float(
        os.getenv("PIXELLE_TASK_WATCHDOG_INTERVAL", "30")
    )

    # Continuous production settings
    production_config_path: str = os.getenv(
        "PIXELLE_PRODUCTION_CONFIG_PATH", "production/runner.yaml"
    )
    
    # File upload settings
    max_upload_size: int = 100 * 1024 * 1024  # 100MB
    
    # API settings
    api_prefix: str = "/api"
    docs_url: Optional[str] = "/docs"
    redoc_url: Optional[str] = "/redoc"
    openapi_url: Optional[str] = "/openapi.json"


# Global config instance
api_config = APIConfig()
