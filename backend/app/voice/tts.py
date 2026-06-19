from __future__ import annotations
import asyncio
import os
import uuid
from pathlib import Path
from typing import Optional
import openai
from app.config import settings

AUDIO_DIR = Path("static/audio")
AUDIO_DIR.mkdir(parents=True, exist_ok=True)


async def synthesize_speech(
    text: str,
    voice: str = "alloy",
    model: str = "tts-1",
    api_key: Optional[str] = None,
) -> Optional[str]:
    """
    Generate TTS audio via OpenAI TTS.
    Returns a relative path to the saved audio file, or None on failure.
    Uses tts-1 (optimized for speed) for voice calls.
    """
    if not text.strip():
        return None

    key = api_key or settings.OPENAI_API_KEY
    if not key:
        return None

    client = openai.AsyncOpenAI(api_key=key)
    filename = f"{uuid.uuid4().hex}.mp3"
    filepath = AUDIO_DIR / filename

    for attempt in range(2):
        try:
            response = await client.audio.speech.create(
                model=model,
                voice=voice,
                input=text[:4096],
                response_format="mp3",
            )
            content = await asyncio.to_thread(response.read)
            filepath.write_bytes(content)
            return f"static/audio/{filename}"
        except Exception:
            if attempt == 1:
                return None
            await asyncio.sleep(0.2)

    return None


def truncate_for_voice(text: str, max_chars: int = 250) -> str:
    """Trim text to stay under max_chars for voice delivery; end on sentence boundary."""
    if len(text) <= max_chars:
        return text
    truncated = text[:max_chars]
    for sep in [".", "!", "?"]:
        idx = truncated.rfind(sep)
        if idx > max_chars * 0.6:
            return truncated[: idx + 1]
    return truncated.rsplit(" ", 1)[0] + "..."
