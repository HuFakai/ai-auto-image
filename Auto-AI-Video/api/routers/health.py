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
Health check and system info endpoints
"""

from fastapi import APIRouter
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from api.config import api_config
from pixelle_video.production.ops import inspect_operational_health

router = APIRouter(tags=["Health"])


class HealthResponse(BaseModel):
    """Health check response"""
    status: str = "healthy"
    version: str = "0.1.0"
    service: str = "Pixelle-Video API"


class CapabilitiesResponse(BaseModel):
    """Capabilities response"""
    success: bool = True
    capabilities: dict


@router.get("/health", response_model=HealthResponse)
async def health_check():
    """
    Health check endpoint
    
    Returns service status and version information.
    """
    return HealthResponse()


@router.get("/ready")
def readiness_check():
    """Check the durable ledger, disk, media tools, configuration, and backup age."""
    result = inspect_operational_health(api_config.production_config_path)
    return JSONResponse(result, status_code=200 if result["ready"] else 503)


@router.get("/version", response_model=HealthResponse)
async def get_version():
    """
    Get API version
    
    Returns version information.
    """
    return HealthResponse()
