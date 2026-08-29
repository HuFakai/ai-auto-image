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
TTS (Text-to-Speech) endpoints
"""

from fastapi import APIRouter, HTTPException
from loguru import logger

from api.dependencies import PixelleVideoDep
from api.schemas.tts import TTSSynthesizeRequest, TTSSynthesizeResponse
from pixelle_video.tts_voices import EDGE_TTS_VOICES
from pixelle_video.utils.tts_util import get_audio_duration

router = APIRouter(prefix="/tts", tags=["Basic Services"])


@router.get("/voices")
async def list_tts_voices():
    """List the curated Edge TTS voices exposed by Pixelle."""
    return {"success": True, "voices": EDGE_TTS_VOICES}


@router.post("/synthesize", response_model=TTSSynthesizeResponse)
async def tts_synthesize(
    request: TTSSynthesizeRequest,
    pixelle_video: PixelleVideoDep
):
    """
    Text-to-Speech synthesis endpoint
    
    Convert text to speech audio using Edge TTS.
    
    - **text**: Text to synthesize
    - **voice_id**: Edge TTS voice ID (optional)
    - **speed**: Speech speed multiplier (optional)
    
    Returns path to generated audio file and duration.
    
    Examples:
    ```json
    {
        "text": "Hello, welcome to Pixelle-Video!",
        "voice_id": "en-US-JennyNeural",
        "speed": 1.0
    }
    ```
    """
    try:
        logger.info(f"TTS synthesis request: {request.text[:50]}...")
        
        # Build TTS parameters
        tts_params = {"text": request.text}
        
        if request.voice_id:
            tts_params["voice"] = request.voice_id
        if request.speed is not None:
            tts_params["speed"] = request.speed
        
        # Call TTS service
        audio_path = await pixelle_video.tts(**tts_params)
        
        # Get audio duration
        duration = get_audio_duration(audio_path)
        
        return TTSSynthesizeResponse(
            audio_path=audio_path,
            duration=duration
        )
        
    except Exception as e:
        logger.error(f"TTS synthesis error: {e}")
        raise HTTPException(status_code=500, detail=str(e))
