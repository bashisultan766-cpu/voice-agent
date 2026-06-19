import hashlib
import logging
from pathlib import Path

import aiofiles

from .base import TTSProvider
from ..config import get_settings

logger = logging.getLogger(__name__)


class TTSCache:
    """
    File-system TTS cache for Phase 1.
    - Key: sha256(text + voice_id + speed)
    - Storage: local ./audio_cache/{key}.mp3
    - URL: {BASE_URL}/audio/{key}.mp3  (served by FastAPI StaticFiles)
    Phase 2: swap storage for Cloudflare R2 / S3 and cache key in Redis.
    """

    def __init__(self, provider: TTSProvider) -> None:
        self._provider = provider
        settings = get_settings()
        self._cache_dir = Path(settings.AUDIO_CACHE_DIR)
        self._base_url = settings.BASE_URL
        self._cache_dir.mkdir(parents=True, exist_ok=True)

    def _key(self, text: str, voice_id: str, speed: float) -> str:
        payload = f"{text}|{voice_id}|{speed:.2f}"
        return hashlib.sha256(payload.encode()).hexdigest()

    async def get_or_synthesize(
        self,
        text: str,
        voice_id: str,
        speed: float = 1.0,
    ) -> str:
        """
        Return a public URL to the audio file.
        Synthesizes and caches on cache miss.
        """
        key = self._key(text, voice_id, speed)
        path = self._cache_dir / f"{key}.mp3"

        if not path.exists():
            logger.debug("TTS cache miss — synthesizing %d chars", len(text))
            audio_bytes = await self._provider.synthesize(text, voice_id, speed)
            async with aiofiles.open(path, "wb") as f:
                await f.write(audio_bytes)
        else:
            logger.debug("TTS cache hit — %s", key[:12])

        return f"{self._base_url}/audio/{key}.mp3"
