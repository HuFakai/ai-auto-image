"""Readiness proxies for isolated rendering services."""

import httpx
from fastapi import APIRouter, HTTPException

from pixelle_video.services.hyperframes_renderer import (
    HyperFramesRendererAdapter,
    HyperFramesRendererError,
)

router = APIRouter(prefix="/renderers", tags=["Renderers"])


@router.get("/hyperframes/ready")
async def hyperframes_renderer_readiness():
    """Check F1 readiness without exposing the renderer filesystem API."""
    try:
        return await HyperFramesRendererAdapter(request_timeout=5).ready()
    except (HyperFramesRendererError, httpx.HTTPError) as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
