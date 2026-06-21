from __future__ import annotations
import asyncio
import hashlib
import uuid
from pathlib import Path
from typing import Dict, List, Optional
import openai
from app.config import settings
from app.voice.latency import tts_timeout_secs

AUDIO_DIR = Path("static/audio")
AUDIO_DIR.mkdir(parents=True, exist_ok=True)

# In-process cache for common voice phrases (greetings, acks, fallbacks).
_AUDIO_CACHE: Dict[str, str] = {}


def _cache_key(text: str, voice: str, model: str) -> str:
    digest = hashlib.sha256(f"{voice}:{model}:{text.strip()}".encode()).hexdigest()[:16]
    return digest


def get_cached_audio_path(text: str, voice: str = "alloy", model: str = "tts-1") -> Optional[str]:
    return _AUDIO_CACHE.get(_cache_key(text, voice, model))


def register_cached_audio(text: str, path: str, voice: str = "alloy", model: str = "tts-1") -> None:
    _AUDIO_CACHE[_cache_key(text, voice, model)] = path


async def synthesize_speech(
    text: str,
    voice: str = "alloy",
    model: str = "tts-1",
    api_key: Optional[str] = None,
    *,
    use_cache: bool = True,
) -> Optional[str]:
    """
    Generate TTS audio via OpenAI TTS.
    Returns a relative path to the saved audio file, or None on failure.
    Uses tts-1 (optimized for speed) for voice calls.
    """
    if not text.strip():
        return None

    if use_cache:
        cached = get_cached_audio_path(text, voice, model)
        if cached and Path(cached).exists():
            return cached

    key = api_key or settings.OPENAI_API_KEY
    if not key:
        return None

    client = openai.AsyncOpenAI(api_key=key)
    filename = f"{uuid.uuid4().hex}.mp3"
    filepath = AUDIO_DIR / filename

    for attempt in range(2):
        try:
            async with asyncio.timeout(tts_timeout_secs()):
                response = await client.audio.speech.create(
                    model=model,
                    voice=voice,
                    input=text[:4096],
                    response_format="mp3",
                )
                content = await asyncio.to_thread(response.read)
                filepath.write_bytes(content)
                rel_path = f"static/audio/{filename}"
                if use_cache:
                    register_cached_audio(text, rel_path, voice, model)
                return rel_path
        except Exception:
            if attempt == 1:
                return None
            await asyncio.sleep(0.1)

    return None


async def synthesize_speech_chunks(
    chunks: List[str],
    voice: str = "alloy",
    model: str = "tts-1",
    api_key: Optional[str] = None,
) -> List[Optional[str]]:
    """Synthesize short TTS chunks in parallel for lower perceived latency."""
    tasks = [
        synthesize_speech(chunk, voice=voice, model=model, api_key=api_key)
        for chunk in chunks
        if chunk.strip()
    ]
    if not tasks:
        return []
    results = await asyncio.gather(*tasks, return_exceptions=True)
    paths: List[Optional[str]] = []
    for item in results:
        paths.append(item if isinstance(item, str) else None)
    return paths


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


def split_for_voice_chunks(text: str, max_chunk_chars: int = 120) -> List[str]:
    """Split long responses into short TTS-friendly chunks."""
    trimmed = truncate_for_voice(text)
    if len(trimmed) <= max_chunk_chars:
        return [trimmed]

    parts: List[str] = []
    remaining = trimmed
    while remaining:
        if len(remaining) <= max_chunk_chars:
            parts.append(remaining.strip())
            break
        window = remaining[:max_chunk_chars]
        split_at = max(window.rfind("."), window.rfind("!"), window.rfind("?"))
        if split_at < max_chunk_chars * 0.4:
            split_at = window.rfind(" ")
        if split_at <= 0:
            split_at = max_chunk_chars
        chunk = remaining[: split_at + 1].strip()
        if chunk:
            parts.append(chunk)
        remaining = remaining[split_at + 1 :].strip()
    return parts or [trimmed]
