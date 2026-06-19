from abc import ABC, abstractmethod


class TTSProvider(ABC):
    """Abstract TTS provider. Concrete implementations: OpenAITTS, ElevenLabsTTS."""

    @abstractmethod
    async def synthesize(self, text: str, voice_id: str, speed: float = 1.0) -> bytes:
        """Synthesize text to MP3 audio bytes."""
        ...
