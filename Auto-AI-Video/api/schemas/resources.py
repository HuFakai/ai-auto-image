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
Resource discovery API schemas
"""

from typing import Any, List

from pydantic import BaseModel, Field


class MediaModelInfo(BaseModel):
    """Configured media model information."""
    name: str = Field(..., description="Model name")
    display_name: str = Field(..., description="Display name with provider")
    source: str = Field(..., description="Source type (api)")
    path: str = Field(..., description="API model key")
    key: str = Field(..., description="API model key (api/provider/model)")


class MediaModelListResponse(BaseModel):
    """Configured media model list response."""
    success: bool = True
    message: str = "Success"
    models: List[MediaModelInfo] = Field(..., description="List of available media models")


class TemplateInfo(BaseModel):
    """Template information"""
    name: str = Field(..., description="Template filename")
    display_name: str = Field(..., description="Display name")
    size: str = Field(..., description="Size (e.g., 1080x1920)")
    width: int = Field(..., description="Width in pixels")
    height: int = Field(..., description="Height in pixels")
    orientation: str = Field(..., description="Orientation (portrait/landscape/square)")
    path: str = Field(..., description="Full path to template file")
    key: str = Field(..., description="Template key (size/name)")


class TemplateListResponse(BaseModel):
    """Template list response"""
    success: bool = True
    message: str = "Success"
    templates: List[TemplateInfo] = Field(..., description="List of available templates")


class HyperFramesTemplateInfo(BaseModel):
    """Published immutable HyperFrames template version."""

    template_id: str
    version: int
    display_name: str
    category: str
    native_template: str
    fingerprint: str
    preview_html: str = Field(
        ...,
        description="Self-contained inert HTML generated from the actual native template",
    )
    preview_width: int = Field(..., ge=1, description="Preview canvas width")
    preview_height: int = Field(..., ge=1, description="Preview canvas height")
    variables: dict[str, dict[str, Any]]


class HyperFramesTemplateListResponse(BaseModel):
    success: bool = True
    message: str = "Success"
    templates: list[HyperFramesTemplateInfo]


class HyperFramesTemplatePreviewRequest(BaseModel):
    variables: dict[str, Any] = Field(default_factory=dict)


class HyperFramesTemplatePreviewResponse(BaseModel):
    success: bool = True
    message: str = "Success"
    template_id: str
    version: int
    fingerprint: str
    variables: dict[str, Any]
    preview_html: str
    preview_width: int = Field(..., ge=1)
    preview_height: int = Field(..., ge=1)


class WhiteboardTemplateInfo(BaseModel):
    """Independent whiteboard visual recipe and renderer profile."""

    template_id: str
    version: int
    display_name: str
    description: str
    recommended_for: list[str]
    preview_url: str
    render_profile: dict[str, Any]
    fingerprint: str


class WhiteboardTemplateListResponse(BaseModel):
    success: bool = True
    message: str = "Success"
    templates: list[WhiteboardTemplateInfo]


class BGMInfo(BaseModel):
    """BGM information"""
    name: str = Field(..., description="BGM filename")
    path: str = Field(..., description="Full path to BGM file")
    source: str = Field(..., description="Source (default or custom)")


class BGMListResponse(BaseModel):
    """BGM list response"""
    success: bool = True
    message: str = "Success"
    bgm_files: List[BGMInfo] = Field(..., description="List of available BGM files")
