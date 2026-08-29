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
Resource discovery endpoints

Provides endpoints to discover available workflows, templates, and BGM.
"""

from pathlib import Path

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse
from loguru import logger

from api.dependencies import PixelleVideoDep
from api.schemas.resources import (
    BGMInfo,
    BGMListResponse,
    HyperFramesTemplateInfo,
    HyperFramesTemplateListResponse,
    HyperFramesTemplatePreviewRequest,
    HyperFramesTemplatePreviewResponse,
    MediaModelInfo,
    MediaModelListResponse,
    TemplateInfo,
    TemplateListResponse,
    WhiteboardTemplateInfo,
    WhiteboardTemplateListResponse,
)
from pixelle_video.services.template_packs import TemplatePackRegistry
from pixelle_video.utils.os_util import get_data_path, get_root_path
from pixelle_video.utils.template_util import get_all_templates_with_info
from pixelle_video.whiteboard.templates import WhiteboardTemplateRegistry

router = APIRouter(prefix="/resources", tags=["Resources"])


@router.get("/models/media", response_model=MediaModelListResponse)
async def list_media_models(pixelle_video: PixelleVideoDep):
    """List image and video models from enabled channels."""
    try:
        models = [MediaModelInfo(**item) for item in pixelle_video.media.list_workflows()]
        return MediaModelListResponse(models=models)
    except Exception as e:
        logger.error(f"List media models error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/templates", response_model=TemplateListResponse)
async def list_templates():
    """
    List available video templates
    
    Returns list of HTML templates grouped by size (portrait, landscape, square).
    Templates are merged from both default (templates/) and custom (data/templates/) directories.
    
    Example response:
    ```json
    {
        "templates": [
            {
                "name": "default.html",
                "display_name": "default.html",
                "size": "1080x1920",
                "width": 1080,
                "height": 1920,
                "orientation": "portrait",
                "path": "templates/1080x1920/default.html",
                "key": "1080x1920/default.html"
            }
        ]
    }
    ```
    """
    try:
        # Get all templates with info
        all_templates = get_all_templates_with_info()
        
        # Convert to API response format
        templates = []
        for t in all_templates:
            templates.append(TemplateInfo(
                name=t.display_info.name,
                display_name=t.display_info.name,
                size=t.display_info.size,
                width=t.display_info.width,
                height=t.display_info.height,
                orientation=t.display_info.orientation,
                path=t.template_path,
                key=t.template_path
            ))
        
        return TemplateListResponse(templates=templates)
        
    except Exception as e:
        logger.error(f"List templates error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get(
    "/hyperframes/templates",
    response_model=HyperFramesTemplateListResponse,
)
async def list_hyperframes_templates():
    """List published packs, safe variables, and sandbox-ready actual previews."""
    try:
        return HyperFramesTemplateListResponse(
            templates=[
                HyperFramesTemplateInfo(**pack.public_metadata())
                for pack in TemplatePackRegistry().list()
            ]
        )
    except Exception as e:
        logger.error(f"List HyperFrames templates error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post(
    "/hyperframes/templates/{template_id}/versions/{version}/preview",
    response_model=HyperFramesTemplatePreviewResponse,
)
async def preview_hyperframes_template(
    template_id: str,
    version: int,
    request: HyperFramesTemplatePreviewRequest,
):
    """Render a debounced Studio preview with validated template variables."""
    try:
        pack = TemplatePackRegistry().load(template_id, version)
        return HyperFramesTemplatePreviewResponse(**pack.render_preview(request.variables))
    except (FileNotFoundError, ValueError) as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except Exception as exc:
        logger.error(f"Preview HyperFrames template error: {exc}")
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@router.get(
    "/whiteboard/templates",
    response_model=WhiteboardTemplateListResponse,
)
async def list_whiteboard_templates():
    """List the standalone cs-board visual recipes used only by whiteboard mode."""
    try:
        return WhiteboardTemplateListResponse(
            templates=[
                WhiteboardTemplateInfo(**template.public_metadata())
                for template in WhiteboardTemplateRegistry().list()
            ]
        )
    except Exception as exc:
        logger.error(f"List whiteboard templates error: {exc}")
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@router.get("/whiteboard/templates/{template_id}/versions/{version}/preview")
async def get_whiteboard_template_preview(template_id: str, version: int):
    """Serve an immutable local preview asset without exposing arbitrary paths."""
    try:
        template = WhiteboardTemplateRegistry().load(template_id, version)
        media_types = {
            ".png": "image/png",
            ".jpg": "image/jpeg",
            ".jpeg": "image/jpeg",
            ".webp": "image/webp",
        }
        return FileResponse(
            template.preview_path,
            media_type=media_types.get(
                template.preview_path.suffix.lower(), "application/octet-stream"
            ),
        )
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.get("/bgm", response_model=BGMListResponse)
async def list_bgm():
    """
    List available background music files
    
    Returns list of BGM files merged from both default (bgm/) and custom (data/bgm/) directories.
    Custom files take precedence over default files with the same name.
    
    Supported formats: mp3, wav, flac, m4a, aac, ogg
    
    Example response:
    ```json
    {
        "bgm_files": [
            {
                "name": "default.mp3",
                "path": "bgm/default.mp3",
                "source": "default"
            },
            {
                "name": "happy.mp3",
                "path": "data/bgm/happy.mp3",
                "source": "custom"
            }
        ]
    }
    ```
    """
    try:
        # Supported audio extensions
        audio_extensions = ('.mp3', '.wav', '.flac', '.m4a', '.aac', '.ogg')
        
        # Collect BGM files from both locations
        bgm_files_dict = {}  # {filename: {"path": str, "source": str}}
        
        # Scan default bgm/ directory
        default_bgm_dir = Path(get_root_path("bgm"))
        if default_bgm_dir.exists() and default_bgm_dir.is_dir():
            for item in default_bgm_dir.iterdir():
                if item.is_file() and item.suffix.lower() in audio_extensions:
                    bgm_files_dict[item.name] = {
                        "path": f"bgm/{item.name}",
                        "source": "default"
                    }
        
        # Scan custom data/bgm/ directory (overrides default)
        custom_bgm_dir = Path(get_data_path("bgm"))
        if custom_bgm_dir.exists() and custom_bgm_dir.is_dir():
            for item in custom_bgm_dir.iterdir():
                if item.is_file() and item.suffix.lower() in audio_extensions:
                    bgm_files_dict[item.name] = {
                        "path": f"data/bgm/{item.name}",
                        "source": "custom"
                    }
        
        # Convert to response format
        bgm_files = [
            BGMInfo(
                name=name,
                path=info["path"],
                source=info["source"]
            )
            for name, info in sorted(bgm_files_dict.items())
        ]
        
        return BGMListResponse(bgm_files=bgm_files)
        
    except Exception as e:
        logger.error(f"List BGM error: {e}")
        raise HTTPException(status_code=500, detail=str(e))
