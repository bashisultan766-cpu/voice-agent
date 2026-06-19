from openai import AsyncOpenAI

from .base import TTSProvider
from ..config import get_settings

# Valid OpenAI TTS voices
OPENAI_VOICES = {"alloy", "echo", "fable", "onyx", "nova", "shimmer"}


class OpenAITTSProvider(TTSProvider):
    def __init__(self, client: AsyncOpenAI) -> None:
        self._client = client

    async def synthesize(self, text: str, voice_id: str = "nova", speed: float = 1.0) -> bytes:
        settings = get_settings()

        # Normalize voice_id — fall back to configured default
        voice = voice_id if voice_id in OPENAI_VOICES else settings.OPENAI_TTS_VOICE

        response = await self._client.audio.speech.create(
            model=settings.OPENAI_TTS_MODEL,
            voice=voice,  # type: ignore[arg-type]
            input=text[:4096],
            response_format="mp3",
            speed=max(0.25, min(4.0, speed)),
        )
        return response.content
